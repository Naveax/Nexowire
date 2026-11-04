import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readCloudflareTunnelCredential,CloudflareCredentialCustodyError} from '../src/mcp/cloudflare-credential-custody.js';
import {prepareTrustedCloudflared,OFFICIAL_CLOUDFLARED_SHA256,CloudflaredPublisherAuditError} from '../src/mcp/cloudflare-binary-trust.js';
import {windowsDpapiChildEnvironment} from '../src/security/windows-dpapi.js';

const ICACLS='C:\\Windows\\System32\\icacls.exe';
const WHOAMI='C:\\Windows\\System32\\whoami.exe';
function cmd(exe:string,args:string[]){
  const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:4096});
  assert.equal(r.status,0,'disposable Windows ACL fixture command failed');
}
function sid(){
  const r=spawnSync(WHOAMI,['/user','/fo','csv','/nh'],{
    encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:4096});
  assert.equal(r.status,0);
  const match=r.stdout.match(/S-1-5-\d+(?:-\d+)+/);
  assert.ok(match,'authenticated Windows SID unavailable');
  return match[0];
}
test('CLEAN-13 P1-D Windows exact SID, inherited ACE and parent replacement rights',{
  skip:process.platform!=='win32',
  timeout:90000,
},async t=>{
  // GitHub's runner-wide TEMP ancestry can grant cross-user replacement
  // rights. A genuinely owner-private positive must live under the disposable
  // runner account's protected profile, not a shared runner scratch tree.
  const dir=await fs.mkdtemp(path.join(os.homedir(),'nexowire-clean13-win-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200}));
  const file=path.join(dir,'fake-tunnel.json');
  await fs.writeFile(file,'{"fake":true}',{mode:0o600});
  const user=sid();
  // Windows elevated runner tokens can create new files with the
  // Administrators GROUP as owner, even when current-user full-control
  // ACEs are explicit. ACL grants do NOT change ownership. Establish the
  // real logon user's exact SID on these disposable objects only.
  for(const target of [dir,file]){
    cmd(ICACLS,[target,'/inheritance:r','/grant:r',
      '*'+user+':(F)','*S-1-5-18:(F)','*S-1-5-32-544:(F)']);
    cmd(ICACLS,[target,'/setowner','*'+user]);
  }
  let good:Buffer;
  try{good=await readCloudflareTunnelCredential(file);}
  catch(error){
    if(error instanceof CloudflareCredentialCustodyError){
      console.info('CLEAN13_WINDOWS_ACL_OWNER_ONLY_DIAG='+JSON.stringify({
        reason:error.code,elapsedMs:error.elapsedMs,exitCode:error.childExitCode,
      }));
    }
    throw error;
  }
  assert.equal(good.toString('utf8'),'{"fake":true}');

  cmd(ICACLS,[file,'/grant','*S-1-5-11:(R)']);
  await assert.rejects(readCloudflareTunnelCredential(file),(error:unknown)=>{
    assert.ok(error instanceof CloudflareCredentialCustodyError);
    assert.match(error.message,/credential custody unsafe/);
    assert.equal(error.code,'FILE_UNTRUSTED_ACE');
    return true;
  });
  cmd(ICACLS,[file,'/remove:g','*S-1-5-11']);
  assert.equal((await readCloudflareTunnelCredential(file)).toString('utf8'),'{"fake":true}');

  // Real inherited ACE negative: the parent grants read-through inheritance,
  // not an explicit ACE on the credential. Re-enable only this disposable
  // child's inheritance, then restore its locked DACL afterwards.
  cmd(ICACLS,[dir,'/grant','*S-1-5-11:(OI)(CI)(R)']);
  cmd(ICACLS,[file,'/inheritance:e']);
  await assert.rejects(readCloudflareTunnelCredential(file),(error:unknown)=>{
    assert.ok(error instanceof CloudflareCredentialCustodyError);
    assert.equal(error.code,'FILE_UNTRUSTED_ACE');
    return true;
  });
  cmd(ICACLS,[file,'/inheritance:r']);
  cmd(ICACLS,[dir,'/remove:g','*S-1-5-11']);
  assert.equal((await readCloudflareTunnelCredential(file)).toString('utf8'),'{"fake":true}');

  // Real foreign file owner, not just a simulated SID passed to the verifier.
  // Restrict all mutations to this disposable credential fixture.
  cmd(ICACLS,[file,'/setowner','*S-1-5-32-544']);
  await assert.rejects(readCloudflareTunnelCredential(file),(error:unknown)=>{
    assert.ok(error instanceof CloudflareCredentialCustodyError);
    assert.match(error.message,/credential custody unsafe/);
    assert.equal(error.code,'FOREIGN_OWNER');
    return true;
  });
  cmd(ICACLS,[file,'/setowner','*'+user]);

  // A world-readable file may be masked by a private parent. Parent writes
  // must be denied independently to block rename/replace attacks.
  cmd(ICACLS,[dir,'/grant','*S-1-5-32-545:(M)']);
  await assert.rejects(readCloudflareTunnelCredential(file),(error:unknown)=>{
    assert.ok(error instanceof CloudflareCredentialCustodyError);
    assert.match(error.message,/credential custody unsafe/);
    assert.equal(error.code,'PARENT_REPLACE_ACE');
    return true;
  });
});

// CI downloads an independently hash-verified official image before this test.
// A valid signer must pass provenance but MUST NOT bypass the missing native
// held-handle execution boundary. No actual cloudflared process is launched.
test('CLEAN-13 P1-B Windows official image requires native immutable launch guard',{
  skip:process.platform!=='win32',timeout:90000,
},async()=>{
  const image=process.env.NEXOWIRE_CLOUDFLARED_TEST_BINARY;
  assert.ok(image,'hosted Windows must provision official checked Cloudflare artifact');
  await assert.rejects(prepareTrustedCloudflared(image,OFFICIAL_CLOUDFLARED_SHA256['win32-x64']),
    (error:unknown)=>{
      if(error instanceof CloudflaredPublisherAuditError){
        console.info('CLEAN13_WINDOWS_PS51_AUTHENTICODE_DIAG='+JSON.stringify({
          reason:error.reason,elapsedMs:error.elapsedMs,exitCode:error.childExitCode,
        }));
      }
      assert.ok(error instanceof Error);
      assert.match(error.message,/native signed handle custodian/);
      return true;
    });
});


/** Hosted signer baseline: PowerShell 7 is the independently observed signer
 * check. The production audit above deliberately uses Windows PowerShell 5.1;
 * compare its classified failure separately instead of trusting this baseline
 * to authorize execution or masking the native image-section NO-GO.
 */
test('CLEAN-13 P1-B Windows independent PowerShell 7 signer baseline',{
  skip:process.platform!=='win32',timeout:45000,
},()=>{
  const image=process.env.NEXOWIRE_CLOUDFLARED_TEST_BINARY;
  assert.ok(image,'exact release artifact must be available on Windows CI');
  const ps=[
    "$ErrorActionPreference='Stop'",
    "$s=Get-AuthenticodeSignature -LiteralPath $env:NEXOWIRE_CLOUDFLARED_IMAGE -ErrorAction Stop",
    "$c=$s.SignerCertificate",
    "$hash=(Get-FileHash -LiteralPath $env:NEXOWIRE_CLOUDFLARED_IMAGE -Algorithm SHA256).Hash.ToLowerInvariant()",
    "$o=@{major=$PSVersionTable.PSVersion.Major;status=[string]$s.Status;signerPresent=($null -ne $c);subjectMatchesCloudflare=($null -ne $c -and $c.Subject -match 'Cloudflare');thumbprint=$(if($null -ne $c){$c.Thumbprint}else{'NONE'});sha256Pinned=($hash -eq '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6')}",
    "[Console]::Out.Write(($o | ConvertTo-Json -Compress))",
  ].join('\n');
  const started=Date.now();
  const result=spawnSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4096,
      env:{...windowsDpapiChildEnvironment(),NEXOWIRE_CLOUDFLARED_IMAGE:image}});
  const report={engine:'PowerShell 7',exitCode:result.status,
    errorCode:(result.error as NodeJS.ErrnoException|undefined)?.code??null,
    elapsedMs:Date.now()-started};
  console.info('CLEAN13_WINDOWS_PS7_AUTHENTICODE_PROCESS='+JSON.stringify(report));
  assert.equal(result.status,0,'PowerShell 7 independent signer diagnostic must succeed');
  const data=JSON.parse(result.stdout.trim()) as {major:number;status:string;signerPresent:boolean;
    subjectMatchesCloudflare:boolean;thumbprint:string;sha256Pinned:boolean};
  console.info('CLEAN13_WINDOWS_PS7_AUTHENTICODE_RESULT='+JSON.stringify(data));
  assert.equal(data.major,7);
  assert.equal(data.status,'Valid');
  assert.equal(data.signerPresent,true);
  assert.equal(data.subjectMatchesCloudflare,true);
  assert.match(data.thumbprint,/^[A-Fa-f0-9]{40}$/);
  assert.equal(data.sha256Pinned,true);
});
