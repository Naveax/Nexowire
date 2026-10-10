import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import type { BridgeGuardianAtomicReserve } from './bridge-guardian-policy.js';
import {
  guardianLocalRequestDigest,
  type GuardianCurrentLocalPairing,
} from './guardian-local-replay-ledger.js';
import { verifyWindowsPrivateAcl } from '../security/windows-programdata-acl.js';
import { verifyBridgeGuardianSourceAcl } from './bridge-guardian-task-preflight.js';

const STATE_DIR = 'C:\\ProgramData\\Nexowire\\bridge-guardian\\state';
const DATABASE_PATH = STATE_DIR + '\\replay.sqlite';
const APP_ID = 0x4e585747;
const DIGEST = /^[a-f0-9]{64}$/;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REVISION = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Provisioning DDL for isolated tests and future OWNER-APPROVED installer.
 * This module intentionally does NOT create production directories/databases.
 */
export const GUARDIAN_REPLAY_SCHEMA = `
PRAGMA application_id = ${APP_ID};
CREATE TABLE guardian_used_requests (
  request_digest TEXT PRIMARY KEY NOT NULL
    CHECK(length(request_digest) = 64),
  device_digest TEXT NOT NULL CHECK(length(device_digest) = 64),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
  revision_digest TEXT NOT NULL CHECK(length(revision_digest) = 64)
) STRICT;
`;

export interface GuardianSqliteCurrentOwnerApproval extends GuardianCurrentLocalPairing {
  /** Exact command UUID independently approved by the current owner. */
  readonly approvedRequestId:string;
  /** Approval must be tied to the latest owner's desired-mode revision. */
  readonly approvedPreferenceRevision:string;
}

export interface GuardianSqliteReplayOptions {
  readonly database: DatabaseSync;
  /** Trusted local approval/pairing observer, NOT an HTTP request body. */
  readonly readCurrentPairing: () => Promise<GuardianSqliteCurrentOwnerApproval>;
  /**
   * Production wrapper checks separately protected Guardian root, database
   * and descendants each time. Tests may provide an isolated fixture checker.
   */
  readonly assertProtected: () => void;
}

// Hash only after validation; never persist raw pairing/owner details.
const sha=(value:string):string =>
  createHash('sha256').update(value).digest('hex');

/**
 * SQLite rollback journal + synchronous EXTRA. The reserve marker is committed
 * before any caller may attempt OS action, and conflict is atomically rejected.
 * Still cannot guarantee storage hardware obeys flush or atomically combine
 * cloud-side revocation with local commit.
 */
export function createGuardianSqliteReplayReserve(
  opts: GuardianSqliteReplayOptions,
): BridgeGuardianAtomicReserve {
  const db = opts.database;
  opts.assertProtected();
  // Node 22 defaults to ZERO busy timeout. Install contention handling before
  // even the first metadata read; another process can already hold a write lock.
  db.exec('PRAGMA busy_timeout = 12000');
  const app = db.prepare('PRAGMA application_id').get() as
    { application_id?:number } | undefined;
  if (app?.application_id !== APP_ID) {
    throw new Error('GUARDIAN_SQLITE_LEDGER_UNPROVISIONED');
  }
  // A STRICT table by itself does not prove a UNIQUE request key. A
  // fabricated table, trigger or view can silently defeat replay protection.
  // Require the EXACT reviewed DDL and no extra application schema objects.
  const normalizeDdl=(sql:string):string=>
    sql.replace(/\s+/g,' ').replace(/;\s*$/,'').trim();
  const expectedDdl=normalizeDdl(GUARDIAN_REPLAY_SCHEMA.slice(
    GUARDIAN_REPLAY_SCHEMA.indexOf('CREATE TABLE'),
  ));
  const objects=db.prepare(
    "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{type:string;name:string;sql:string|null}>;
  const tempObjects=db.prepare(
    'SELECT name FROM sqlite_temp_master',
  ).all() as Array<{name:string}>;
  if(objects.length!==1 || objects[0]?.type!=='table' ||
      objects[0]?.name!=='guardian_used_requests' ||
      typeof objects[0].sql!=='string' ||
      normalizeDdl(objects[0].sql)!==expectedDdl ||
      tempObjects.length!==0) {
    throw new Error('GUARDIAN_SQLITE_LEDGER_SCHEMA_UNTRUSTED');
  }
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = EXTRA;
    PRAGMA trusted_schema = OFF;
    PRAGMA foreign_keys = ON;
  `);
  const mode = db.prepare('PRAGMA journal_mode').get() as {journal_mode:string};
  const sync = db.prepare('PRAGMA synchronous').get() as {synchronous:number};
  if (mode.journal_mode.toLowerCase() !== 'delete' || sync.synchronous !== 3) {
    throw new Error('GUARDIAN_SQLITE_DURABILITY_MODE_UNVERIFIED');
  }

  return async(requestId,deviceId,credentialBinding,preferenceRevision)=>{
    const digest = guardianLocalRequestDigest(requestId);
    if (!DEVICE_ID.test(deviceId) || !DIGEST.test(credentialBinding) ||
        !REVISION.test(preferenceRevision)) {
      throw new Error('GUARDIAN_SQLITE_RESERVATION_IDENTITY_INVALID');
    }
    const verifyPair = async()=>{
      const facts=await opts.readCurrentPairing();
      if (!facts.currentlyAuthorized ||
          facts.deviceId !== deviceId ||
          facts.credentialBinding !== credentialBinding ||
          facts.preferenceRevision !== preferenceRevision ||
          facts.approvedRequestId !== requestId ||
          facts.approvedPreferenceRevision !== preferenceRevision) {
        throw new Error('GUARDIAN_SQLITE_CURRENT_PAIRING_REVOKED');
      }
    };

    opts.assertProtected();
    await verifyPair();
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = db.prepare(
        `INSERT OR IGNORE INTO guardian_used_requests
         (request_digest,device_digest,binding_digest,revision_digest)
         VALUES (?, ?, ?, ?)`,
      ).run(
        digest,sha(deviceId),sha(credentialBinding),sha(preferenceRevision),
      );
      // Even on conflict end the transaction without creating a new marker.
      db.exec('COMMIT');
      if (result.changes !== 1) return false;
    } catch {
      if (db.isTransaction) {
        try { db.exec('ROLLBACK'); } catch { /* Never mask failure. */ }
      }
      throw new Error('GUARDIAN_SQLITE_LOCAL_COMMIT_UNVERIFIED');
    }
    // A revocation racing the local commit consumes but cannot authorize.
    opts.assertProtected();
    await verifyPair();
    return true;
  };
}

/**
 * Production-only source wiring. Requires a separately installed protected
 * state database; never auto-creates it or enables Windows tasks.
 */
export function createProtectedGuardianSqliteReplayReserve(
  readCurrentPairing:()=>Promise<GuardianSqliteCurrentOwnerApproval>,
):{ reserve:BridgeGuardianAtomicReserve;close:()=>void } {
  if (process.platform !== 'win32') {
    throw new Error('GUARDIAN_SQLITE_PROTECTED_WINDOWS_ONLY');
  }
  const paths=['C:\\ProgramData\\Nexowire',
    'C:\\ProgramData\\Nexowire\\bridge-guardian',STATE_DIR,DATABASE_PATH];
  const assertProtected=()=>{
    verifyBridgeGuardianSourceAcl();
    paths.forEach((node,index)=>{
      const stat=lstatSync(node);
      if (stat.isSymbolicLink() ||
          (index===paths.length-1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('GUARDIAN_SQLITE_PROTECTED_SOURCE_INVALID');
      }
      verifyWindowsPrivateAcl(node);
    });
  };
  assertProtected();
  if (path.win32.normalize(DATABASE_PATH).toLowerCase() !==
      DATABASE_PATH.toLowerCase()) {
    throw new Error('GUARDIAN_SQLITE_DATABASE_NONCANONICAL');
  }
  const database=new DatabaseSync(DATABASE_PATH);
  try {
    const reserve=createGuardianSqliteReplayReserve({
      database,readCurrentPairing,assertProtected,
    });
    return {reserve,close:()=>database.close()};
  } catch(err) {
    database.close();
    throw err;
  }
}
