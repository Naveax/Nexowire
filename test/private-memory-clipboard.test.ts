import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ZodError} from 'zod';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {executeWindowsPrivateClipboardCapability as clip} from '../src/agent/windows-private-clipboard.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';

test('private memory clipboard capabilities are correctly registered and permissioned',()=>{
  for(const [name,readOnly] of [
    ['status',true],['read',true],['write',false],['clear',false],['paste',false],
  ] as const){
    const cap='windows.private_clipboard.'+name;
    assert.equal(isReadOnlyCapability(cap),readOnly);
    assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS[
      ('windows_private_clipboard_'+name) as keyof typeof MCP_TOOL_CAPABILITY_REQUIREMENTS
    ],cap);
  }
});

test('private clipboard cannot read/write/paste without active NexowirePrivate',{
  skip:process.platform!=='win32',
},async()=>{
  await clip('windows.private_clipboard.clear',{});
  await assert.rejects(clip('windows.private_clipboard.write',{text:'x'}),
    (error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&
      error.code==='PRIVATE_DESKTOP_NOT_RUNNING');
  await assert.rejects(clip('windows.private_clipboard.read',{}),
    (error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&
      error.code==='PRIVATE_DESKTOP_NOT_RUNNING');
});

test('private clipboard writes, reads, pastes via private HWND and invalidates on desktop restart',{
  skip:process.platform!=='win32',timeout:80_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-clipboard-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await clip('windows.private_clipboard.clear',{}).catch(()=>undefined);
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false}) as {data:{inputDesktop:string}};
  assert.equal(started.data.inputDesktop,'Default');
  const empty=await clip('windows.private_clipboard.status',{}) as {data:{hasText:boolean;length:number}};
  assert.equal(empty.data.hasText,false);
  const saved=await clip('windows.private_clipboard.write',{
    text:'PrivateClipboard_123',
  }) as {data:{stored:boolean;physicalClipboardTouched:boolean;persistedToDisk:boolean}};
  assert.equal(saved.data.stored,true);
  assert.equal(saved.data.physicalClipboardTouched,false);
  assert.equal(saved.data.persistedToDisk,false);
  const read=await clip('windows.private_clipboard.read',{}) as {data:{text:string}};
  assert.equal(read.data.text,'PrivateClipboard_123');
  await assert.rejects(clip('windows.private_clipboard.read',{max_chars:5}),
    (e:unknown)=>e instanceof Error&&'code' in e&&
      e.code==='PRIVATE_CLIPBOARD_LIMIT_EXCEEDED');
  await assert.rejects(clip('windows.private_clipboard.write',{
    text:'x'.repeat(20_001),
  }),ZodError);
  await assert.rejects(clip('windows.private_clipboard.write',{
    text:'x',command:'Get-Clipboard',
  }),ZodError);

  const script=path.join(root,'clipboard-test.ps1');
  const log=path.join(root,'characters.txt');
  await fs.writeFile(script,[
    'param([string]$LogFile)',
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$code=@'",
    'using System;',
    'using System.IO;',
    'using System.Windows.Forms;',
    'public sealed class NxPrivateClipboardFixture : Form {',
    '  private readonly string output;',
    '  public NxPrivateClipboardFixture(string path) {',
    '    output=path; Text="Nexowire Private Clipboard Fixture";',
    '    Width=600; Height=330;',
    '  }',
    '  protected override void WndProc(ref Message m) {',
    '    if(m.Msg==0x0102) File.AppendAllText(output,',
    '       ((char)m.WParam.ToInt32()).ToString());',
    '    base.WndProc(ref m);',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $code -ReferencedAssemblies System.Windows.Forms,System.Drawing',
    '$form=New-Object NxPrivateClipboardFixture($LogFile)',
    '[System.Windows.Forms.Application]::Run($form)',
  ].join('\n'),'utf8');
  await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA',
      '-File',script,'-LogFile',log],
  });
  let hwnd:string|undefined;
  for(let i=0;i<45;i++){
    const info=await desktop('windows.private_desktop.windows',{}) as {
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>};
    };
    assert.equal(info.data.inputDesktop,'Default');
    hwnd=info.data.windows.find(w=>
      w.title==='Nexowire Private Clipboard Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(hwnd,'Private clipboard fixture must be running');
  await assert.rejects(clip('windows.private_clipboard.paste',{hwnd:'0x1'}),
    (err:unknown)=>err instanceof Error);
  const pasted=await clip('windows.private_clipboard.paste',{hwnd}) as {data:{sent:boolean;charsSent:number;physicalClipboardTouched:boolean;inputDesktop:string}};
  assert.equal(pasted.data.sent,true);
  assert.equal(pasted.data.charsSent,'PrivateClipboard_123'.length);
  assert.equal(pasted.data.inputDesktop,'Default');
  assert.equal(pasted.data.physicalClipboardTouched,false);
  for(let i=0;i<20;i++){
    const logged=await fs.readFile(log,'utf8').catch(()=>'');
    if(logged.includes('PrivateClipboard_123'))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(await fs.readFile(log,'utf8'),'PrivateClipboard_123');
  await desktop('windows.private_desktop.stop',{});
  await assert.rejects(clip('windows.private_clipboard.read',{}),
    (error:unknown)=>error instanceof Error&&'code' in error&&
      error.code==='PRIVATE_DESKTOP_NOT_RUNNING');
  await desktop('windows.private_desktop.start',{create_shortcut:false});
  assert.equal((await clip('windows.private_clipboard.status',{}) as {data:{hasText:boolean}}).data.hasText,false);
  assert.equal((await clip('windows.private_clipboard.read',{}) as {data:{text:string}}).data.text,'');
  const wiped=await clip('windows.private_clipboard.clear',{}) as {data:{physicalClipboardTouched:boolean}};
  assert.equal(wiped.data.physicalClipboardTouched,false);
});

test('implementation never calls the native Windows clipboard APIs',async()=>{
  const code=await fs.readFile(
    new URL('../src/agent/windows-private-clipboard.ts',import.meta.url),
    'utf8');
  assert.doesNotMatch(code,/\b(?:Get-Clipboard|Set-Clipboard|OpenClipboard|GetClipboardData|SetClipboardData|EmptyClipboard)\b/);
});
