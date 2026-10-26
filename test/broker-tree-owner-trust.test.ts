import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const script=path.resolve('scripts/audit-core-broker-protected-tree.ps1');
test('Broker protected code path checks actual owner, not just writable allow ACEs',()=>{
 const source=readFileSync(script,'utf8');
 assert.match(source,/GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
 assert.match(source,/\$ownerTrusted=\(\$ownerSid -in \$privilegedWriterSids\)/);
 assert.match(source,/\$_.ownerTrusted -eq \$false/);
 assert.match(source,/\$sid -eq 'S-1-3-0'/);
 assert.match(source,/PropagationFlags\]::InheritOnly/);
 assert.match(source,/productionReady=\$false/);
 assert.match(source,/nativeEffectiveLowPrivilegeAccessCheckCompleted=\$false/);
});
test('native Windows read-only audit reports real untrusted file owner as unsafe', {
 skip:process.platform!=='win32',timeout:40000,
},async()=>{
 const scratch=await mkdtemp(path.join(os.tmpdir(),'nexowire-owner-audit-'));
 try{
   const root=path.join(scratch,'protected');
   await mkdir(root,{recursive:true});
   const launcher=path.join(root,'broker.exe');
   const updater=path.join(root,'update.exe');
   const module=path.join(root,'module.dll');
   for(const file of [launcher,updater,module])await writeFile(file,'synthetic QA fixture, unsigned');
   const request={version:1,protectedInstallRoot:root,launcherPath:launcher,
     updaterPath:updater,importedModulePaths:[module]};
   const req=Buffer.from(JSON.stringify(request)).toString('base64');
   const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',
     script,'-EvidenceRequestBase64',req],{
       encoding:'utf8',windowsHide:true,timeout:22000,maxBuffer:256*1024,
   });
   assert.equal(result.status,0,result.stderr);
   const output=JSON.parse(result.stdout.trim()) as {
     inspectedEntries:{path:string;evidenceAvailable:boolean;ownerTrusted:boolean|null}[];
     anyInspectedPathUnsafe:boolean;productionReady:boolean;
     nativeEffectiveLowPrivilegeAccessCheckCompleted:boolean;
   };
   const leaf=output.inspectedEntries.find(x=>x.path.toLowerCase()===launcher.toLowerCase());
   assert.ok(leaf,'current file owner must be inspected');
   assert.equal(leaf.evidenceAvailable,true);
   assert.equal(typeof leaf.ownerTrusted,'boolean');
   const quotedLauncher="'"+launcher.replaceAll("'","''")+"'";
   const oracle=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',
     '$acl=Get-Acl -LiteralPath '+quotedLauncher+'; $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value'],{
       encoding:'utf8',windowsHide:true,timeout:10000,
   });
   assert.equal(oracle.status,0,oracle.stderr);
   const expectedTrusted=['S-1-5-18','S-1-5-32-544'].includes(oracle.stdout.trim());
   assert.equal(leaf.ownerTrusted,expectedTrusted,'native observed owner must match OS SID');
   if(!expectedTrusted)assert.equal(output.anyInspectedPathUnsafe,true);
   assert.equal(output.productionReady,false);
   assert.equal(output.nativeEffectiveLowPrivilegeAccessCheckCompleted,false);
 }finally{await rm(scratch,{recursive:true,force:true})}
});
