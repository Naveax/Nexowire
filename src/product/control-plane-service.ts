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
  type ProductPlan,
  type ProductPlanId,
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
  private readonly infrastructure: () => InfrastructureSnapshot;

  constructor(
    private readonly store: ControlPlaneStore,
    options: ControlPlaneServiceOptions = {},
  ) {
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

  async dashboard(
    identity: ControlPlaneIdentity,
  ): Promise<UserDashboardSnapshot> {
    const account = await this.requireAccount(identity.accountId);
    const plan = resolvePlan(account);
    const period = monthPeriod(this.now());
    const usage = await this.store.getUsagePeriod(
      account.quotaSubjectId,
      period.key,
    );
    const devices = await this.store.listDevices(account.id);

    return {
      accountId: account.id,
      displayName: account.displayName,
      planId: account.planId,
      billingMode: plan.billingMode,
      usage: {
        usedCredits: usage?.usedCredits ?? 0,
        monthlyCredits: plan.monthlyCredits,
        prepaidCredits:
          plan.billingMode === 'prepaid-metered'
            ? usage?.prepaidCredits ?? 0
            : null,
        periodStart: period.start,
        periodEnd: period.end,
      },
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        online: device.online,
        platform: device.platform,
        lastSeenAt: device.lastSeenAt,
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
        paid: accounts.filter(
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
    const plan = resolvePlan(account);
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
    const plan = resolvePlan(account);
    const devices = await this.store.listDevices(account.id);
    if (
      plan.maxDevices !== null &&
      devices.length >= plan.maxDevices
    ) {
      throw new Error('DEVICE_LIMIT_REACHED');
    }

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
      online: false,
      lastSeenAt: null,
      createdAt: existingDevice?.createdAt ?? now,
      updatedAt: now,
    };

    await this.store.putDevice(device);
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

  async setAccountEntitlement(
    identity: ControlPlaneIdentity,
    input: {
      accountId: string;
      planId: ProductPlanId;
      customPlan?: CustomPlanInput | null;
    },
  ): Promise<{
    accountId: string;
    planId: ProductPlanId;
    billingMode:
      | 'free'
      | 'subscription'
      | 'prepaid-metered';
    quotaSubjectId: string;
  }> {
    if (identity.role !== 'service') {
      const actor = await this.requireAccount(
        identity.accountId,
      );
      if (
        identity.role !== 'admin' ||
        actor.admin !== true
      ) {
        throw new Error('ADMIN_REQUIRED');
      }
    }

    const account = await this.requireAccount(
      input.accountId,
    );

    let targetPlan: ProductPlan;
    let normalizedCustomPlan: CustomPlanInput | null;

    if (input.planId === 'custom') {
      if (!input.customPlan) {
        throw new Error('CUSTOM_PLAN_REQUIRED');
      }
      targetPlan = createCustomPlan(input.customPlan);
      normalizedCustomPlan = {
        billingMode: input.customPlan.billingMode,
        ...(input.customPlan.monthlyCredits !== undefined
          ? {
              monthlyCredits:
                input.customPlan.monthlyCredits,
            }
          : {}),
        ...(input.customPlan.maxDevices !== undefined
          ? {
              maxDevices: input.customPlan.maxDevices,
            }
          : {}),
        ...(input.customPlan.maxConcurrentTasks !== undefined
          ? {
              maxConcurrentTasks:
                input.customPlan.maxConcurrentTasks,
            }
          : {}),
        ...(input.customPlan.features !== undefined
          ? {
              features: [
                ...input.customPlan.features,
              ],
            }
          : {}),
      };
    } else {
      if (input.customPlan !== undefined &&
          input.customPlan !== null) {
        throw new Error('CUSTOM_PLAN_NOT_ALLOWED');
      }
      const builtIn = PRODUCT_PLANS[input.planId];
      if (!builtIn) {
        throw new Error('INVALID_PLAN_ID');
      }
      targetPlan = builtIn;
      normalizedCustomPlan = null;
    }

    const targetKind =
      targetPlan.billingMode === 'free'
        ? 'free-cluster'
        : targetPlan.billingMode ===
            'prepaid-metered'
          ? 'prepaid'
          : 'subscription';

    const currentSubject =
      await this.store.getQuotaSubject(
        account.quotaSubjectId,
      );
    if (!currentSubject) {
      throw new Error('QUOTA_SUBJECT_NOT_FOUND');
    }

    const now = this.now().toISOString();
    let quotaSubjectId = account.quotaSubjectId;

    if (currentSubject.kind !== targetKind) {
      if (targetKind === 'free-cluster') {
        const devices =
          await this.store.listDevices(account.id);
        const freeSubjectIds = new Set<string>();

        for (const device of devices) {
          if (!device.deviceAnchorHash) continue;
          const anchor =
            await this.store.getDeviceAnchor(
              device.deviceAnchorHash,
            );
          if (!anchor) continue;
          const subject =
            await this.store.getQuotaSubject(
              anchor.quotaSubjectId,
            );
          if (subject?.kind === 'free-cluster') {
            freeSubjectIds.add(subject.id);
          }
        }

        const existingFreeSubjectId =
          freeSubjectIds.values().next()
            .value as string | undefined;

        if (existingFreeSubjectId) {
          quotaSubjectId =
            existingFreeSubjectId;
          for (const subjectId of freeSubjectIds) {
            if (subjectId === quotaSubjectId) continue;
            await this.store.mergeFreeQuotaSubjects(
              subjectId,
              quotaSubjectId,
            );
          }
        } else {
          quotaSubjectId =
            'quota_' + randomUUID();
          await this.store.putQuotaSubject({
            id: quotaSubjectId,
            kind: 'free-cluster',
            createdAt: now,
            updatedAt: now,
          });
        }

        for (const device of devices) {
          if (!device.deviceAnchorHash) continue;
          const existingAnchor =
            await this.store.getDeviceAnchor(
              device.deviceAnchorHash,
            );
          await this.store.putDeviceAnchor({
            anchorHash:
              device.deviceAnchorHash,
            quotaSubjectId,
            createdAt:
              existingAnchor?.createdAt ??
              now,
            lastSeenAt: now,
          });
        }
      } else {
        quotaSubjectId =
          'quota_' + randomUUID();
        await this.store.putQuotaSubject({
          id: quotaSubjectId,
          kind: targetKind,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    const updated: ProductAccountRecord = {
      ...account,
      quotaSubjectId,
      planId: input.planId,
      customPlan: normalizedCustomPlan,
      updatedAt: now,
    };
    await this.store.putAccount(updated);

    return {
      accountId: updated.id,
      planId: updated.planId,
      billingMode: targetPlan.billingMode,
      quotaSubjectId: updated.quotaSubjectId,
    };
  }

  async chargeUsage(input: {
    accountId: string;
    eventId: string;
    toolName: string;
    baseCredits?: number;
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
    const plan = resolvePlan(account);
    const quote = quoteToolUsage(
      plan,
      input.toolName,
      input.baseCredits ?? 1,
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
