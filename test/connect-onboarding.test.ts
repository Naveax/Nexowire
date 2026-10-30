import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const source=await readFile('web/connect.js','utf8');
class Element {
  value='';textContent='';href='';disabled=false;tabIndex=0;focused=false;selected=false;
  dataset:Record<string,string>={};
  readonly classes=new Set<string>();
  readonly classList={add:(v:string)=>this.classes.add(v),remove:(v:string)=>this.classes.delete(v),
    toggle:(v:string,force:boolean)=>{if(force)this.classes.add(v);else this.classes.delete(v)}};
  readonly handlers:Record<string,(event?:unknown)=>unknown>={};
  readonly attributes:Record<string,string>={};
  addEventListener(name:string,fn:(event?:unknown)=>unknown){this.handlers[name]=fn}
  setAttribute(name:string,value:string){this.attributes[name]=value}
  focus(){this.focused=true}select(){this.selected=true}
  closest(_selector:string){return this.row??this}
  row?:Element;
}
const origin='https://control.fixture.invalid';
const resource='https://public-hub.fixture.invalid/mcp';
const metadata=()=>({resource,authorization_servers:[origin],scopes_supported:['mcp']});

async function boot(options:{response?:()=>Promise<Response>;clipboardFails?:boolean;search?:string}={}){
  const elements=new Map<string,Element>(),copied:string[]=[],requests:string[]=[];
  const el=(id:string)=>{let node=elements.get(id);if(!node){node=new Element();elements.set(id,node)}return node};
  const tabs=['windows','macos','linux'].map(os=>{const e=new Element();e.dataset.os=os;return e});
  const label=new Element();el('install-command').row=new Element();
  const context=createContext({URL,URLSearchParams,AbortSignal,
    document:{getElementById:el,querySelectorAll:()=>tabs,querySelector:()=>label},
    navigator:{userAgent:'Windows NT 10.0; Win64; x64',clipboard:{writeText:async(value:string)=>{
      if(options.clipboardFails)throw Error('test clipboard unavailable');copied.push(value);
    }}},
    window:{location:{origin,search:options.search??'',pathname:'/connect.html',replace:()=>{
      throw Error('unexpected navigation during read-only setup fixture');
    }}},
    fetch:async(input:string)=>{
      requests.push(input);
      if(input==='/api/v1/me/dashboard')return Response.json({});
      assert.equal(input,'/.well-known/oauth-protected-resource');
      return options.response?options.response():Response.json(metadata());
    },
  });
  runInContext(source,context,{timeout:1000});
  await new Promise<void>(r=>setImmediate(r));await new Promise<void>(r=>setImmediate(r));
  return {el,tabs,label,copied,requests,context};
}

test('first-time Windows onboarding uses the tested Unicode-safe bootstrap and discovers the distinct MCP resource',async()=>{
  const f=await boot();
  assert.equal(f.el('download-installer').href,
    'https://github.com/Naveax/Nexowire/blob/96315d5dd4986fffbd24a96859309271d2a88ffe/installers/Nexowire-Setup.cmd');
  assert.equal(f.el('verify-installer').href,
    'https://github.com/Naveax/Nexowire/blob/96315d5dd4986fffbd24a96859309271d2a88ffe/installers/SHA256SUMS-Windows');
  assert.ok(f.el('install-command').value.includes('https://raw.githubusercontent.com/Naveax/Nexowire/96315d5dd4986fffbd24a96859309271d2a88ffe/installers/Nexowire-Setup.cmd'));
  assert.match(f.el('install-description').textContent,/Download raw/);
  assert.equal(f.el('chatgpt-address').value,resource);
  assert.notEqual(f.el('chatgpt-address').value,origin+'/mcp','login origin is not the MCP data plane');
  assert.equal(f.el('copy-chatgpt-address').disabled,false);
  await f.el('copy-chatgpt-address').handlers.click!();
  assert.deepEqual(f.copied,[resource]);
  assert.deepEqual(f.requests,['/.well-known/oauth-protected-resource']);
});

for(const [name,value] of [
  ['plaintext',{...metadata(),resource:'http://public-hub.fixture.invalid/mcp'}],
  ['loopback',{...metadata(),resource:'https://localhost/mcp'}],
  ['embedded credentials',{...metadata(),resource:'https://user:fixture@public-hub.fixture.invalid/mcp'}],
  ['query credential',{...metadata(),resource:resource+'?access_token=fixture'}],
  ['fragment',{...metadata(),resource:resource+'#fixture'}],
  ['other login authority',{...metadata(),authorization_servers:['https://other.fixture.invalid']}],
  ['absent resource',{authorization_servers:[origin]}],
] as const){
  test('onboarding never offers a guessed MCP address when metadata contains '+name,async()=>{
    const f=await boot({response:async()=>Response.json(value)});
    assert.equal(f.el('chatgpt-address').value,'');
    assert.equal(f.el('copy-chatgpt-address').disabled,true);
    await f.el('copy-chatgpt-address').handlers.click!();assert.deepEqual(f.copied,[]);
    assert.match(f.el('chatgpt-status').textContent,/alınamadı/);
  });
}

test('service denial, HTML error page and timeout remain visible setup failures',async()=>{
  for(const response of [async()=>Response.json({error:'fixture access denied'},{status:403}),
    async()=>new Response('<html>access denied</html>',{headers:{'content-type':'text/html'}}),
    async()=>{throw Error('fixture request deadline')}]){
    const f=await boot({response});assert.equal(f.el('copy-chatgpt-address').disabled,true);
    assert.equal(f.el('chatgpt-address').value,'');assert.match(f.el('chatgpt-status').textContent,/alınamadı/);
  }
  const denied=await boot({response:async()=>Response.json({error:'fixture'},{status:403})});
  assert.match(denied.el('chatgpt-status').textContent,/HTTP 403/);
});

test('clipboard denial selects only the public MCP address for manual copying',async()=>{
  const f=await boot({clipboardFails:true});await f.el('copy-chatgpt-address').handlers.click!();
  assert.equal(f.el('chatgpt-address').focused,true);assert.equal(f.el('chatgpt-address').selected,true);
  assert.match(f.el('chatgpt-status').textContent,/Ctrl\+C/);
});

test('macOS and Linux are not promised an automatic Windows-DPAPI connect flow',async()=>{
  const f=await boot();
  for(const os of ['macos','linux']){
    const tab=f.tabs.find(t=>t.dataset.os===os)!;await tab.handlers.click!();
    assert.equal(f.el('install-command').value,'');
    assert.equal(f.el('install-command').row!.classes.has('hidden'),true);
    assert.equal(f.label.classes.has('hidden'),true);
    assert.match(f.el('download-installer').href,/\/docs\/SELF_HOST\.md$/);
  }
  await f.tabs[0]!.handlers.click!();assert.equal(f.el('install-command').row!.classes.has('hidden'),false);
  assert.match(f.el('download-installer').href,/Nexowire-Setup\.cmd$/);
});

test('a genuine local pairing request retains its single BAĞLA step without loading plugin setup',async()=>{
  const query=new URLSearchParams({callback:'http://127.0.0.1:49876/nexowire-connect',state:'a'.repeat(43),
    deviceId:'fixture-device-0001',deviceName:'Fresh PC',platform:'win32'});
  const f=await boot({search:'?'+query.toString()});
  assert.equal(f.el('chatgpt-panel').classes.has('hidden'),true);
  assert.equal(f.el('approve').disabled,false);
  assert.deepEqual(f.requests,['/api/v1/me/dashboard']);
});
