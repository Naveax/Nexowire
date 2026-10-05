import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises';
import {
  DEFAULT_HOSTED_CONTROL_PLANE_URL,
} from '../src/connect.js';
import {
  defaultLemonSqueezyProvisioningPaths,
  inferLemonSqueezyPrepaidCredits,
  listLemonSqueezyStores,
  listLemonSqueezyStoreVariants,
  recommendLemonSqueezyPlanVariants,
  type LemonSqueezyPrepaidPack,
  type LemonSqueezyStoreCandidate,
  type LemonSqueezyVariantCandidate,
} from '../src/product/lemon-squeezy-provisioning.js';
import {
  readProtectedSecretFile,
} from '../src/security/protected-secret-files.js';

function validateSecretInput(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 4096 ||
    /[\r\n\0]/.test(trimmed)
  ) {
    throw new Error(
      'Secret input must be one non-empty line up to 4096 characters.',
    );
  }
  return trimmed;
}

async function readHiddenSecret(
  prompt: string,
): Promise<string> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    !process.stdin.setRawMode
  ) {
    throw new Error(
      'GUIDED_SETUP_REQUIRES_INTERACTIVE_TTY',
    );
  }

  const stdin = process.stdin;
  const previousRaw = stdin.isRaw;
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(previousRaw ?? false);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Secret input cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          try {
            resolve(validateSecretInput(value));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (
          char === '\u007f' ||
          char === '\b'
        ) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdin.on('data', onData);
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function moneyLabel(
  candidate: LemonSqueezyVariantCandidate,
): string {
  if (candidate.price === null) {
    return 'price unknown';
  }
  return (
    (candidate.price / 100).toFixed(2) +
    ' (store currency)'
  );
}

function variantLabel(
  candidate: LemonSqueezyVariantCandidate,
): string {
  const cadence = candidate.isSubscription
    ? candidate.interval
      ? ' / ' +
        String(candidate.intervalCount ?? 1) +
        ' ' +
        candidate.interval
      : ' / subscription'
    : ' / one-time';
  return (
    candidate.productName +
    ' :: ' +
    candidate.name +
    ' [' +
    candidate.id +
    '] - ' +
    moneyLabel(candidate) +
    cadence
  );
}

function printChoices(
  title: string,
  candidates: readonly LemonSqueezyVariantCandidate[],
): void {
  process.stdout.write('\n' + title + '\n');
  for (
    let index = 0;
    index < candidates.length;
    index += 1
  ) {
    process.stdout.write(
      '  [' +
        String(index + 1) +
        '] ' +
        variantLabel(candidates[index]!) +
        '\n',
    );
  }
}

function parseChoice(
  raw: string,
  candidates: readonly LemonSqueezyVariantCandidate[],
  label: string,
): LemonSqueezyVariantCandidate {
  const index = Number(raw.trim());
  if (
    !Number.isInteger(index) ||
    index < 1 ||
    index > candidates.length
  ) {
    throw new Error(
      'Invalid ' + label + ' selection.',
    );
  }
  return candidates[index - 1]!;
}

async function chooseVariant(
  rl: ReadlineInterface,
  input: {
    label: 'Plus' | 'Pro';
    candidates: LemonSqueezyVariantCandidate[];
    recommendedId: string | null;
    excludedId?: string;
  },
): Promise<LemonSqueezyVariantCandidate> {
  const candidates = input.candidates.filter(
    (candidate) =>
      candidate.id !== input.excludedId,
  );
  if (candidates.length === 0) {
    throw new Error(
      'No eligible production subscription variant is available for ' +
        input.label +
        '.',
    );
  }

  const recommended =
    input.recommendedId === null
      ? undefined
      : candidates.find(
          (candidate) =>
            candidate.id === input.recommendedId,
        );
  if (recommended) {
    process.stdout.write(
      '\nAuto-selected ' +
        input.label +
        ': ' +
        variantLabel(recommended) +
        '\n',
    );
    return recommended;
  }

  printChoices(
    'Select the ' + input.label + ' subscription:',
    candidates,
  );
  while (true) {
    const raw = await rl.question(
      input.label + ' selection [1-' +
        String(candidates.length) +
        ']: ',
    );
    try {
      return parseChoice(
        raw,
        candidates,
        input.label,
      );
    } catch {
      process.stdout.write(
        'Please enter one valid number.\n',
      );
    }
  }
}

function parseMultiSelection(
  raw: string,
  candidates: readonly LemonSqueezyVariantCandidate[],
  automatic: readonly LemonSqueezyVariantCandidate[],
): LemonSqueezyVariantCandidate[] {
  const value = raw.trim().toLowerCase();
  if (!value || value === 'auto') {
    return [...automatic];
  }
  if (
    value === 'none' ||
    value === 'no' ||
    value === 'n' ||
    value === '0'
  ) {
    return [];
  }

  const indexes = value
    .split(',')
    .map((item) => Number(item.trim()));
  if (
    indexes.length === 0 ||
    indexes.some(
      (index) =>
        !Number.isInteger(index) ||
        index < 1 ||
        index > candidates.length,
    )
  ) {
    throw new Error(
      'Invalid prepaid selection.',
    );
  }

  const unique = [...new Set(indexes)];
  return unique.map(
    (index) => candidates[index - 1]!,
  );
}

async function choosePrepaidPacks(
  rl: ReadlineInterface,
  candidates: LemonSqueezyVariantCandidate[],
): Promise<LemonSqueezyPrepaidPack[]> {
  if (candidates.length === 0) {
    process.stdout.write(
      '\nNo eligible one-time variants were found; no prepaid packs will be configured.\n',
    );
    return [];
  }

  const automatic = candidates.filter(
    (candidate) =>
      inferLemonSqueezyPrepaidCredits(
        candidate,
      ) !== null,
  );
  process.stdout.write(
    '\nEligible one-time variants for Custom prepaid packs:\n',
  );
  for (
    let index = 0;
    index < candidates.length;
    index += 1
  ) {
    const candidate = candidates[index]!;
    const inferred =
      inferLemonSqueezyPrepaidCredits(
        candidate,
      );
    process.stdout.write(
      '  [' +
        String(index + 1) +
        '] ' +
        variantLabel(candidate) +
        (inferred === null
          ? ' - credits: unknown'
          : ' - credits: ' +
            inferred.toLocaleString('en-US') +
            ' (auto)') +
        '\n',
    );
  }

  let selected:
    | LemonSqueezyVariantCandidate[]
    | undefined;
  while (!selected) {
    const raw = await rl.question(
      'Prepaid packs [Enter=auto, none, or comma-separated numbers]: ',
    );
    try {
      selected = parseMultiSelection(
        raw,
        candidates,
        automatic,
      );
    } catch {
      process.stdout.write(
        'Use Enter, none, or numbers like 1,3.\n',
      );
    }
  }

  const packs: LemonSqueezyPrepaidPack[] = [];
  for (const candidate of selected) {
    const inferred =
      inferLemonSqueezyPrepaidCredits(
        candidate,
      );
    let credits = inferred;
    while (credits === null) {
      const raw = await rl.question(
        'Credits granted by "' +
          candidate.productName +
          ' :: ' +
          candidate.name +
          '": ',
      );
      const parsed = Number(
        raw.replace(/,/g, '').trim(),
      );
      if (
        Number.isSafeInteger(parsed) &&
        parsed > 0 &&
        parsed <= 1_000_000_000
      ) {
        credits = parsed;
      } else {
        process.stdout.write(
          'Enter a positive whole number up to 1,000,000,000.\n',
        );
      }
    }

    const label = (
      candidate.productName +
      ' - ' +
      candidate.name
    )
      .trim()
      .slice(0, 80);
    packs.push({
      variantId: candidate.id,
      credits,
      label,
    });
  }
  return packs;
}

function formatStore(
  store: LemonSqueezyStoreCandidate,
): string {
  return (
    store.name +
    ' [' +
    store.id +
    ']' +
    (store.currency
      ? ' - ' + store.currency
      : '') +
    (store.url ? ' - ' + store.url : '')
  );
}

async function chooseStore(
  rl: ReadlineInterface,
  stores: LemonSqueezyStoreCandidate[],
): Promise<LemonSqueezyStoreCandidate> {
  if (stores.length === 0) {
    throw new Error(
      'No Lemon Squeezy store is visible to this API key.',
    );
  }
  if (stores.length === 1) {
    process.stdout.write(
      '\nAuto-selected store: ' +
        formatStore(stores[0]!) +
        '\n',
    );
    return stores[0]!;
  }

  process.stdout.write(
    '\nSelect the production Lemon Squeezy store:\n',
  );
  for (
    let index = 0;
    index < stores.length;
    index += 1
  ) {
    process.stdout.write(
      '  [' +
        String(index + 1) +
        '] ' +
        formatStore(stores[index]!) +
        '\n',
    );
  }
  while (true) {
    const raw = await rl.question(
      'Store selection [1-' +
        String(stores.length) +
        ']: ',
    );
    const index = Number(raw.trim());
    if (
      Number.isInteger(index) &&
      index >= 1 &&
      index <= stores.length
    ) {
      return stores[index - 1]!;
    }
    process.stdout.write(
      'Please enter one valid number.\n',
    );
  }
}

async function runNodeScript(
  script: string,
  args: string[],
  stdinValue?: string,
): Promise<void> {
  const scriptPath = path.join(
    process.cwd(),
    'scripts',
    script,
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        scriptPath,
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: [
          stdinValue === undefined
            ? 'ignore'
            : 'pipe',
          'inherit',
          'inherit',
        ],
        windowsHide: false,
      },
    );
    child.once('error', reject);
    if (
      stdinValue !== undefined &&
      child.stdin
    ) {
      child.stdin.end(stdinValue + '\n');
    }
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          script +
            ' failed: ' +
            String(code ?? signal ?? 'unknown'),
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Guided production billing setup currently requires the Windows owner machine.',
    );
  }
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    throw new Error(
      'GUIDED_SETUP_REQUIRES_INTERACTIVE_TTY',
    );
  }

  process.stdout.write(
    [
      'Nexowire guided production billing setup',
      '',
      'This flow discovers stores and variants with read-only GET requests.',
      'It never puts the Lemon Squeezy API key in argv, env, logs, or plaintext config.',
      'After confirmation it reuses the protected provisioner, deploys the control plane,',
      'and runs read-only production acceptance. It does not create a checkout, charge,',
      'refund, or other live-money transaction.',
      '',
    ].join('\n'),
  );

  const paths =
    defaultLemonSqueezyProvisioningPaths();
  const hasApiKey = await exists(
    paths.apiKeyFile,
  );
  const apiKey = hasApiKey
    ? readProtectedSecretFile(
        paths.apiKeyFile,
        'billing-lemonsqueezy-api-key',
        'Lemon Squeezy API key',
      )
    : await readHiddenSecret(
        'Lemon Squeezy production API key: ',
      );

  const stores = await listLemonSqueezyStores({
    apiKey,
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const store = await chooseStore(rl, stores);
    const variants =
      await listLemonSqueezyStoreVariants({
        apiKey,
        storeId: store.id,
      });

    const subscriptions = variants.filter(
      (candidate) =>
        candidate.isSubscription &&
        candidate.eligibleForProduction,
    );
    if (subscriptions.length < 2) {
      throw new Error(
        'At least two eligible production subscription variants are required for Plus and Pro.',
      );
    }

    const recommended =
      recommendLemonSqueezyPlanVariants(
        variants,
      );
    const plus = await chooseVariant(rl, {
      label: 'Plus',
      candidates: subscriptions,
      recommendedId:
        recommended.plusVariantId,
    });
    const pro = await chooseVariant(rl, {
      label: 'Pro',
      candidates: subscriptions,
      recommendedId:
        recommended.proVariantId,
      excludedId: plus.id,
    });

    const oneTime = variants.filter(
      (candidate) =>
        !candidate.isSubscription &&
        candidate.eligibleForProduction,
    );
    const prepaidPacks =
      await choosePrepaidPacks(rl, oneTime);

    const webhookUrl =
      new URL(
        '/api/v1/billing/webhook/lemonsqueezy',
        DEFAULT_HOSTED_CONTROL_PLANE_URL,
      ).toString();

    process.stdout.write(
      [
        '',
        'Production configuration:',
        '  Store: ' + formatStore(store),
        '  Plus: ' + variantLabel(plus),
        '  Pro: ' + variantLabel(pro),
        '  Prepaid packs: ' +
          String(prepaidPacks.length),
        ...prepaidPacks.map(
          (pack) =>
            '    - ' +
            pack.label +
            ' [' +
            pack.variantId +
            '] -> ' +
            pack.credits.toLocaleString(
              'en-US',
            ) +
            ' credits',
        ),
        '  Webhook: ' + webhookUrl,
        '',
        'Next automatic steps: protected provider provisioning -> Cloudflare deploy -> read-only production acceptance.',
        'Live-money checkout/refund acceptance is intentionally NOT part of this command.',
        '',
      ].join('\n'),
    );

    const confirmation = (
      await rl.question(
        'Apply and deploy this production configuration? [Y/n]: ',
      )
    )
      .trim()
      .toLowerCase();
    if (
      confirmation === 'n' ||
      confirmation === 'no'
    ) {
      process.stdout.write(
        'Cancelled before any provider or deployment mutation.\n',
      );
      return;
    }

    const args = [
      '--apply',
      '--store-id',
      store.id,
      '--plus-variant-id',
      plus.id,
      '--pro-variant-id',
      pro.id,
      '--webhook-url',
      webhookUrl,
    ];
    for (const pack of prepaidPacks) {
      args.push(
        '--prepaid-pack',
        [
          pack.variantId,
          String(pack.credits),
          pack.label,
        ].join(':'),
      );
    }

    process.stdout.write(
      '\nApplying protected Lemon Squeezy provisioning...\n',
    );
    await runNodeScript(
      'provision-lemonsqueezy-production.ts',
      args,
      apiKey,
    );

    process.stdout.write(
      '\nDeploying and running paid-plan read-only production acceptance...\n',
    );
    await runNodeScript(
      'run-paid-plan-production-acceptance.ts',
      ['--deploy'],
    );

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          stage: 'guided-production-billing-setup',
          storeId: store.id,
          plusVariantId: plus.id,
          proVariantId: pro.id,
          prepaidPackCount:
            prepaidPacks.length,
          webhookUrl,
          providerProvisioned: true,
          productionDeploymentValidated: true,
          financialMutationPerformed: false,
          liveMoneyAcceptanceRemaining: true,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    'Nexowire guided billing setup error: ' +
      (error instanceof Error
        ? error.message
        : String(error)) +
      '\n',
  );
  process.exitCode = 1;
});
