import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderSetupScript } from './build-windows-user-bundle.js';

// Verified against GitHub's v1.0.7 release asset digests and annotated tag.
// This is an updated bootstrap, not a new application release or signature.
export const stableWindowsPayload = Object.freeze({
  version: '1.0.7',
  sourceSha: 'e9489175cf599c47f331a22c463421048d1ba407',
  payloadSha256: '1d463f408d9f18840748c2e83080adfa3f642afadefd000f8c43cadae5e20896',
  repository: 'Naveax/Nexowire',
});

export function renderStableWindowsSetup(): string {
  return renderSetupScript(stableWindowsPayload);
}

export function stableWindowsChecksums(setup: string): string {
  return [
    createHash('sha256').update(setup, 'utf8').digest('hex') + '  Nexowire-Setup.cmd',
    stableWindowsPayload.payloadSha256 + '  Nexowire-Windows-x64.zip',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const directory = path.resolve('installers');
  const setup = renderStableWindowsSetup();
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'Nexowire-Setup.cmd'), setup, 'utf8');
  await fs.writeFile(path.join(directory, 'SHA256SUMS-Windows'), stableWindowsChecksums(setup));
  process.stdout.write('Generated repository bootstrap for the unchanged published v1.0.7 payload.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
