import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  DEFAULT_HOSTED_CONTROL_PLANE_URL,
} from '../src/connect.js';
import {
  defaultLemonSqueezyProvisioningPaths,
  evaluateLemonSqueezyProvisioningReadiness,
  readLemonSqueezyProvisioningState,
  validateLemonSqueezyCatalog,
  validateLemonSqueezyWebhookReadiness,
} from '../src/product/lemon-squeezy-provisioning.js';
import {
  validatePublicProductionAcceptance,
} from '../src/product/paid-plan-production-acceptance.js';
import {
  readProtectedSecretFile,
} from '../src/security/protected-secret-files.js';

interface Args {
  deploy: boolean;
  controlPlaneUrl: string;
}

function help(): string {
  return [
    'Usage:',
    '  npm run billing:acceptance',
    '  npm run billing:acceptance:deploy',
    '',
    'Read-only mode validates local provisioning, the live Lemon Squeezy',
    'catalog/webhook state, public control-plane health, the zero-owner-spend',
    'contract, and the billing authentication boundary.',
    '',
    '--deploy runs the existing protected Cloudflare bootstrap once before',
    'the final public acceptance probe.',
    '',
    'This command never creates a checkout, charges money, issues a refund,',
    'or prints protected secret values.',
  ].join('\n');
}

export function parsePaidPlanAcceptanceArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Args {
  let deploy = false;
  let controlPlaneUrl =
    env.NEXOWIRE_CONTROL_PLANE_URL?.trim() ||
    DEFAULT_HOSTED_CONTROL_PLANE_URL;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--deploy') {
      deploy = true;
      continue;
    }
    if (arg === '--control-plane-url') {
      const value = argv[++index]?.trim();
      if (!value) {
        throw new Error(
          '--control-plane-url requires a value.',
        );
      }
      controlPlaneUrl = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(help() + '\n');
      process.exit(0);
    }
    throw new Error(
      'Unknown billing acceptance option: ' +
        String(arg),
    );
  }

  return {
    deploy,
    controlPlaneUrl,
  };
}

async function runProtectedBootstrap(): Promise<void> {
  const script = path.join(
    process.cwd(),
    'scripts',
    'bootstrap-cloudflare-control-plane.ts',
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        script,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit',
        windowsHide: false,
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          'CONTROL_PLANE_BOOTSTRAP_FAILED:' +
            String(code ?? signal ?? 'unknown'),
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const args = parsePaidPlanAcceptanceArgs(
    process.argv.slice(2),
  );
  const readiness =
    await evaluateLemonSqueezyProvisioningReadiness();

  if (!readiness.readyForProvisionedBootstrap) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          stage: 'local-provisioning',
          readiness,
          nextAction:
            'Run the protected Lemon Squeezy production provisioning workflow with the real live-mode API key and catalog IDs.',
          deployAttempted: false,
          providerRequestAttempted: false,
          financialMutationPerformed: false,
        },
        null,
        2,
      ) + '\n',
    );
    process.exitCode = 2;
    return;
  }

  const paths =
    defaultLemonSqueezyProvisioningPaths();
  const state =
    await readLemonSqueezyProvisioningState(
      paths.configFile,
    );

  const apiKey = readProtectedSecretFile(
    paths.apiKeyFile,
    'billing-lemonsqueezy-api-key',
    'Lemon Squeezy API key',
  );
  const webhookSecret = readProtectedSecretFile(
    paths.webhookSecretFile,
    'billing-lemonsqueezy-webhook-secret',
    'Lemon Squeezy webhook secret',
  );
  if (!webhookSecret.trim()) {
    throw new Error(
      'LEMONSQUEEZY_WEBHOOK_SECRET_EMPTY',
    );
  }

  const catalog =
    await validateLemonSqueezyCatalog({
      apiKey,
      storeId: state.storeId,
      plusVariantId: state.plusVariantId,
      proVariantId: state.proVariantId,
      prepaidPacks: state.prepaidPacks,
    });
  const webhook =
    await validateLemonSqueezyWebhookReadiness({
      apiKey,
      storeId: state.storeId,
      webhookId: state.webhookId,
      webhookUrl: state.webhookUrl,
    });

  if (args.deploy) {
    await runProtectedBootstrap();
  }

  const production =
    await validatePublicProductionAcceptance({
      controlPlaneUrl: args.controlPlaneUrl,
      expectBillingConfigured: args.deploy,
    });

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        stage: args.deploy
          ? 'deployed-read-only-acceptance'
          : 'read-only-provider-preflight',
        deployAttempted: args.deploy,
        productionBillingDeploymentValidated:
          args.deploy,
        deploymentEvidence: args.deploy
          ? 'protected-control-plane-bootstrap-succeeded'
          : 'not-deployed-by-this-run',
        localProvisioning: {
          readyForProvisionedBootstrap: true,
          configPath: paths.configFile,
          apiKeyProtectedFile: paths.apiKeyFile,
          webhookSecretProtectedFile:
            paths.webhookSecretFile,
          protectedSecretsDecryptedInMemory: true,
        },
        provider: {
          validated: true,
          storeId: catalog.storeId,
          variants: catalog.variants,
          webhook,
        },
        production,
        financialMutationPerformed: false,
        liveMoneyAcceptanceRemaining: true,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((error) => {
  process.stderr.write(
    'Nexowire paid-plan acceptance error: ' +
      (error instanceof Error
        ? error.message
        : String(error)) +
      '\n',
  );
  process.exitCode = 1;
});
