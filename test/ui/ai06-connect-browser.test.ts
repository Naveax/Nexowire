import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import WebSocket from 'ws';

// This is an isolated Chromium-rendered acceptance of the actual checkout.
// Ubuntu CI must exercise it; outside CI it is opt-in. No real OAuth,
// account, Agent, Windows permission, installed CORE or Broker is touched.
const enabled=process.platform==='linux'&&(
  process.env.GITHUB_ACTIONS==='true'||Boolean(process.env.NEXOWIRE_AI06_BROWSER));
const deviceId='ai06-browser-fixture';
const fixtureState='s'.repeat(43);
const sentinel='AI06_PRIVATE_UPSTREAM_SENTINEL';

type Pending={resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
function cdp(ws:WebSocket){
  let sequence=0;
  const pending=new Map<number,Pending>();
  ws.on('message',data=>{
    const msg=JSON.parse(data.toString()) as {id?:number;result?:unknown;error?:{message?:string}};
    if(msg.id===undefined)return;
    const item=pending.get(msg.id);
    if(!item)return;
    pending.delete(msg.id);
    clearTimeout(item.timer);
    if(msg.error)item.reject(Error(msg.error.message??'CDP error'));
    else item.resolve(msg.result);
  });
  ws.on('close',()=>{
    for(const item of pending.values()){
      clearTimeout(item.timer);
      item.reject(Error('CDP session closed'));
    }
    pending.clear();
  });
  return function send<T=unknown>(method:string,params:Record<string,unknown>={}):Promise<T>{
    const id=++sequence;
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{
        pending.delete(id);
        reject(Error('CDP timeout: '+method));
      },10_000);
      pending.set(id,{resolve:value=>resolve(value as T),reject,timer});
      ws.send(JSON.stringify({id,method,params}),error=>{
        if(error){
          clearTimeout(timer);pending.delete(id);reject(error);
        }
      });
    });
  };
}

async function until<T>(label:string,read:()=>Promise<T>,accept:(value:T)=>boolean):Promise<T>{
  const deadline=Date.now()+10_000;
  let last:unknown;
  while(Date.now()<deadline){
    try{const value=await read();if(accept(value))return value;last=value}
    catch(error){last=error instanceof Error?error.message:String(error)}
    await delay(75);
  }
  throw Error(label+' timeout; last='+JSON.stringify(last));
}

test('AI-06 real Chromium: connect UI layout, keyboard, media and uncertain pairing', {
  skip:enabled?false:'Linux Chromium CI or NEXOWIRE_AI06_BROWSER opt-in required',
  timeout:180_000,
},async t=>{
  const browser=[process.env.NEXOWIRE_AI06_BROWSER,process.env.CHROME_BIN,'/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser']
    .find((candidate):candidate is string=>Boolean(candidate&&existsSync(candidate)));
  assert.ok(browser,'Chromium executable is required in Linux hosted CI; never treat absence as PASS');
  const files=new Map([
    ['/connect.html',{mime:'text/html; charset=utf-8',body:readFileSync('web/connect.html')}],
    ['/connect.js',{mime:'text/javascript; charset=utf-8',body:readFileSync('web/connect.js')}],
    ['/index.html',{mime:'text/html; charset=utf-8',body:readFileSync('web/index.html')}],
    ['/app.js',{mime:'text/javascript; charset=utf-8',body:readFileSync('web/app.js')}],
    ['/styles.css',{mime:'text/css; charset=utf-8',body:readFileSync('web/styles.css')}],
  ]);
  let requests=0;
  const pairingMutationIds:string[]=[];
  const coreMutationIds:string[]=[];
  let releasePairing!:()=>void;
  const pairingResponseGate=new Promise<void>(resolve=>{releasePairing=resolve});
  let offline=false;
  let dashboardMode=false;
  let coreEnabled=true;
  let enrollmentPending=false;
  let coreRevision=7;
  const mutationReceipts=new Map<string,unknown>();
  let remoteAuthorizationState:'ACTIVE'|'REVOKED'='ACTIVE';
  let remoteAuthorizationEpoch=7;
  let remoteObservedAtMs:number|null=null;
  let releaseConsent!:()=>void;
  const consentResponseGate=new Promise<void>(resolve=>{releaseConsent=resolve});
  const corePosts:{route:string;body:unknown;confirm:string|undefined}[]=[];
  const server=createServer((req,res)=>{
    const route=new URL(req.url??'/','http://127.0.0.1').pathname;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    if(req.method==='GET'&&files.has(route)){
      const asset=files.get(route)!;
      res.writeHead(200,{'content-type':asset.mime});res.end(asset.body);return;
    }
    if(req.method==='GET'&&route==='/.well-known/oauth-protected-resource'){
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({resource:'https://fixture.invalid/mcp',authorization_servers:['http://'+req.headers.host]}));
      return;
    }
    if(req.method==='GET'&&route==='/api/v1/me/mutations/status'){
      const id=new URL(req.url??'/','http://127.0.0.1').searchParams.get('mutationId')??'';
      const receipt=mutationReceipts.get(id);
      res.writeHead(receipt?200:404,{'content-type':'application/json'});
      res.end(JSON.stringify(receipt??{error:'MUTATION_NOT_FOUND'}));return;
    }
    if(req.method==='GET'&&route==='/api/v1/me/dashboard'){
      res.writeHead(200,{'content-type':'application/json'});
      if(dashboardMode){
        res.end(JSON.stringify({accountId:'fixture-owner',displayName:'Fixture owner',planId:'free',
          billingMode:'free',usage:{usedCredits:0,monthlyCredits:1000,prepaidCredits:null},
          folders:[],autoSelectDevices:false,devices:[{
            id:deviceId,name:'Fixture device',platform:'win32',online:true,accessMode:'full',
            privilegeMode:'broker',adminBridgeReady:true,agentVersion:'1.0.8',
            rootMode:{active:false,expiresAt:null},bridgePreference:{desiredMode:'auto',applied:false},
            persistentMaintenance:{enabled:coreEnabled,active:false},coreMutationRevision:coreRevision,
            coreRevocation:{version:1,source:'D1_REMOTE_AUTHORIZATION',
              remoteAuthorization:{state:remoteAuthorizationState,authorizationEpoch:remoteAuthorizationEpoch,
                observedAtMs:remoteObservedAtMs??Date.now()},
              localStop:'UNKNOWN',pendingRevoke:'UNKNOWN',nativeDrain:'UNKNOWN',effectReadback:'UNKNOWN',nativeEvidence:'NOT_AVAILABLE'},
            physicalConsole:{active:false,localEnrolled:false,deviceReady:true,
              enrollmentRequested:enrollmentPending,observedAtMs:null},
          }]}));return;
      }
      res.end(JSON.stringify({corePhysicalStatusVerifierInstalled:true,devices:[{
        id:deviceId,platform:'win32',online:!offline,accessMode:'full',
        privilegeMode:'broker',adminBridgeReady:true,persistentMaintenance:{enabled:true},
        physicalConsole:{active:true,localEnrolled:true,deviceReady:true,observedAtMs:Date.now()},
      }]}));return;
    }
    if(req.method==='POST'&&route==='/api/v1/pairing'){
      requests++;req.resume();
      const id=req.headers['x-nexowire-mutation-id'];
      pairingMutationIds.push(typeof id==='string'?id:'');
      void pairingResponseGate.then(()=>{
        res.writeHead(503,{'content-type':'application/json'});
        res.end(JSON.stringify({error:sentinel}));
      });return;
    }
    if(req.method==='POST'&&dashboardMode&&
        (route==='/api/v1/me/devices/core-enrollment-request'||route==='/api/v1/me/devices/core-preference')){
      let raw='';
      req.setEncoding('utf8');
      req.on('data',(chunk:string)=>{raw+=chunk;if(raw.length>4096)req.destroy()});
      req.on('end',async()=>{
        let body:{deviceId?:string;enabled?:boolean;expectedRevision?:number};
        try{body=JSON.parse(raw)}catch{res.writeHead(400);res.end();return}
        const confirm=req.headers['x-nexowire-confirm'];
        const mutationId=req.headers['x-nexowire-mutation-id'];
        coreMutationIds.push(typeof mutationId==='string'?mutationId:'');
        corePosts.push({route,body,confirm:typeof confirm==='string'?confirm:undefined});
        if(body.deviceId!==deviceId||typeof mutationId!=='string'||body.expectedRevision!==coreRevision){res.writeHead(409);res.end();return}
        if(route.endsWith('/core-enrollment-request')){
          await consentResponseGate;
          res.writeHead(503,{'content-type':'application/json'});
          res.end(JSON.stringify({error:sentinel}));return;
        }
        if(body.enabled!==false){res.writeHead(400);res.end();return}
        coreEnabled=false;enrollmentPending=false;coreRevision++;
        mutationReceipts.set(mutationId,{mutationId,deviceId,kind:'core-disable',state:'APPLIED',expectedRevision:body.expectedRevision});
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({deviceId,mutationId,persistentMaintenance:{enabled:false,active:false,updatedAt:new Date().toISOString()}}));
      });return;
    }
    res.writeHead(404);res.end();
  });
  const root=await mkdtemp(join(tmpdir(),'nw-ai06-chromium-'));
  let ws:WebSocket|undefined;
  let secondWs:WebSocket|undefined;
  let child:ReturnType<typeof spawn>|undefined;
  t.after(async()=>{
    releaseConsent();releasePairing();
    if(secondWs){secondWs.terminate();secondWs=undefined}
    if(ws){ws.terminate();ws=undefined}
    if(child&&child.exitCode===null&&child.signalCode===null){
      child.kill('SIGTERM');
      const deadline=Date.now()+3000;
      while(child.exitCode===null&&child.signalCode===null&&Date.now()<deadline)await delay(50);
      if(child.exitCode===null&&child.signalCode===null){
        child.kill('SIGKILL');
        await until('owned Chromium shutdown',async()=>child!.exitCode!==null||child!.signalCode!==null,Boolean);
      }
    }
    server.closeAllConnections();
    if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  const address=server.address();
  assert.ok(address&&typeof address==='object');
  const origin='http://127.0.0.1:'+address.port;
  // Disposable headless browser only; no existing profile or production URL.
  // CI Chrome needs its own sandbox-compatible runner configuration; --no-sandbox
  // is limited to this ephemeral fixture process, not a system/browser setting.
  child=spawn(browser,[
    '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run',
    '--no-default-browser-check','--disable-background-networking','--disable-sync',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
    '--user-data-dir='+root,'about:blank',
  ],{stdio:['ignore','ignore','pipe']});
  let launchError:Error|undefined;
  let stderr='';
  let reportedPort=0;
  child.on('error',error=>{launchError=error});
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data',(chunk:string)=>{
    // Only diagnostic output from this disposable process; keep a bounded tail.
    stderr=(stderr+chunk).slice(-8192);
    const match=stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[a-f0-9-]+/i);
    if(match)reportedPort=Number(match[1]);
  });
  const validPort=(value:number)=>Number.isInteger(value)&&value>0&&value<=65535;
  // CI starts this test alongside many other Node tests. Allow bounded cold
  // startup and observe both supported readiness channels of the owned process.
  // A renderer or functional failure is never retried or considered a skip.
  const startupDeadline=Date.now()+45_000;
  let port=0;
  while(Date.now()<startupDeadline){
    if(launchError)throw launchError;
    if(child.exitCode!==null||child.signalCode!==null)
      throw Error('Chromium startup exited: '+child.exitCode+'/'+child.signalCode+'\n'+stderr);
    let filePort=0;
    try{
      filePort=Number((await readFile(join(root,'DevToolsActivePort'),'utf8')).split('\n')[0]);
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    }
    if(validPort(filePort)&&validPort(reportedPort))
      assert.equal(filePort,reportedPort,'Chromium readiness channels disagree');
    const candidate=validPort(filePort)?filePort:reportedPort;
    if(validPort(candidate)){
      try{
        const probe=await fetch('http://127.0.0.1:'+candidate+'/json/version',{signal:AbortSignal.timeout(1000)});
        if(probe.ok){
          const version=await probe.json() as {webSocketDebuggerUrl?:string;Browser?:string};
          if(version.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:'+candidate+'/devtools/browser/')
            && typeof version.Browser==='string'){
            port=candidate;break;
          }
        }
      }catch{/* The owned DevTools listener may still be starting. */}
    }
    await delay(100);
  }
  assert.ok(validPort(port),'Chromium DevTools startup timed out (45s); executable='+browser+'\n'+stderr);
  t.diagnostic('Chromium DevTools ready on owned loopback port; executable='+browser);
  const target=await until('page target',async()=>{
    const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(2000)});
    const pages=await response.json() as Array<{type:string;webSocketDebuggerUrl?:string}>;
    return pages.find(page=>page.type==='page')?.webSocketDebuggerUrl??'';
  },value=>value.startsWith('ws://127.0.0.1:'));
  ws=new WebSocket(target);
  await new Promise<void>((resolve,reject)=>{ws!.once('open',resolve);ws!.once('error',reject)});
  const send=cdp(ws);
  const evaluate=async<T>(expression:string):Promise<T>=>{
    const response=await send<{result:{value?:T;description?:string};exceptionDetails?:unknown}>(
      'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    assert.equal(response.exceptionDetails,undefined,'DOM evaluation failed: '+expression);
    return response.result.value as T;
  };
  const openSecond=async(url:string)=>{
    const secondTarget=await send<{targetId:string}>('Target.createTarget',{url});
    const secondUrl=await until('second page CDP',async()=>{
      const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(2000)});
      const pages=await response.json() as Array<{id:string;webSocketDebuggerUrl?:string}>;
      return pages.find(page=>page.id===secondTarget.targetId)?.webSocketDebuggerUrl??'';
    },value=>value.startsWith('ws://127.0.0.1:'));
    secondWs=new WebSocket(secondUrl);
    await new Promise<void>((resolve,reject)=>{secondWs!.once('open',resolve);secondWs!.once('error',reject)});
    const secondSend=cdp(secondWs);
    const secondEvaluate=async<T>(expression:string):Promise<T>=>{
      const response=await secondSend<{result:{value?:T};exceptionDetails?:unknown}>(
        'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      assert.equal(response.exceptionDetails,undefined,'second tab evaluation failed');
      return response.result.value as T;
    };
    return {evaluate:secondEvaluate,close:async()=>{secondWs?.terminate();secondWs=undefined;await send('Target.closeTarget',{targetId:secondTarget.targetId})}};
  };
  const nav=async(url:string)=>{
    const response=await send<{errorText?:string}>('Page.navigate',{url});
    assert.equal(response.errorText,undefined);
    await until('loaded current page',()=>evaluate<boolean>('location.href==='+JSON.stringify(url)+' && document.readyState==="complete"'),Boolean);
  };
  const key=async(value:string,code:string,keyCode:number)=>{
    const params={key:value,code,windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode};
    // CDP rawKeyDown + keyUp alone omits the Enter keypress/default button
    // activation. Reproduced in real Chromium: zero clicks with rawKeyDown,
    // exactly one with keyDown carrying CR. Navigation keys need no text.
    if(value==='Enter'){
      await send('Input.dispatchKeyEvent',{...params,type:'keyDown',text:'\r',unmodifiedText:'\r'});
    }else{
      await send('Input.dispatchKeyEvent',{...params,type:'rawKeyDown'});
    }
    await send('Input.dispatchKeyEvent',{...params,type:'keyUp'});
  };
  const setMedia=()=>send('Emulation.setEmulatedMedia',{features:[
    {name:'prefers-reduced-motion',value:'reduce'},{name:'forced-colors',value:'active'},
  ]});
  const layout=async(label:string)=>{
    // CSS viewport widths at 640 and 320 also exercise 1280px at 200/400%
    // reflow equivalents; these are not literal browser UI zoom operations.
    for(const width of [768,640,375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const result=await evaluate<{width:number;scroll:number;visible:boolean;reduced:boolean;forced:boolean;animation:string;statusOverflow:boolean}>(
        '(()=>{const panel=document.querySelector("#core-state-panel"),code=document.querySelector("#core-status-code");'+
        'return {width:innerWidth,scroll:document.documentElement.scrollWidth,visible:panel.getBoundingClientRect().width>0,'+
        'reduced:matchMedia("(prefers-reduced-motion: reduce)").matches,forced:matchMedia("(forced-colors: active)").matches,'+
        'animation:getComputedStyle(panel).animationName,statusOverflow:code.scrollWidth>code.clientWidth+1}})()');
      assert.equal(result.width,width,label);
      assert.ok(result.scroll<=width+1,label+' horizontal overflow at '+width+': '+JSON.stringify(result));
      assert.equal(result.visible,true,label);
      assert.equal(result.reduced,true,label);
      assert.equal(result.forced,true,label);
      assert.equal(result.animation,'none',label);
      assert.equal(result.statusOverflow,false,label+' truncated status at '+width);
    }
  };

  await send('Page.enable');
  await setMedia();
  await nav(origin+'/connect.html');
  await until('installer initialized',()=>evaluate<string>('document.querySelector("#install-heading").textContent'),value=>value.includes('kurulumu'));
  await layout('install');
  assert.equal(await evaluate<string>('document.querySelector("#core-status-code").textContent'),'UNKNOWN');
  // Seed focus on selected OS tab; dispatch real keyboard events, not DOM clicks.
  await evaluate('document.querySelector("[role=tab][aria-selected=true]").focus()');
  await key('Home','Home',36);
  assert.equal(await evaluate<string>('document.activeElement.id'),'tab-windows');
  await key('ArrowRight','ArrowRight',39);
  assert.equal(await evaluate<string>('document.activeElement.id'),'tab-macos');
  assert.equal(await evaluate<string>('document.querySelector("#tab-macos").getAttribute("aria-selected")'),'true');
  await key('End','End',35);
  assert.equal(await evaluate<string>('document.activeElement.id'),'tab-linux');
  await key('ArrowLeft','ArrowLeft',37);
  assert.equal(await evaluate<string>('document.activeElement.id'),'tab-macos');

  const query=new URLSearchParams({callback:origin+'/nexowire-connect',state:fixtureState,
    deviceId,deviceName:'İzole test cihazı',platform:'win32'});
  const pairingUrl=origin+'/connect.html?'+query;
  await nav(pairingUrl);
  await until('account pairing ready',()=>evaluate<string>('document.querySelector("#status-title").textContent'),value=>value==='Eşleştirmeye hazır');
  assert.equal(await evaluate<string>('document.querySelector("#core-status-code").textContent'),'BROKER_RUNNING_BUT_UNVERIFIED');
  await layout('pairing');
  assert.equal(await evaluate<number>('document.querySelectorAll("#core-state-panel [aria-live=polite]").length'),1);
  const pairingTab=await openSecond(pairingUrl);
  await until('second pairing tab ready',()=>pairingTab.evaluate<string>('document.querySelector("#status-title")?.textContent??""'),value=>value==='Eşleştirmeye hazır');
  await send('Page.bringToFront');
  await evaluate('document.querySelector("#approve").focus()');
  assert.equal(await evaluate<string>('document.activeElement.id'),'approve');
  assert.equal(await evaluate<boolean>('document.querySelector("#approve").disabled'),false);
  await key('Enter','Enter',13);
  // Separate driver activation from the error rendering assertion, so a
  // missing keyboard event cannot be mistaken for a failed HTTP response.
  await until('keyboard activated pairing POST',async()=>requests,value=>value>=1);
  const expectedPairingId='pairing-v1:'+createHash('sha256').update('nexowire-pairing-v1\u0000'+fixtureState).digest('hex');
  assert.deepEqual(pairingMutationIds,[expectedPairingId]);
  await pairingTab.evaluate('document.querySelector("#approve").dispatchEvent(new Event("click"))');
  await until('stale pairing tab denied',()=>pairingTab.evaluate<string>('document.querySelector("#status-title").textContent'),value=>value==='Bağlantı durduruldu');
  assert.equal(requests,1);
  await pairingTab.close();
  await send('Page.bringToFront');
  releasePairing();
  await until('uncertain pairing result',()=>evaluate<string>('document.querySelector("#error-message").textContent'),value=>value.includes('HTTP 503'));
  assert.equal(requests,1);
  assert.equal(await evaluate<boolean>('document.querySelector("#approve").disabled'),true);
  assert.equal(await evaluate<string>('document.activeElement.id'),'error-panel');
  assert.equal(await evaluate<boolean>('document.body.innerText.includes('+JSON.stringify(sentinel)+')'),false);
  assert.equal(await evaluate<string>('location.href'),pairingUrl);
  await key('Enter','Enter',13);
  assert.equal(requests,1);
  await layout('503 error');
  const shot=await send<{data:string}>('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  const png=Buffer.from(shot.data,'base64');
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  t.diagnostic('Synthetic connect screenshot SHA256 '+createHash('sha256').update(png).digest('hex'));

  await evaluate('globalThis.__ai06PairingBeforeReload=true');
  await send('Page.reload',{ignoreCache:true});
  await until('new pairing document',()=>evaluate<boolean>('!globalThis.__ai06PairingBeforeReload&&document.readyState==="complete"'),Boolean);
  await until('pairing reload blocked',()=>evaluate<string>('document.querySelector("#status-title").textContent'),value=>value==='Bağlantı durduruldu');
  assert.equal(await evaluate<boolean>('document.querySelector("#approve").disabled'),true);
  assert.equal(requests,1);
  // A genuinely new local session is distinct; offline CORE still UNKNOWN.
  offline=true;
  query.set('state','n'.repeat(43));
  await nav(origin+'/connect.html?'+query);
  await until('offline dashboard ready',()=>evaluate<string>('document.querySelector("#status-title").textContent'),value=>value==='Eşleştirmeye hazır');
  assert.equal(await evaluate<string>('document.querySelector("#core-status-code").textContent'),'UNKNOWN');
  assert.equal(requests,1);

  // Exercise the actual dashboard UI against the production-shaped contract,
  // not a separate sample HTML or a claimed native Windows effect.
  dashboardMode=true;
  await send('Emulation.setDeviceMetricsOverride',{width:768,height:850,deviceScaleFactor:1,mobile:false});
  await nav(origin+'/index.html');
  const coreCopy=()=>evaluate<string>('document.querySelector(".core-copy")?.textContent??""');
  await until('dashboard CORE eligible',coreCopy,value=>value.includes('ilk yerel onay henüz yok'));
  assert.equal(await evaluate<boolean>('isSecureContext&&typeof navigator.locks?.request==="function"'),true);
  // Real second Chromium target in the same browser profile/origin, with a
  // separately loaded JS module and intentionally stale eligible dashboard.
  const second=await openSecond(origin+'/index.html');
  const secondEvaluate=second.evaluate;
  const secondCopy=()=>secondEvaluate<string>('document.querySelector(".core-copy")?.textContent??""');
  await until('second tab eligible',secondCopy,value=>value.includes('ilk yerel onay henüz yok'));
  await send('Page.bringToFront');
  const activate=async(selector:string)=>{
    await evaluate('document.querySelector('+JSON.stringify(selector)+').focus()');
    assert.equal(await evaluate<boolean>('document.activeElement.matches('+JSON.stringify(selector)+')'),true);
    await key('Enter','Enter',13);
  };
  await activate('.core-shortcut');
  assert.equal(await evaluate<boolean>('document.querySelector(".core-enrollment-retry").hidden'),false);
  await activate('.core-enrollment-retry');
  await until('dashboard consent POST',async()=>corePosts.length,value=>value>=1);
  // The first POST has crossed the HTTP boundary and its response is held.
  // A separately loaded tab cannot submit an old eligible card.
  const fenceCount=()=>evaluate<number>('Object.keys(localStorage).filter(k=>k.startsWith("nexowire-core-uncertain-v1:")).length');
  assert.equal(await fenceCount(),1,'durable marker exists before POST ACK');
  await secondEvaluate('document.querySelector(".core-enrollment-retry").dispatchEvent(new Event("click"))');
  await delay(150);
  assert.equal(corePosts.length,1,'cross-tab attempt must not create another POST');
  releaseConsent();
  await until('dashboard uncertain readback',coreCopy,value=>value.includes('sonucu belirsiz'));
  assert.equal(corePosts.length,1);
  assert.deepEqual(corePosts[0],{route:'/api/v1/me/devices/core-enrollment-request',
    body:{deviceId,expectedRevision:7},confirm:'core-enrollment-request-v1'});
  assert.equal(await evaluate<boolean>('document.querySelector(".core-enrollment-retry").hidden'),true);
  assert.equal(await evaluate<boolean>('document.querySelector(".core-enrollment-retry").disabled'),true);
  assert.equal(await evaluate<boolean>('document.body.innerText.includes('+JSON.stringify(sentinel)+')'),false);
  // Reload destroys the original module/Map; the same-origin marker survives.
  await evaluate('globalThis.__ai06BeforeReload=true');
  await send('Page.reload',{ignoreCache:true});
  await until('new document after reload',()=>evaluate<boolean>('!globalThis.__ai06BeforeReload&&document.readyState==="complete"'),Boolean);
  await until('reload retains uncertain CORE',coreCopy,value=>value.includes('sonucu belirsiz'));
  assert.equal(await fenceCount(),1);
  assert.equal(await evaluate<boolean>('document.querySelector(".core-enrollment-retry").disabled'),true);
  await evaluate('document.querySelector(".core-enrollment-retry").dispatchEvent(new Event("click"))');
  await delay(100);
  assert.equal(corePosts.length,1);
  await activate('.core-shortcut');
  // Refreshing an unchanged dashboard is not proof of non-execution.
  await activate('.core-readback');
  await until('unchanged GET preserves uncertain state',coreCopy,value=>value.includes('sonucu belirsiz'));
  assert.equal(corePosts.length,1);
  // The later owner-bound backend GET reports the request recorded.
  enrollmentPending=true;coreRevision=8;
  await activate('.core-readback');
  await until('boolean alone is not receipt',coreCopy,value=>value.includes('sonucu belirsiz'));
  assert.equal(await fenceCount(),1);
  mutationReceipts.set(coreMutationIds[0]!,{mutationId:coreMutationIds[0],deviceId,
    kind:'core-consent',state:'APPLIED',expectedRevision:7});
  await activate('.core-readback');
  await until('pending readback',coreCopy,value=>value.includes('sunucuda kayıtlı'));
  assert.match(await coreCopy(),/teslimi.*doğrulanmadı/);
  assert.equal(await evaluate<boolean>('document.querySelector(".core-enrollment-retry").hidden'),true);
  assert.equal(await evaluate<boolean>('document.querySelector(".core-toggle").disabled'),false);
  assert.equal(await fenceCount(),0,'exact terminal receipt and newer revision reconcile marker');
  assert.match(await coreCopy(),/APPLIED \(yalnız veritabanı yazımı\)/);
  // Second tab still has the original card. Its locked fresh GET must deny the
  // stale consent even after another tab reconciles the marker.
  await secondEvaluate('document.querySelector(".core-enrollment-retry").dispatchEvent(new Event("click"))');
  await until('stale second tab receives pending GET',secondCopy,value=>value.includes('sunucuda kayıtlı'));
  assert.equal(corePosts.length,1);
  await second.close();
  await activate('.core-toggle');
  await until('dashboard preference OFF readback',coreCopy,value=>value.includes('hesap tercihini kapalı bildiriyor'));
  assert.equal(corePosts.length,2);
  assert.deepEqual(corePosts[1],{route:'/api/v1/me/devices/core-preference',body:{deviceId,enabled:false,expectedRevision:8},confirm:undefined});
  assert.equal(coreMutationIds.length,2);
  assert.ok(coreMutationIds.every(id=>/^core-v1:[0-9a-f-]{36}$/.test(id)));
  assert.notEqual(coreMutationIds[0],coreMutationIds[1]);
  assert.match(await coreCopy(),/yerel STOP.*kanıtı değildir/);
  assert.equal(await fenceCount(),0);
  assert.match(await coreCopy(),/APPLIED \(yalnız veritabanı yazımı\)/);
  assert.equal(await evaluate<string>('document.querySelector(".core-shortcut").textContent'),'CORE');
  // Exact AI-03 #1330 v1 shape. Preference OFF does not imply remote revoke.
  assert.match(await coreCopy(),/ACTIVE \(epoch 7\)/);
  remoteAuthorizationState='REVOKED';remoteAuthorizationEpoch=8;
  await activate('.core-readback');
  await until('D1 remote revoke readback',coreCopy,value=>value.includes('REVOKED (epoch 8)'));
  assert.match(await coreCopy(),/yerel STOP veya drain kanıtı değildir/);
  assert.equal(corePosts.length,2,'readback must not dispatch a remote mutation');
  // A near-expiry backend observation must expire on the already rendered card.
  remoteObservedAtMs=Date.now()-14000;
  await activate('.core-readback');
  await until('D1 readback expired',coreCopy,value=>value.includes('Uzaktan yetki kaydı: UNKNOWN'));
  assert.doesNotMatch(await coreCopy(),/REVOKED \(epoch/);
  assert.equal(corePosts.length,2);
  t.diagnostic('Pairing real Chromium: same local intent across tab/reload denied, stable opaque mutation identity; new local intent allowed');
  t.diagnostic('AI-03 v1 real Chromium: D1 ACTIVE/REVOKED epoch, expired UNKNOWN, no local STOP or drain proof');
  t.diagnostic('Dashboard real Chromium: cross-tab and reload no replay, stale-card preflight GET, one consent POST, one explicit OFF POST, no native STOP assertion');
});
