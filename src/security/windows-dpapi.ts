import { spawn, spawnSync } from 'node:child_process';

export type DpapiChildStage='before-script'|'script-start'|'assembly-loaded'|'stdin-read'|'input-decoded'|'crypto-start'|'crypto-rejected'|'crypto-complete'|'output-complete';
export type DpapiChildFailure='spawn'|'stdin'|'output-limit'|'timeout'|'terminated'|'crypto-rejected'|'child-exit';
export interface DpapiChildDiagnostic {
  readonly operation:'protect'|'unprotect';readonly scope:WindowsDpapiScope;
  readonly stage:DpapiChildStage;readonly failure:DpapiChildFailure;readonly elapsedMs:number;
}
const stageOrder:readonly DpapiChildStage[]=['script-start','assembly-loaded','stdin-read','input-decoded','crypto-start','crypto-complete','output-complete'];
/** Exact fixed markers only; never echo PowerShell stderr or payload. */
export function dpapiChildStage(stderr:string):DpapiChildStage {
  let stage:DpapiChildStage='before-script';let next=0;
  for(const line of stderr.split(/\r?\n/)){
    if(!line.startsWith('NWX_DPAPI_STAGE:'))continue;
    const value=line.slice('NWX_DPAPI_STAGE:'.length);
    if(value==='crypto-rejected'&&stage==='crypto-start'){stage=value;next=-1;continue}
    if(next<0||value!==stageOrder[next])return 'before-script';
    stage=stageOrder[next++]!;
  }
  return stage;
}

export class WindowsDpapiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnostic?:Readonly<DpapiChildDiagnostic>,
  ) {
    super(message);
    this.name = 'WindowsDpapiError';
  }
}

const LEGACY_BROKER_ENTROPY = 'Nexowire/privileged-broker/v1';
const PROTECTED_SECRET_PREFIX = 'Nexowire/protected-secret/v1/';
const DPAPI_WINDOWS_SYSTEM32 = 'C:\\Windows\\System32';
const DPAPI_POWERSHELL = DPAPI_WINDOWS_SYSTEM32 + '\\WindowsPowerShell\\v1.0\\powershell.exe';
// Hosted Windows runners can be heavily contended (PowerShell/DPAPI initialization
// sometimes takes well over 30s). Stay bounded without rejecting valid envelopes.
const DPAPI_TIMEOUT_MS = 180_000;
const DPAPI_MAX_BYTES = 2 * 1024 * 1024;

/** DPAPI payloads are sent on stdin. The subprocess must not inherit a
 * caller-controlled executable search path, PSModulePath or Node hooks. */
export function windowsDpapiChildEnvironment():NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={
    SystemRoot:'C:\\Windows',
    windir:'C:\\Windows',
    ComSpec:DPAPI_WINDOWS_SYSTEM32+'\\cmd.exe',
    PATH:DPAPI_WINDOWS_SYSTEM32+';C:\\Windows',
    PSModulePath:DPAPI_WINDOWS_SYSTEM32+'\\WindowsPowerShell\\v1.0\\Modules',
  };
  // DPAPI CurrentUser and WindowsPowerShell need Windows user profile/temp
  // directories on some hosted/service accounts. They do NOT select an
  // executable, module, profile script (NoProfile) or current directory.
  // Never copy the whole environment or trust remote/relative paths.
  for(const key of ['USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'] as const){
    const value=process.env[key];
    if(!value || value.length>1024 ||
       !/^[A-Za-z]:\\/.test(value) ||
       /[;"'\r\n\0]/.test(value) ||
       value.split(/[\\/]/).includes('..'))continue;
    env[key]=value;
  }
  return env;
}


export type WindowsDpapiScope =
  | 'current-user'
  | 'local-machine';

function dpapiScopeExpression(
  scope: WindowsDpapiScope,
): 'CurrentUser' | 'LocalMachine' {
  return scope === 'local-machine'
    ? 'LocalMachine'
    : 'CurrentUser';
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_REQUIRED',
      'Windows DPAPI is available only on Windows.',
    );
  }
}

function validatePurpose(purpose: string): string {
  const normalized = purpose.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
  ) {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_PURPOSE_INVALID',
      'DPAPI purpose must be 1-128 safe identifier characters.',
    );
  }
  return normalized;
}

function strictBase64(value: string): Buffer {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_INVALID_CIPHERTEXT',
      'DPAPI ciphertext is not valid base64.',
    );
  }

  const decoded = Buffer.from(normalized, 'base64');
  if (
    decoded.length === 0 ||
    decoded.toString('base64') !== normalized
  ) {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_INVALID_CIPHERTEXT',
      'DPAPI ciphertext is not canonical base64.',
    );
  }
  return decoded;
}

function powershellScript(
  operation: 'protect' | 'unprotect',
  scope: WindowsDpapiScope = 'current-user',
): string {
  const method =
    operation === 'protect' ? 'Protect' : 'Unprotect';
  const dataProtectionScope =
    dpapiScopeExpression(scope);
  return [
    "$ErrorActionPreference='Stop'",
    "[Console]::Error.WriteLine('NWX_DPAPI_STAGE:script-start')",
    'Add-Type -AssemblyName System.Security',
    "[Console]::Error.WriteLine('NWX_DPAPI_STAGE:assembly-loaded')",
    '$raw=[Console]::In.ReadToEnd()',
    "[Console]::Error.WriteLine('NWX_DPAPI_STAGE:stdin-read')",
    '$payload=$raw | ConvertFrom-Json',
    '$inputBytes=[Convert]::FromBase64String([string]$payload.input)',
    '$entropy=[Convert]::FromBase64String([string]$payload.entropy)',
    '$scope=[Security.Cryptography.DataProtectionScope]::' +
      dataProtectionScope,
    "[Console]::Error.WriteLine('NWX_DPAPI_STAGE:input-decoded')",
    "[Console]::Error.WriteLine('NWX_DPAPI_STAGE:crypto-start')",
    `try { $output=[Security.Cryptography.ProtectedData]::${method}($inputBytes,$entropy,$scope) } catch { $e=$_.Exception; while ($null -ne $e -and -not ($e -is [Security.Cryptography.CryptographicException])) { $e=$e.InnerException }; if ($null -ne $e) { [Console]::Error.WriteLine('NWX_DPAPI_STAGE:crypto-rejected'); exit 23 }; exit 24 }`,
    "[Console]::Error.WriteLine('NWX_DPAPI_STAGE:crypto-complete')",
    '[Console]::Out.Write([Convert]::ToBase64String($output))',
    "[Console]::Error.WriteLine('NWX_DPAPI_STAGE:output-complete')",
  ].join('; ');
}

function stdinPayload(value: Buffer, entropy: string): string {
  return JSON.stringify({
    input: value.toString('base64'),
    entropy: Buffer.from(entropy, 'utf8').toString('base64'),
  });
}

function decodeOutput(
  operation: 'protect' | 'unprotect',
  stdout: string,
): Buffer {
  const out = stdout.trim();
  try {
    return strictBase64(out);
  } catch (error) {
    if (
      error instanceof WindowsDpapiError &&
      error.code === 'WINDOWS_DPAPI_INVALID_CIPHERTEXT'
    ) {
      throw new WindowsDpapiError(
        'WINDOWS_DPAPI_INVALID_RESPONSE',
        `Windows DPAPI ${operation} returned invalid base64.`,
      );
    }
    throw error;
  }
}

function childFailure(operation:'protect'|'unprotect',scope:WindowsDpapiScope,stderr:string,
  failure:DpapiChildFailure,started:bigint):WindowsDpapiError {
  const elapsedMs=Number((process.hrtime.bigint()-started)/1000000n);
  const stage=dpapiChildStage(stderr);
  const diagnostic=Object.freeze({operation,scope,stage,failure,elapsedMs});
  return new WindowsDpapiError('WINDOWS_DPAPI_FAILED',
    'Windows DPAPI child failed: '+operation+'/'+scope+'; stage='+stage+'; failure='+failure+'; elapsedMs='+elapsedMs,diagnostic);
}

async function runDpapi(
  operation: 'protect' | 'unprotect',
  value: Buffer,
  entropy: string,
  scope: WindowsDpapiScope = 'current-user',
): Promise<Buffer> {
  assertWindows();

  return await new Promise<Buffer>((resolve, reject) => {
    const started=process.hrtime.bigint();
    const child = spawn(
      DPAPI_POWERSHELL,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        powershellScript(operation, scope),
      ],
      {
        windowsHide: true,
        shell:false,
        cwd:DPAPI_WINDOWS_SYSTEM32,
        env:windowsDpapiChildEnvironment(),
        timeout:DPAPI_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [], stderr:Buffer[]=[];
    const readStages=()=>Buffer.concat(stderr).toString('utf8');
    let collected = 0;
    let exceededLimit = false;
    child.stdout.on('data', (chunk: Buffer) => {
      collected += chunk.length;
      if (collected > DPAPI_MAX_BYTES) {
        exceededLimit = true;
        child.kill();
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      collected += chunk.length;
      if (collected > DPAPI_MAX_BYTES) {
        exceededLimit = true;
        child.kill();
      } else {stderr.push(chunk);}
    });

    child.once('error', () => reject(
      childFailure(operation,scope,readStages(),'spawn',started),
    ));
    child.stdin.on('error', () => reject(
      childFailure(operation,scope,readStages(),'stdin',started),
    ));
    child.once('close', (code, signal) => {
      if (exceededLimit) {
        reject(childFailure(operation,scope,readStages(),'output-limit',started));
        return;
      }
      if (code !== 0 || signal !== null) {
        const stages=readStages();
        const elapsed=process.hrtime.bigint()-started;
        const failure:DpapiChildFailure=code===23&&signal===null&&dpapiChildStage(stages)==='crypto-rejected'
          ?'crypto-rejected':elapsed>=BigInt(DPAPI_TIMEOUT_MS)*1000000n?'timeout':signal!==null?'terminated':'child-exit';
        reject(childFailure(operation,scope,stages,failure,started));
        return;
      }
      const out = Buffer.concat(stdout).toString('utf8');

      try {
        resolve(decodeOutput(operation, out));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(stdinPayload(value, entropy), 'utf8');
  });
}

function runDpapiSync(
  operation: 'protect' | 'unprotect',
  value: Buffer,
  entropy: string,
  scope: WindowsDpapiScope = 'current-user',
): Buffer {
  assertWindows();

  const started=process.hrtime.bigint();
  const result = spawnSync(
    DPAPI_POWERSHELL,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      powershellScript(operation, scope),
    ],
    {
      windowsHide: true,
      shell:false,
      cwd:DPAPI_WINDOWS_SYSTEM32,
      env:windowsDpapiChildEnvironment(),
      input: stdinPayload(value, entropy),
      encoding: 'utf8',
      timeout:DPAPI_TIMEOUT_MS,
      maxBuffer:DPAPI_MAX_BYTES,
    },
  );

  if (result.error) {
    const failure:DpapiChildFailure=(result.error as NodeJS.ErrnoException).code==='ETIMEDOUT'?'timeout':
      (result.error as NodeJS.ErrnoException).code==='ENOBUFS'?'output-limit':'spawn';
    throw childFailure(operation,scope,result.stderr??'',failure,started);
  }
  if (result.status !== 0) {
    const stages=result.stderr??'';
    const failure:DpapiChildFailure=result.status===23&&result.signal===null&&dpapiChildStage(stages)==='crypto-rejected'
      ?'crypto-rejected':result.signal!==null?'terminated':'child-exit';
    throw childFailure(operation,scope,stages,failure,started);
  }
  return decodeOutput(operation, result.stdout);
}

function entropyForPurpose(purpose: string): string {
  return PROTECTED_SECRET_PREFIX + validatePurpose(purpose);
}

export async function protectWindowsUserSecret(
  plaintext: string,
): Promise<string> {
  const protectedBytes = await runDpapi(
    'protect',
    Buffer.from(plaintext, 'utf8'),
    LEGACY_BROKER_ENTROPY,
  );
  return protectedBytes.toString('base64');
}

export async function unprotectWindowsUserSecret(
  ciphertext: string,
): Promise<string> {
  const plaintext = await runDpapi(
    'unprotect',
    strictBase64(ciphertext),
    LEGACY_BROKER_ENTROPY,
  );
  return plaintext.toString('utf8');
}

export async function protectWindowsUserSecretForPurpose(
  plaintext: string,
  purpose: string,
): Promise<string> {
  const protectedBytes = await runDpapi(
    'protect',
    Buffer.from(plaintext, 'utf8'),
    entropyForPurpose(purpose),
  );
  return protectedBytes.toString('base64');
}

export async function unprotectWindowsUserSecretForPurpose(
  ciphertext: string,
  purpose: string,
): Promise<string> {
  const plaintext = await runDpapi(
    'unprotect',
    strictBase64(ciphertext),
    entropyForPurpose(purpose),
  );
  return plaintext.toString('utf8');
}

export function unprotectWindowsUserSecretForPurposeSync(
  ciphertext: string,
  purpose: string,
): string {
  return runDpapiSync(
    'unprotect',
    strictBase64(ciphertext),
    entropyForPurpose(purpose),
  ).toString('utf8');
}

export async function protectWindowsMachineSecretForPurpose(
  plaintext: string,
  purpose: string,
): Promise<string> {
  const protectedBytes = await runDpapi(
    'protect',
    Buffer.from(plaintext, 'utf8'),
    entropyForPurpose(purpose),
    'local-machine',
  );
  return protectedBytes.toString('base64');
}

export async function unprotectWindowsMachineSecretForPurpose(
  ciphertext: string,
  purpose: string,
): Promise<string> {
  const plaintext = await runDpapi(
    'unprotect',
    strictBase64(ciphertext),
    entropyForPurpose(purpose),
    'local-machine',
  );
  return plaintext.toString('utf8');
}

export function unprotectWindowsMachineSecretForPurposeSync(
  ciphertext: string,
  purpose: string,
): string {
  return runDpapiSync(
    'unprotect',
    strictBase64(ciphertext),
    entropyForPurpose(purpose),
    'local-machine',
  ).toString('utf8');
}
