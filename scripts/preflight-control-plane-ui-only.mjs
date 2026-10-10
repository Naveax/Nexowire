#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const PINNED_BACKEND_COMMIT =
  '6f5863363b4ad25bbecceca5b5c78e8ffdd8fffd';
export const UI_ONLY_FILES = Object.freeze(['web/app.js','web/styles.css']);
const LIVE_ORIGIN='https://nexowire-control-plane.nexowire-naveax.workers.dev';
const LIMIT_BYTES=256 * 1024;
const sha256=(buf)=>createHash('sha256').update(buf).digest('hex');
const endpoints=(s)=>new Set(
  [...s.matchAll(/\/api\/v1\/[A-Za-z0-9/_-]+/g)].map(m=>m[0]),
);

/**
 * Compares live and candidate **bytes**, never a PowerShell-decoded text
 * response (which can replace Turkish UTF-8 with U+FFFD).
 * Does NOT prove current Worker code identity; the release process must
 * independently validate the active production backend version before deploy.
 */
export function verifyUiOnlyRelease({backendSha,modifiedPaths,baseline,candidate,live}) {
  if (backendSha !== PINNED_BACKEND_COMMIT) {
    throw new Error('UI_ONLY_BACKEND_COMMIT_CHANGED');
  }
  const modified=[...modifiedPaths].sort();
  const allowlisted=[...UI_ONLY_FILES].sort();
  if (JSON.stringify(modified)!==JSON.stringify(allowlisted)) {
    throw new Error('UI_ONLY_UNEXPECTED_FILE_CHANGES');
  }
  const manifest={backendCommit:backendSha,files:[],newApiRoutes:[]};
  for (const file of UI_ONLY_FILES) {
    const old=baseline[file],next=candidate[file];
    if (!Buffer.isBuffer(old)||!Buffer.isBuffer(next) ||
        old.length===0 || next.length===0 || next.length>LIMIT_BYTES ||
        old.equals(next)) {
      throw new Error('UI_ONLY_ASSET_MISSING_UNCHANGED_OR_UNBOUNDED:'+file);
    }
    if (live!==null) {
      const served=live[file];
      if (!Buffer.isBuffer(served) || !served.equals(old)) {
        throw new Error('UI_ONLY_LIVE_BASELINE_MISMATCH:'+file);
      }
    }
    manifest.files.push({
      path:file,oldSha256:sha256(old),newSha256:sha256(next),
      oldBytes:old.length,newBytes:next.length,
    });
  }
  const oldApi=endpoints(baseline['web/app.js'].toString('utf8'));
  const newApi=endpoints(candidate['web/app.js'].toString('utf8'));
  const added=[...newApi].filter(x=>!oldApi.has(x));
  if (added.length) throw new Error('UI_ONLY_NEW_BACKEND_API_REQUIRED');
  if (!candidate['web/app.js'].includes(Buffer.from('bridge-quick-toggle')) ||
      !candidate['web/app.js'].includes(Buffer.from('bridge-toggle')) ||
      !candidate['web/styles.css'].includes(Buffer.from('.bridge-toggle'))) {
    throw new Error('UI_ONLY_REQUIRED_ON_OFF_CONTROLS_MISSING');
  }
  return Object.freeze({
    ...manifest,liveBaselineMatched:live!==null,
    productionDeploymentPerformed:false,
    backendRuntimeAttested:false,
  });
}

function git(repo,...args) {
  return execFileSync('git',['-C',repo,...args],{
    maxBuffer:1024*1024,windowsHide:true,
  });
}

async function fetchAsset(name) {
  const url=new URL('/'+name,LIVE_ORIGIN);
  url.searchParams.set('ui-preflight',String(Date.now()));
  const response=await fetch(url,{
    redirect:'error',
    headers:{'Cache-Control':'no-cache'},
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok || !response.body ||
      Number(response.headers.get('content-length')||0)>LIMIT_BYTES) {
    throw new Error('UI_ONLY_LIVE_ASSET_UNAVAILABLE:'+name);
  }
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length===0 || bytes.length>LIMIT_BYTES) {
    throw new Error('UI_ONLY_LIVE_ASSET_UNBOUNDED:'+name);
  }
  return bytes;
}

export async function main(args=process.argv.slice(2)) {
  const offline=args.includes('--offline');
  const positional=args.filter(x=>x!=='--offline');
  if(positional.length!==1 || positional[0].startsWith('-')) {
    throw new Error('Usage: preflight-control-plane-ui-only.mjs <pinned-backend-worktree> [--offline]');
  }
  const repo=resolve(positional[0]);
  const backendSha=git(repo,'rev-parse','HEAD').toString('utf8').trim();
  const modifiedPaths=git(repo,'diff','--name-only','HEAD','--')
    .toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  const original={},candidate={},live=offline?null:{};
  for(const path of UI_ONLY_FILES) {
    original[path]=git(repo,'show','HEAD:'+path);
    candidate[path]=readFileSync(resolve(repo,path));
    if(live!==null) live[path]=await fetchAsset(path.slice(4));
  }
  const manifest=verifyUiOnlyRelease({
    backendSha,modifiedPaths,baseline:original,candidate,live,
  });
  const diffCheck=git(repo,'diff','--check').toString('utf8');
  assert.equal(diffCheck,'');
  process.stdout.write(JSON.stringify(manifest,null,2)+'\n');
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch((err)=>{
    process.stderr.write(String(err instanceof Error?err.message:err)+'\n');
    process.exitCode=1;
  });
}
