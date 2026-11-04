import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ROUND 2: actual Windows API/NTFS fixtures, for a DISPOSABLE GitHub Actions
 * Windows runner only. No mocks, no production PC, no Cloudflare account.
 *
 * No test is registered on other platforms; report Windows cases NOT_RUN
 * there. Every rejection has a prerequisite proving the named attack exists.
 */
if(process.platform==='win32'){
  const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const ICACLS='C:\\Windows\\System32\\icacls.exe';
  const OFFICIAL='4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6';

  type Probe={status:string;signerPresent:boolean;cloudflareSigner:boolean;subject?:string};
  function run(executable:string,args:string[],timeoutMs=30000,env?:NodeJS.ProcessEnv){
    const started=Date.now();
    const result=spawnSync(executable,args,{
      encoding:'utf8',windowsHide:true,timeout:timeoutMs,maxBuffer:65536,
      ...(env?{env}:{}),
    });
    const classification=(result.error as NodeJS.ErrnoException|undefined)?.code==='ETIMEDOUT'?'TIMEOUT':
      result.error?'PROCESS_ERROR':result.status===0?'OK':'EXIT_NONZERO';
    return {classification,status:result.status,signal:result.signal,
      errorCode:(result.error as NodeJS.ErrnoException|undefined)?.code,elapsedMs:Date.now()-started,
      stdout:result.stdout??'',stderr:result.stderr??''};
  }
  function powershell(script:string,env?:NodeJS.ProcessEnv,timeout=35000){
    return run(POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive',
      '-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],timeout,env);
  }
  function ensureExecuted(result:ReturnType<typeof run>,purpose:string){
    assert.equal(result.classification,'OK',
      purpose+': '+JSON.stringify({
        classification:result.classification,exitStatus:result.status,
        processSignal:result.signal,errorCode:result.errorCode,elapsedMs:result.elapsedMs,
      }));
  }
  function captureSignature(file:string,env?:NodeJS.ProcessEnv):Probe{
    const script=[
      "$ErrorActionPreference='Stop'",
      "$s=Get-AuthenticodeSignature -LiteralPath $env:NW_V206_TARGET -ErrorAction Stop",
      "$present=($null -ne $s.SignerCertificate)",
      "$cloud=($present -and ($s.SignerCertificate.Subject -match 'Cloudflare'))",
      "[pscustomobject]@{status=$s.Status.ToString();signerPresent=$present;cloudflareSigner=$cloud}|ConvertTo-Json -Compress",
    ].join('\n');
    const result=powershell(script,{...(env??process.env),NW_V206_TARGET:file});
    ensureExecuted(result,'native Get-AuthenticodeSignature');
    return JSON.parse(result.stdout.trim()) as Probe;
  }
  async function officialPath():Promise<string>{
    const file=process.env.NEXOWIRE_CLOUDFLARED_TEST_BINARY;
    assert.ok(file,'hosted Windows runner must provision the independently pinned official cloudflared binary');
    assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),OFFICIAL,
      'the official-image fixture MUST pass reviewed SHA256 before testing Authenticode');
    return file;
  }
  function icacls(file:string,flags:string[]){
    const result=run(ICACLS,[file,...flags],20000);
    ensureExecuted(result,'real NTFS ACL edit in disposable TEMP');
  }
  function currentSid(){
    const result=powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    ensureExecuted(result,'current token SID');
    const value=result.stdout.trim();
    assert.match(value,/^S-1-5-(?:\d+-)+\d+$/,'real current Windows SID required');
    return value;
  }
  async function fixture(t:import('node:test').TestContext){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-v206-round2-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150}));
    const credential=path.join(root,'credential.json');
    await fs.writeFile(credential,'{"synthetic":true}');
    const me=currentSid();
    for(const file of [root,credential]){
      icacls(file,['/inheritance:r','/grant:r',
        '*'+me+':(F)','*S-1-5-18:(F)','*S-1-5-32-544:(F)']);
    }
    return {root,credential,me};
  }
  async function custody(){
    const modPath='../src/mcp/cloudflare-credential-custody.js';
    return (await import(modPath)) as {
      readCloudflareTunnelCredential(file:string):Promise<Buffer>;
    };
  }
  async function trustedImage(){
    const modPath='../src/mcp/cloudflare-binary-trust.js';
    return (await import(modPath)) as {
      prepareTrustedCloudflared(file:string,sha:string):Promise<unknown>;
    };
  }
  function ancestorAudit(file:string):{unsafeParents:number;unsafeFile:number;depth:number}{
    const script=[
      "$ErrorActionPreference='Stop'",
      "$trusted=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')",
      "$cur=[IO.Path]::GetFullPath($env:NW_V206_TARGET)",
      '$n=0;$file=$true;$badParent=0;$badFile=0',
      'while($true){',
      ' $acl=Get-Acl -LiteralPath $cur -ErrorAction Stop',
      ' foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){',
      "  if($ace.AccessControlType -ne 'Allow' -or $trusted -contains $ace.IdentityReference.Value){continue}",
      '  $rights=[int64]$ace.FileSystemRights',
      '  $mutate=[int64]0x2 -bor [int64]0x4 -bor [int64]0x10 -bor [int64]0x40 -bor [int64]0x100 -bor [int64]0x10000 -bor [int64]0x40000 -bor [int64]0x80000 -bor [int64]0x40000000 -bor [int64]0x10000000',
      '  $danger=if($file){$mutate -bor [int64]0x120089}else{$mutate}',
      '  if(($rights -band $danger) -ne 0){if($file){$badFile++}else{$badParent++}}',
      ' }',
      ' $n++;$up=[IO.Directory]::GetParent($cur)',
      ' if($null -eq $up){break}',
      ' $cur=$up.FullName;$file=$false',
      '}',
      '[pscustomobject]@{unsafeParents=$badParent;unsafeFile=$badFile;depth=$n}|ConvertTo-Json -Compress',
    ].join('\n');
    const result=powershell(script,{...process.env,NW_V206_TARGET:file},35000);
    ensureExecuted(result,'independent real Get-Acl parent-chain audit');
    return JSON.parse(result.stdout.trim());
  }

  test('V2-06 R2 Windows valid official signer must reach native immutable-image guard, not publisher rejection',{
    timeout:140000,
  },async()=>{
    const image=await officialPath();
    const normal=captureSignature(image);
    assert.deepEqual({valid:normal.status==='Valid',present:normal.signerPresent,
      publisher:normal.cloudflareSigner},{valid:true,present:true,publisher:true},
      'official native Authenticode proof must be valid before checking product launch gate');
    const minimalPath='../src/security/windows-dpapi.js';
    const minimal=(await import(minimalPath)) as {windowsDpapiChildEnvironment():NodeJS.ProcessEnv};
    const sanitized=captureSignature(image,minimal.windowsDpapiChildEnvironment());
    assert.deepEqual({valid:sanitized.status==='Valid',present:sanitized.signerPresent,
      publisher:sanitized.cloudflareSigner},{valid:true,present:true,publisher:true},
      'same genuine signed image MUST validate under the subprocess environment used by the product');
    const product=await trustedImage();
    await assert.rejects(product.prepareTrustedCloudflared(image,OFFICIAL),
      /native signed handle custodian/i,
      'positive publisher verification must reach the explicit unsupported Windows immutable-image guard');
  });

  test('V2-06 R2 Windows actual Microsoft-signed wrong signer and unsigned fixture are distinguishable',{
    timeout:90000,
  },async t=>{
    const wrong='C:\\Windows\\System32\\notepad.exe';
    const nativeWrong=captureSignature(wrong);
    assert.equal(nativeWrong.status,'Valid','wrong-publisher fixture must be authentically signed');
    assert.equal(nativeWrong.signerPresent,true);
    assert.equal(nativeWrong.cloudflareSigner,false,'Microsoft-signed image is not an official Cloudflare signer');
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-v206-unsigned-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const unsigned=path.join(dir,'disposable.ps1');
    await fs.writeFile(unsigned,'Write-Output "disposable-only"\n');
    const nativeUnsigned=captureSignature(unsigned);
    assert.equal(nativeUnsigned.status,'NotSigned','real unsigned fixture must be recognized as NotSigned');
    assert.equal(nativeUnsigned.signerPresent,false,'unsigned case must not be confused with wrong signer');
    const product=await trustedImage();
    const bytes=await fs.readFile(wrong);
    await assert.rejects(product.prepareTrustedCloudflared(wrong,
      createHash('sha256').update(bytes).digest('hex')),/publisher|provenance/i,
      'independently pinned official digest must deny a real Microsoft publisher image');
    // An unsigned .ps1 is not an executable launch fixture. Its native signature
    // state is independently evidenced; no false product-path assertion.
  });

  test('V2-06 R2 Windows genuine self-signed non-trusted signature fixture',{
    timeout:90000,
  },async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-v206-selfsigned-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const file=path.join(dir,'self-signed.ps1');
    await fs.writeFile(file,'Write-Output "disposable-only"\n');
    const script=[
      "$ErrorActionPreference='Stop'",
      '$cert=$null',
      'try{',
      " $cert=New-SelfSignedCertificate -Subject 'CN=Disposable-Nexowire-V206-QA' -Type CodeSigningCert -CertStoreLocation Cert:\\CurrentUser\\My -KeyAlgorithm RSA -KeyLength 2048",
      ' $signed=Set-AuthenticodeSignature -LiteralPath $env:NW_V206_TARGET -Certificate $cert -ErrorAction Stop',
      ' $observed=Get-AuthenticodeSignature -LiteralPath $env:NW_V206_TARGET',
      " [pscustomobject]@{signerPresent=($null -ne $observed.SignerCertificate);trusted=($observed.Status.ToString() -eq 'Valid');",
      "   ownSubject=($observed.SignerCertificate.Subject -like '*Disposable-Nexowire-V206-QA*');",
      "   cloudflare=($observed.SignerCertificate.Subject -match 'Cloudflare')}|ConvertTo-Json -Compress",
      '}finally{if($null -ne $cert){Remove-Item -LiteralPath ("Cert:\\CurrentUser\\My\\"+$cert.Thumbprint) -Force -ErrorAction SilentlyContinue}}',
    ].join('\n');
    const result=powershell(script,{...process.env,NW_V206_TARGET:file},65000);
    ensureExecuted(result,'actual Windows CurrentUser self-signed CodeSigning certificate fixture');
    const state=JSON.parse(result.stdout.trim());
    assert.deepEqual(state,{signerPresent:true,trusted:false,ownSubject:true,cloudflare:false},
      'self-signed signed content must not be treated as a trusted publisher');
  });

  test('V2-06 R2 Windows owner-only credential positive and inherited ACE fail-closed use real NTFS ACL',{
    timeout:180000,
  },async t=>{
    const f=await fixture(t);
    const native=ancestorAudit(f.credential);
    assert.equal(native.unsafeFile,0,'positive fixture itself has foreign readable or writable ACE');
    assert.equal(native.unsafeParents,0,
      'positive fixture has an independently measured foreign-writable ancestor; this cannot count as owner-only PASS: '+
      JSON.stringify(native));
    const product=await custody();
    assert.equal((await product.readCloudflareTunnelCredential(f.credential)).toString('utf8'),
      '{"synthetic":true}','owner-only credential MUST be readable through product custody');
    // Inherit an actual Authenticated Users read ACE from its parent, then
    // verify that exact inherited ACE really exists before asking product.
    icacls(f.root,['/grant','*S-1-5-11:(OI)(CI)(R)']);
    icacls(f.credential,['/inheritance:e']);
    const checkScript=[
      "$a=Get-Acl -LiteralPath $env:NW_V206_TARGET",
      "$rules=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])",
      "$count=@($rules|Where-Object{$_.IsInherited -and $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -eq 'S-1-5-11'}).Count",
      '[Console]::Out.Write($count)',
    ].join('\n');
    const observed=powershell(checkScript,{...process.env,NW_V206_TARGET:f.credential});
    ensureExecuted(observed,'actual inherited untrusted Windows ACE readback');
    assert.ok(Number(observed.stdout.trim())>0,
      'fixture must prove the inherited S-1-5-11 ACE exists before claiming rejection');
    await assert.rejects(product.readCloudflareTunnelCredential(f.credential),
      /credential custody unsafe/i,
      'inherited untrusted file read must be denied at custody boundary');
  });

  test('V2-06 R2 Windows credential hardlink and parent reparse require real NTFS filesystem evidence',{
    timeout:180000,
  },async t=>{
    const f=await fixture(t);
    const product=await custody();
    // The positive read is a required precondition for meaningful negatives.
    assert.equal((await product.readCloudflareTunnelCredential(f.credential)).toString('utf8'),
      '{"synthetic":true}');
    const link=path.join(f.root,'hardlink.json');
    await fs.link(f.credential,link);
    assert.equal((await fs.stat(f.credential)).nlink,2,'actual NTFS link count must be 2');
    await assert.rejects(product.readCloudflareTunnelCredential(f.credential),
      /credential custody unsafe/i);
    await fs.unlink(link);

    const parent=path.join(f.root,'junction-parent');
    const rootCopy=path.join(f.root,'nested');
    await fs.mkdir(rootCopy);
    const target=path.join(rootCopy,'inside.json');
    await fs.writeFile(target,'{"synthetic":true}');
    await fs.symlink(rootCopy,parent,'junction');
    const stats=await fs.lstat(parent);
    assert.equal(stats.isSymbolicLink(),true,'a real Windows reparse/junction alias is required');
    await assert.rejects(product.readCloudflareTunnelCredential(path.join(parent,'inside.json')),
      /credential custody unsafe/i,'actual NTFS reparse parent must be denied at the custody boundary');
  });

  test('V2-06 R2 Windows path replacement refuses changed image digest before any immutable launch',{
    timeout:90000,
  },async t=>{
    const signed=await officialPath();
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-v206-swap-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const victim=path.join(dir,'cloudflared.exe');
    const replacement=path.join(dir,'replacement.exe');
    await fs.copyFile(signed,victim);
    assert.equal(createHash('sha256').update(await fs.readFile(victim)).digest('hex'),OFFICIAL);
    await fs.copyFile(process.execPath,replacement);
    await fs.rename(replacement,victim);
    assert.notEqual(createHash('sha256').update(await fs.readFile(victim)).digest('hex'),OFFICIAL,
      'actual file replacement must change the image bytes');
    const product=await trustedImage();
    await assert.rejects(product.prepareTrustedCloudflared(victim,OFFICIAL),
      /checksum mismatch/i,'changed image must be rejected for exact checksum mismatch');
    // This is a PRE-verification path-swap denial only. Windows actual
    // verified-image-to-CreateProcess TOCTOU remains NOT_RUN until a native
    // handle-bound image custodian exists. Never mislabel this as its proof.
  });
}
