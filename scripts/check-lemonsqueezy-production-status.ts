import {
  evaluateLemonSqueezyProvisioningReadiness,
} from '../src/product/lemon-squeezy-provisioning.js';

function help(): string {
  return [
    'Usage:',
    '  npm run billing:status',
    '',
    'Reports local Lemon Squeezy production provisioning readiness.',
    'The command never decrypts protected secrets and never contacts Lemon Squeezy.',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.length === 1 &&
    (args[0] === '--help' || args[0] === '-h')
  ) {
    process.stdout.write(help() + '\n');
    return;
  }
  if (args.length > 0) {
    throw new Error(
      'billing:status does not accept options. Use --help for usage.',
    );
  }

  const readiness =
    await evaluateLemonSqueezyProvisioningReadiness();

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        scope: 'local-provisioning-only',
        ...readiness,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((error) => {
  process.stderr.write(
    'Nexowire billing status error: ' +
      (error instanceof Error
        ? error.message
        : String(error)) +
      '\n',
  );
  process.exitCode = 1;
});
