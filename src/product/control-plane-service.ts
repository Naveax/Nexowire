import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type {
  AdminOverviewSnapshot,
  UserDashboardSnapshot,
} from './control-plane-contract.js';
import type {
  ControlPlaneStore,
  ExternalIdentityRecord,
  ProductAccountRecord,
  ProductDeviceRecord,
} from './control-plane-store.js';
import {
  consumePairingChallenge,
  createPairingChallenge,
} from './pairing.js';
import {
  PRODUCT_PLANS,
  createCustomPlan,
  planHasFeature,
  type CustomPlanInput,
  type ProductFeature,
  type ProductPlan,
} from './plans.js';
import { quoteToolUsage } from './usage-policy.js';

export interface ControlPlaneIdentity {
  accountId: string;
  role: 'user' | 'admin' | 'service';
}

export interface InfrastructureSnapshot {
  freeCapacityPercent: number | null;
  prepaidCapacityCredits: number;
}

export interface AuthenticatedDeviceIdentity {
  deviceId: string;
  ownerAccountId: string;
  deviceName: string;
  platform: string;
}

export interface ControlPlaneServiceOptions {
  now?: () => Date;
  infrastructure?: () => InfrastructureSnapshot;
  /** Keep all users on the free plan and reject paid configuration. */
  freeOnly?: boolean;
  /** Verified GitHub numeric subject eligible for unmetered Free usage. */
  ownerGithubId?: string;
}

function boundedId(name: string, input: string): string {
  const value = input.trim();
  if (
    !value ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error(
      name + ' must be a bounded identifier.',
    );
  }
  return value;
}

function boundedText(name: string, input: string, max: number): string {
  const value = input.trim();
  if (!value || value.length > max) {
    throw new Error(name + ' must be 1-' + max + ' characters.');
  }
  return value;
}

function normalizeDeviceAnchorHash(input: string): string {
  const value = input.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(
      'deviceAnchorHash must be a 64-character lowercase hex SHA-256 digest.',
    );
  }
  return value;
}

function resolvePlan(account: ProductAccountRecord): ProductPlan {
  if (account.planId === 'custom') {
    if (!account.customPlan) {
      throw new Error('Custom account is missing custom plan configuration.');
    }
    return createCustomPlan(account.customPlan);
  }
  return PRODUCT_PLANS[account.planId];
}

function monthPeriod(now: Date): {
  key: string;
  start: string;
  end: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return {
    key:
      String(year).padStart(4, '0') +
      '-' +
      String(month + 1).padStart(2, '0'),
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verifyDeviceCredential(
  record: ProductDeviceRecord,
  credential: string,
): boolean {
  const expected = Buffer.from(record.credentialHash, 'hex');
  const actual = Buffer.from(secretHash(credential), 'hex');
  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

export class ControlPlaneService {
  private readonly now: () => Date;
  /** A ROOT lease is a short-lived policy signal, never an OS elevation grant. */
  private static readonly ROOT_LEASE_MS = 15 * 60 * 1000;
  private readonly infrastructure: () => InfrastructureSnapshot;
  private readonly freeOnly: boolean;
  private readonly ownerGithubId: string | null;

  constructor(
    private readonly store: ControlPlaneStore,
    options: ControlPlaneServiceOptions = {},
  ) {
    this.freeOnly = options.freeOnly ?? false;
    const ownerId = options.ownerGithubId?.trim() ?? '';
    // An absent or malformed configuration never grants an exemption.
    this.ownerGithubId = /^[1-9][0-9]{0,19}$/.test(ownerId)
      ? ownerId : null;
    this.now = options.now ?? (() => new Date());
    this.infrastructure =
      options.infrastructure ??
      (() => ({
        freeCapacityPercent: null,
        prepaidCapacityCredits: 0,
      }));
  }

  async ensureAccount(input: {
    id: string;
    displayName?: string | null;
    admin?: boolean;
  }): Promise<ProductAccountRecord> {
    const id = boundedId('accountId', input.id);
    const existing = await this.store.getAccount(id);
    if (existing) return existing;

    const now = this.now().toISOString();
    const quotaSubjectId = 'quota_' + randomUUID();
    await this.store.putQuotaSubject({
      id: quotaSubjectId,
      kind: 'free-cluster',
      createdAt: now,
      updatedAt: now,
    });

    const record: ProductAccountRecord = {
      id,
      quotaSubjectId,
      displayName:
        input.displayName === undefined ||
        input.displayName === null
          ? null
          : boundedText('displayName', input.displayName, 128),
      planId: 'free',
      customPlan: null,
      admin: input.admin === true,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.putAccount(record);
    return record;
  }

  async loginExternalIdentity(input: {
    provider: string;
    subject: string;
    displayName?: string | null;
    email?: string | null;
    admin?: boolean;
  }): Promise<{
    account: ProductAccountRecord;
    identity: ExternalIdentityRecord;
  }> {
    const provider = boundedId('provider', input.provider);
    const subject = boundedId('subject', input.subject);
    const now = this.now().toISOString();
    const existing = await this.store.getExternalIdentity(
      provider,
      subject,
    );

    if (existing) {
      const account = await this.requireAccount(existing.accountId);
      const refreshed: ExternalIdentityRecord = {
        ...existing,
        displayName:
          input.displayName === undefined ||
          input.displayName === null
            ? existing.displayName
            : boundedText('displayName', input.displayName, 128),
        email:
          input.email === undefined || input.email === null
            ? existing.email
            : boundedText('email', input.email, 320),
        lastLoginAt: now,
      };
      await this.store.putExternalIdentity(refreshed);
      return { account, identity: refreshed };
    }

    const account = await this.ensureAccount({
      id: 'acct_' + randomUUID(),
      displayName: input.displayName ?? null,
      admin: input.admin === true,
    });
    const identity: ExternalIdentityRecord = {
      provider,
      subject,
      accountId: account.id,
      displayName: input.displayName ?? null,
      email: input.email ?? null,
      createdAt: now,
      lastLoginAt: now,
    };
    await this.store.putExternalIdentity(identity);
    return { account, identity };
  }

  private async effectivePlan(account: ProductAccountRecord): Promise<ProductPlan> {
    if (!this.freeOnly) return resolvePlan(account);
    if (this.ownerGithubId === null) return PRODUCT_PLANS.free;

    // Only a GitHub OAuth identity verified by the sign-in callback qualifies.
    // Never infer ownership from a display name, role or account.admin flag.
    const ownerIdentity = await this.store.getExternalIdentity(
      'github', this.ownerGithubId,
    );
    if (ownerIdentity?.accountId !== account.id) return PRODUCT_PLANS.free;

    // Null is an unlimited *tool credit* ceiling; all normal security,
    // premium-feature and replay checks remain unchanged.
    return { ...PRODUCT_PLANS.free, monthlyCredits: null };
  }

  async dashboard(
    identity: ControlPlaneIdentity,
  ): Promise<UserDashboardSnapshot> {
    const account = await this.requireAccount(identity.accountId);
    const plan = await this.effectivePlan(account);
    const period = monthPeriod(this.now());
    const [usage, devices, prepaidCredits] =
      await Promise.all([
        this.store.getUsagePeriod(
          account.quotaSubjectId,
          period.key,
        ),
        this.store.listDevices(account.id),
        plan.billingMode === 'prepaid-metered'
          ? this.store.getPrepaidCreditsBalance(
              account.quotaSubjectId,
            )
          : Promise.resolve(0),
      ]);

    return {
      accountId: account.id,
      displayName: account.displayName,
      planId: this.freeOnly ? 'free' : account.planId,
      billingMode: plan.billingMode,
      usage: {
        usedCredits: usage?.usedCredits ?? 0,
        monthlyCredits: plan.monthlyCredits,
        prepaidCredits:
          plan.billingMode === 'prepaid-metered'
            ? prepaidCredits
            : null,
        periodStart: period.start,
        periodEnd: period.end,
      },
      devices: await Promise.all(devices.map(async (device) => {
        const lease = await this.store.getRootModeLease(device.id);
        const active =
          device.accessMode === 'full' &&
          device.online &&
          device.privilegeMode === 'broker' &&
          device.adminBridgeReady === true &&
          lease?.ownerAccountId === account.id &&
          Date.parse(lease.expiresAt) > this.now().getTime();
        return {
        id: device.id,
        name: device.name,
        online: device.online,
        platform: device.platform,
        accessMode: device.accessMode,
        rootMode: {
          active: Boolean(active),
          expiresAt: active && lease ? lease.expiresAt : null,
        },
        agentVersion: device.agentVersion,
        privilegeMode: device.privilegeMode,
        adminBridgeReady: device.adminBridgeReady,
        lastSeenAt: device.lastSeenAt,
        };
      })),
      stability: {
        successRate: null,
        medianLatencyMs: null,
        reconnects30d: null,
      },
      privateControlsIncluded:
        planHasFeature(plan, 'private-pointer') &&
        planHasFeature(plan, 'private-keyboard') &&
        planHasFeature(plan, 'private-screen'),
    };
  }

  async adminOverview(
    identity: ControlPlaneIdentity,
  ): Promise<AdminOverviewSnapshot> {
    const actor = await this.requireAccount(identity.accountId);
    if (identity.role !== 'admin' || !actor.admin) {
      throw new Error('ADMIN_REQUIRED');
    }

    const [accounts, devices, usage] = await Promise.all([
      this.store.listAccounts(),
      this.store.listDevices(),
      this.store.getUsageAggregate(this.now()),
    ]);
    const infra = this.infrastructure();
    const now = this.now().getTime();
    const activeAccountIds = new Set(
      devices
        .filter(
          (device) =>
            device.lastSeenAt !== null &&
            Date.parse(device.lastSeenAt) >= now - 86_400_000,
        )
        .map((device) => device.ownerAccountId),
    );

    return {
      generatedAt: this.now().toISOString(),
      users: {
        total: accounts.length,
        active24h: activeAccountIds.size,
        paid: this.freeOnly ? 0 : accounts.filter(
          (account) => account.planId !== 'free',
        ).length,
      },
      devices: {
        total: devices.length,
        online: devices.filter((device) => device.online).length,
      },
      usage: {
        calls24h: usage.calls24h,
        calls30d: usage.calls30d,
        successRate: null,
      },
      infrastructure: {
        ownerPaidSpendAllowed: false,
        providerAutoUpgradeAllowed: false,
        freeCapacityPercent: infra.freeCapacityPercent,
        prepaidCapacityCredits: infra.prepaidCapacityCredits,
      },
    };
  }

  async configureCustomPrepaidPlan(
    identity: ControlPlaneIdentity,
    targetAccountIdInput: string,
    input: {
      maxDevices?: number | null;
      maxConcurrentTasks?: number | null;
      features?: readonly ProductFeature[];
    },
  ): Promise<ProductAccountRecord> {
    if (this.freeOnly) throw new Error('BILLING_PAUSED');
    const actor = await this.requireAccount(identity.accountId);
    if (identity.role !== 'admin' || !actor.admin) {
      throw new Error('ADMIN_REQUIRED');
    }

    const target = await this.requireAccount(
      targetAccountIdInput,
    );
    let normalized: ProductPlan;
    try {
      normalized = createCustomPlan({
        billingMode: 'prepaid-metered',
        monthlyCredits: null,
        maxDevices: input.maxDevices,
        maxConcurrentTasks: input.maxConcurrentTasks,
        features: input.features,
      });
    } catch {
      throw new Error('INVALID_CUSTOM_PLAN');
    }

    const now = this.now().toISOString();
    const currentQuota =
      await this.store.getQuotaSubject(
        target.quotaSubjectId,
      );
    let quotaSubjectId = target.quotaSubjectId;
    if (!currentQuota || currentQuota.kind !== 'prepaid') {
      quotaSubjectId = 'quota_' + randomUUID();
      await this.store.putQuotaSubject({
        id: quotaSubjectId,
        kind: 'prepaid',
        createdAt: now,
        updatedAt: now,
      });
    }

    const customPlan: CustomPlanInput = {
      billingMode: 'prepaid-metered',
      monthlyCredits: null,
      maxDevices: normalized.maxDevices,
      maxConcurrentTasks:
        normalized.maxConcurrentTasks,
      features: [...normalized.features],
    };
    const updated: ProductAccountRecord = {
      ...target,
      quotaSubjectId,
      planId: 'custom',
      customPlan,
      updatedAt: now,
    };
    await this.store.putAccount(updated);
    return updated;
  }

  async beginPairing(
    identity: ControlPlaneIdentity,
    deviceName: string,
    deviceIdInput?: string,
  ): Promise<{
    pairingId: string;
    token: string;
    expiresAt: string;
  }> {
    const account = await this.requireAccount(identity.accountId);
    const plan = this.freeOnly ? PRODUCT_PLANS.free : resolvePlan(account);
    const requestedDeviceId = deviceIdInput?.trim()
      ? boundedId('deviceId', deviceIdInput)
      : undefined;
    const existingDevice = requestedDeviceId
      ? await this.store.getDevice(requestedDeviceId)
      : null;
    const devices = await this.store.listDevices(account.id);
    const countsAsNew =
      !existingDevice ||
      existingDevice.ownerAccountId !== account.id;

    if (
      plan.maxDevices !== null &&
      countsAsNew &&
      devices.length >= plan.maxDevices
    ) {
      throw new Error('DEVICE_LIMIT_REACHED');
    }

    const challenge = createPairingChallenge(
      account.id,
      deviceName,
      {
        now: this.now(),
        ...(requestedDeviceId
          ? { requestedDeviceId }
          : {}),
      },
    );
    await this.store.putPairing(challenge.record);
    return {
      pairingId: challenge.record.id,
      token: challenge.token,
      expiresAt: challenge.record.expiresAt,
    };
  }

  async consumePairing(input: {
    pairingId: string;
    token: string;
    platform: string;
    deviceAnchorHash: string;
  }): Promise<{
    device: ProductDeviceRecord;
    deviceCredential: string;
  }> {
    const pairingId = boundedId('pairingId', input.pairingId);
    const record = await this.store.getPairing(pairingId);
    if (!record) throw new Error('PAIRING_NOT_FOUND');

    const account = await this.requireAccount(record.ownerAccountId);
    const plan = this.freeOnly ? PRODUCT_PLANS.free : resolvePlan(account);

    const consumed = consumePairingChallenge(
      record,
      input.token,
      this.now(),
    );
    if (!consumed.ok) {
      throw new Error('PAIRING_' + consumed.reason.toUpperCase());
    }

    const deviceAnchorHash = normalizeDeviceAnchorHash(
      input.deviceAnchorHash,
    );
    const now = this.now().toISOString();
    let effectiveAccount = account;

    if (plan.billingMode === 'free') {
      const existingAnchor =
        await this.store.getDeviceAnchor(deviceAnchorHash);

      if (
        existingAnchor &&
        existingAnchor.quotaSubjectId !==
          account.quotaSubjectId
      ) {
        await this.store.mergeFreeQuotaSubjects(
          account.quotaSubjectId,
          existingAnchor.quotaSubjectId,
        );
        effectiveAccount = await this.requireAccount(account.id);
      }

      await this.store.putDeviceAnchor({
        anchorHash: deviceAnchorHash,
        quotaSubjectId:
          existingAnchor?.quotaSubjectId ??
          effectiveAccount.quotaSubjectId,
        createdAt: existingAnchor?.createdAt ?? now,
        lastSeenAt: now,
      });
    }

    const requestedDeviceId =
      record.requestedDeviceId ?? randomUUID();
    const existingDevice =
      await this.store.getDevice(requestedDeviceId);

    if (
      existingDevice &&
      existingDevice.ownerAccountId !== effectiveAccount.id &&
      !(
        plan.billingMode === 'free' &&
        existingDevice.deviceAnchorHash === deviceAnchorHash
      )
    ) {
      throw new Error('DEVICE_ALREADY_BOUND');
    }

    const effectiveDevices =
      await this.store.listDevices(effectiveAccount.id);
    const countsAsNew =
      !existingDevice ||
      existingDevice.ownerAccountId !== effectiveAccount.id;
    if (
      plan.maxDevices !== null &&
      countsAsNew &&
      effectiveDevices.length >= plan.maxDevices
    ) {
      throw new Error('DEVICE_LIMIT_REACHED');
    }

    const rawCredential =
      'nwx_dev_' + randomBytes(32).toString('base64url');
    const device: ProductDeviceRecord = {
      id: requestedDeviceId,
      ownerAccountId: effectiveAccount.id,
      deviceAnchorHash,
      name: record.requestedDeviceName,
      platform: boundedText('platform', input.platform, 64),
      credentialHash: secretHash(rawCredential),
      accessMode: existingDevice?.accessMode ?? 'safe',
      agentVersion: existingDevice?.agentVersion ?? null,
      privilegeMode: existingDevice?.privilegeMode ?? null,
      adminBridgeReady:
        existingDevice?.adminBridgeReady ?? null,
      online: false,
      lastSeenAt: null,
      createdAt: existingDevice?.createdAt ?? now,
      updatedAt: now,
    };

    await this.store.putDevice(device);
    // A newly paired credential never inherits an earlier ROOT lease.
    await this.store.putRootModeLease({
      deviceId: device.id,
      ownerAccountId: effectiveAccount.id,
      expiresAt: new Date(0).toISOString(),
      updatedAt: now,
    });
    await this.store.putPairing(consumed.record);

    return {
      device,
      deviceCredential: rawCredential,
    };
  }

  async authenticateDeviceCredential(
    credentialInput: string,
  ): Promise<AuthenticatedDeviceIdentity | null> {
    const credential = credentialInput.trim();
    if (
      !credential.startsWith('nwx_dev_') ||
      credential.length < 16 ||
      credential.length > 512 ||
      /[\r\n\0]/.test(credential)
    ) {
      return null;
    }

    const device =
      await this.store.getDeviceByCredentialHash(
        secretHash(credential),
      );
    if (!device) return null;

    return {
      deviceId: device.id,
      ownerAccountId: device.ownerAccountId,
      deviceName: device.name,
      platform: device.platform,
    };
  }

  async setDevicePresence(
    deviceIdInput: string,
    online: boolean,
    atInput: string,
    runtime: {
      agentVersion?: string;
      privilegeMode?: 'direct' | 'broker';
      adminBridgeReady?: boolean;
    } = {},
  ): Promise<boolean> {
    const deviceId = deviceIdInput.trim();
    const atMs = Date.parse(atInput);
    if (
      !deviceId ||
      deviceId.length > 128 ||
      /[\r\n\0]/.test(deviceId) ||
      !Number.isFinite(atMs)
    ) {
      return false;
    }

    const device = await this.store.getDevice(deviceId);
    if (!device) return false;

    const normalizedAt = new Date(atMs).toISOString();
    const previousAt = device.lastSeenAt
      ? Date.parse(device.lastSeenAt)
      : Number.NaN;
    if (
      Number.isFinite(previousAt) &&
      previousAt > atMs
    ) {
      return true;
    }

    const agentVersion =
      runtime.agentVersion === undefined
        ? device.agentVersion
        : boundedText(
            'agentVersion',
            runtime.agentVersion,
            64,
          );
    const privilegeMode =
      runtime.privilegeMode === undefined
        ? device.privilegeMode
        : runtime.privilegeMode;
    const adminBridgeReady =
      runtime.adminBridgeReady === undefined
        ? device.adminBridgeReady
        : runtime.adminBridgeReady;

    await this.store.putDevice({
      ...device,
      agentVersion,
      privilegeMode,
      adminBridgeReady,
      online,
      lastSeenAt: normalizedAt,
      updatedAt: normalizedAt,
    });
    return true;
  }

  async setDeviceAccessMode(
    identity: ControlPlaneIdentity,
    deviceIdInput: string,
    modeInput: string,
  ): Promise<{
    deviceId: string;
    accessMode: 'safe' | 'full';
    updatedAt: string;
  }> {
    const account = await this.requireAccount(identity.accountId);
    const deviceId = boundedId('deviceId', deviceIdInput);
    const mode = modeInput.trim().toLowerCase();
    if (mode !== 'safe' && mode !== 'full') {
      throw new Error('INVALID_ACCESS_MODE');
    }

    const device = await this.store.getDevice(deviceId);
    if (!device || device.ownerAccountId !== account.id) {
      throw new Error('DEVICE_NOT_FOUND');
    }

    const updatedAt = this.now().toISOString();
    await this.store.putDevice({
      ...device,
      accessMode: mode,
      updatedAt,
    });
    if (mode === 'safe') {
      await this.store.putRootModeLease({
        deviceId: device.id,
        ownerAccountId: account.id,
        expiresAt: new Date(0).toISOString(),
        updatedAt,
      });
    }
    return {
      deviceId: device.id,
      accessMode: mode,
      updatedAt,
    };
  }

  async setDeviceRootMode(
    identity: ControlPlaneIdentity,
    deviceIdInput: string,
    enabled: boolean,
  ): Promise<{
    deviceId: string;
    rootMode: { active: boolean; expiresAt: string | null };
  }> {
    if (identity.role === 'service') {
      throw new Error('ROOT_REQUIRES_OWNER_LOGIN');
    }
    const account = await this.requireAccount(identity.accountId);
    const deviceId = boundedId('deviceId', deviceIdInput);
    const device = await this.store.getDevice(deviceId);
    if (!device || device.ownerAccountId !== account.id) {
      throw new Error('DEVICE_NOT_FOUND');
    }
    if (enabled && (
      device.accessMode !== 'full' ||
      !device.online ||
      device.privilegeMode !== 'broker' ||
      device.adminBridgeReady !== true
    )) {
      throw new Error('ROOT_REQUIRES_FULL_ONLINE_BROKER');
    }
    const now = this.now();
    const expiresAt = enabled
      ? new Date(now.getTime() + ControlPlaneService.ROOT_LEASE_MS).toISOString()
      : new Date(0).toISOString();
    await this.store.putRootModeLease({
      deviceId,
      ownerAccountId: account.id,
      expiresAt,
      updatedAt: now.toISOString(),
    });
    return {
      deviceId,
      rootMode: { active: enabled, expiresAt: enabled ? expiresAt : null },
    };
  }

  async chargeUsage(input: {
    accountId: string;
    eventId: string;
    toolName: string;
    baseCredits?: number;
    specialSkill?: boolean;
  }): Promise<{
    status: 'charged' | 'duplicate' | 'denied';
    chargedCredits: number;
    remainingCredits: number | null;
    reason:
      | 'feature-not-in-plan'
      | 'quota-exhausted'
      | null;
  }> {
    const account = await this.requireAccount(input.accountId);
    const plan = await this.effectivePlan(account);
    const quote = quoteToolUsage(
      plan,
      input.toolName,
      input.baseCredits ?? 1,
      input.specialSkill === true,
    );
    if (!quote.allowed) {
      return {
        status: 'denied',
        chargedCredits: 0,
        remainingCredits: null,
        reason: 'feature-not-in-plan',
      };
    }

    const period = monthPeriod(this.now());
    const result = await this.store.chargeUsageAtomic({
      quotaSubjectId: account.quotaSubjectId,
      periodKey: period.key,
      periodStart: period.start,
      periodEnd: period.end,
      eventId: boundedId('eventId', input.eventId),
      credits: quote.credits,
      billingMode: plan.billingMode,
      monthlyCredits: plan.monthlyCredits,
      chargedAt: this.now().toISOString(),
    });

    if (result.status === 'quota-exhausted') {
      return {
        status: 'denied',
        chargedCredits: 0,
        remainingCredits:
          plan.billingMode === 'prepaid-metered'
            ? result.record.prepaidCredits
            : plan.monthlyCredits === null
              ? null
              : Math.max(
                  0,
                  plan.monthlyCredits -
                    result.record.usedCredits,
                ),
        reason: 'quota-exhausted',
      };
    }

    return {
      status: result.status,
      chargedCredits:
        result.status === 'charged' ? quote.credits : 0,
      remainingCredits:
        plan.billingMode === 'prepaid-metered'
          ? result.record.prepaidCredits
          : plan.monthlyCredits === null
            ? null
            : Math.max(
                0,
                plan.monthlyCredits -
                  result.record.usedCredits,
              ),
      reason: null,
    };
  }

  private async requireAccount(
    accountIdInput: string,
  ): Promise<ProductAccountRecord> {
    const accountId = boundedId('accountId', accountIdInput);
    const account = await this.store.getAccount(accountId);
    if (!account) throw new Error('ACCOUNT_NOT_FOUND');
    return account;
  }
}
