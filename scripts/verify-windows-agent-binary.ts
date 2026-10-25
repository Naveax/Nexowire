/**
 * S3 read-only Windows Authenticode inspection. Example:
 * npm run s3:verify-windows-binary -- --file "C:\safe\agent.exe" \
 *   --sha256 <64 hex> --cert-sha256 <64 hex> --subject "CN=..."
 *
 * Operator must provision the pins OUT OF BAND from a trusted release
 * authority. CLI arguments are not by themselves a trust root.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  inspectSignedWindowsBinary,
  validateWindowsBinaryTrustPins,
  type WindowsBinaryTrustPins,
} from './s3-windows-binary-trust.js';

export function parseS3BinaryVerificationArgs(args: readonly string[]): WindowsBinaryTrustPins {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    const value = args[i + 1];
    if (!option || !['--file', '--sha256', '--cert-sha256', '--subject'].includes(option) ||
        typeof value !== 'string' || !value.length || value.startsWith('--') ||
        Object.prototype.hasOwnProperty.call(flags, option)) {
      throw new Error('S3_BINARY_ARGUMENTS_INVALID');
    }
    flags[option] = value;
  }
  if (Object.keys(flags).length !== 4) throw new Error('S3_BINARY_ARGUMENTS_INVALID');
  return validateWindowsBinaryTrustPins({
    filePath: flags['--file']!,
    expectedSha256: flags['--sha256']!,
    expectedCertificateSha256: flags['--cert-sha256']!,
    expectedPublisherSubject: flags['--subject']!,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const pins = parseS3BinaryVerificationArgs(process.argv.slice(2));
    const verified = inspectSignedWindowsBinary(pins);
    process.stdout.write(JSON.stringify(verified, null, 2) + '\n');
  } catch (failure) {
    // Never print paths, filenames, caller supplied parameters or signed
    // executable contents into CI/service logs.
    const code = failure instanceof Error && /^S3_BINARY_[A-Z_]+$/.test(failure.message)
      ? failure.message : 'S3_BINARY_UNVERIFIED';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  }
}
