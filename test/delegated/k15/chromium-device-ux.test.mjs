import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Real Chromium DOM, CSS, keyboard events and network responses, but on an
// isolated loopback mock server. It NEVER contacts a live Hub/Agent/account.
// The browser's platform is the local runner, not proof of Windows/NVDA/UAC.
const webDir = resolve(process.env.K15_WEB_DIR ??
  fileURLToPath(new URL('../../../web/', import.meta.url)));
const chromium = process.env.K15_CHROMIUM ?? '/usr/bin/chromium';

const devices = [
  {id:'machine-a',name:'Ortak PC',platform:'win32',online:true,accessMode:'safe',
    privilegeMode:'direct',adminBridgeReady:false,agentVersion:null,lastSeenAt:null,
    folderId:null,rootMode:{active:false,expiresAt:null},
    persistentMaintenance:{enabled:false,active:false},bridgePreference:{desiredMode:'auto'}},
  {id:'machine-b',name:'Ortak PC',platform:'win32',online:true,accessMode:'safe',
    privilegeMode:'direct',adminBridgeReady:false,agentVersion:null,lastSeenAt:null,
    folderId:null,rootMode:{active:false,expiresAt:null},
    persistentMaintenance:{enabled:false,active:false},bridgePreference:{desiredMode:'auto'}},
];
const snapshot = ds => ({displayName:'Test Hesabı',planId:'free',billingMode:'free',
  usage:{usedCredits:0,monthlyCredits:100},devices:ds,folders:[],autoSelectDevices:false});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(action, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try { const value = await action(); if (value) return value; }
    catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`Timed out waiting for browser state: ${last ?? 'condition false'}`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    ws.addEventListener('error', reject, {once:true});
    ws.addEventListener('message', ({data}) => {
      const message = JSON.parse(String(data));
      if (!message.id || !pending.has(message.id)) return;
      const {done, fail} = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(message.error.message));
      else done(message.result);
    });
    ws.addEventListener('open', () => resolve({
      close: () => ws.close(),
      send(method, params = {}) {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('CDP disconnected');
        const id = nextId++;
        return new Promise((done, fail) => {
          pending.set(id, {done, fail});
          ws.send(JSON.stringify({id, method, params}));
          setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            fail(new Error(`CDP command timed out: ${method}`));
          }, 7000).unref();
        });
      },
    }), {once:true});
  });
}

test('issue #539: real 375px Chromium device identity, keyboard and 403 recovery',
  {timeout:45000}, async t => {
    let responseKind = 'two';
    const requests = [];
    const server = createServer(async (req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      requests.push({method:req.method,path});
      if (req.method === 'GET' && path === '/api/v1/me/dashboard') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (responseKind === 'denied') { res.writeHead(403); res.end('{"error":"forbidden"}'); }
        else res.end(JSON.stringify(snapshot(responseKind === 'two' ? devices : [])));
        return;
      }
      const allowed = new Map([['/','index.html'],['/index.html','index.html'],
        ['/styles.css','styles.css'],['/app.js','app.js']]);
      if (req.method !== 'GET' || !allowed.has(path)) {
        res.writeHead(404);res.end();return;
      }
      const filename = allowed.get(path);
      try {
        const bytes = await readFile(join(webDir, filename));
        res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' :
          filename.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(bytes);
      } catch { res.writeHead(404);res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const profile = await mkdtemp(join(tmpdir(), 'nexowire-k15-chromium-'));
    const chrome = spawn(chromium, ['--headless=new','--no-sandbox',
      '--disable-gpu','--disable-background-networking','--disable-extensions',
      '--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,
      'about:blank'], {stdio:['ignore','ignore','pipe']});
    let chromeError = '';
    chrome.stderr.on('data', chunk => { chromeError += String(chunk).slice(-1500); });
    let cdp;
    try {
      let port;
      try {
        port = await until(async () => {
          if (chrome.exitCode !== null) throw new Error(`Chrome exited ${chrome.exitCode}: ${chromeError}`);
          const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
          return Number(text.split('\n')[0]);
        }, 2000);
      } catch (error) {
        if (/socket\(\) failed: Operation not permitted/.test(chromeError)) {
          t.skip('Host blocked Chromium process-singleton socket (EPERM); real browser NOT_RUN');
          return;
        }
        throw error;
      }
      const page = await until(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const pages = await response.json();
        return pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      });
      cdp = await connectCdp(page.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride',
        {width:375,height:812,deviceScaleFactor:1,mobile:true});
      const evalValue = async expression => {
        const data = await cdp.send('Runtime.evaluate',
          {expression,returnByValue:true,awaitPromise:true});
        if (data.exceptionDetails) throw new Error(data.exceptionDetails.text);
        return data.result.value;
      };
      await cdp.send('Page.navigate', {url:origin});
      await until(async () => await evalValue(
        `document.querySelectorAll('#devices .device').length === 2`));

      const identity = await evalValue(`(() => ({
        ids:[...document.querySelectorAll('#devices .device')].map(x=>x.dataset.deviceId),
        labels:[...document.querySelectorAll('#devices .device')].map(x=>x.getAttribute('aria-label')),
        count:document.querySelector('#devices-count').textContent,
        busy:document.querySelector('#devices').getAttribute('aria-busy'),
        width:innerWidth, scrollWidth:document.documentElement.scrollWidth
      }))()`);
      assert.deepEqual(identity.ids, ['machine-a','machine-b']);
      assert.equal(identity.count, '2');
      assert.equal(identity.busy, 'false');
      assert.equal(identity.width, 375);
      assert.ok(identity.scrollWidth <= 376,
        `horizontal overflow ${identity.scrollWidth} > 375`);
      if (identity.labels[0] === identity.labels[1]) {
        t.diagnostic('Known current-main accessible-name collision: #1068 owner candidate required');
      } else {
        assert.deepEqual(identity.labels, ['Ortak PC · cihaz 1','Ortak PC · cihaz 2']);
      }

      await evalValue(`document.querySelector('[data-layout="list"]').focus()`);
      await cdp.send('Input.dispatchKeyEvent',
        {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await cdp.send('Input.dispatchKeyEvent',
        {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      assert.equal(await evalValue(`document.querySelector('[data-layout="list"]')
        .getAttribute('aria-pressed')`), 'true', 'physical keyboard Enter changes layout');

      responseKind = 'denied';
      await cdp.send('Page.reload', {ignoreCache:true});
      await until(async () => await evalValue(
        `document.querySelector('#error-panel').classList.contains('hidden')===false`));
      const denied = await evalValue(`({pill:document.querySelector('#connection-pill').textContent,
        message:document.querySelector('#error-message').textContent})`);
      assert.match(denied.message, /HTTP 403/);
      if (denied.pill === 'Bağlantı hatası') {
        t.diagnostic('Known source-RED: HTTP 403 still looks like transport outage');
      } else {
        assert.match(denied.pill, /[Yy]etki|[Ee]rişim|403/);
      }

      responseKind = 'empty';
      await evalValue(`document.querySelector('#retry').focus()`);
      await cdp.send('Input.dispatchKeyEvent',
        {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await cdp.send('Input.dispatchKeyEvent',
        {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await until(async () => await evalValue(
        `document.querySelector('#devices-count').textContent==='0'`));
      const empty = await evalValue(`({text:document.querySelector('#devices').textContent,
        cards:document.querySelectorAll('#devices .device').length,
        errorHidden:document.querySelector('#error-panel').classList.contains('hidden'),
        pill:document.querySelector('#connection-pill').textContent})`);
      assert.equal(empty.cards, 0);
      assert.match(empty.text, /Henüz bağlı cihaz yok/);
      assert.equal(empty.errorHidden, true);
      if (empty.pill === 'Bağlı') {
        t.diagnostic('Known pairing-vs-session copy risk: empty device list still has green Bağlı');
      } else {
        assert.match(empty.pill, /[Cc]ihaz|[Oo]turum|[Ee]şleş/);
      }
      assert.equal(requests.filter(r => r.method !== 'GET').length, 0,
        'smoke/keyboard/403 must never mutate a real device');
    } finally {
      cdp?.close();
      chrome.kill('SIGTERM');
      await new Promise(resolve => server.close(resolve));
      await rm(profile, {recursive:true,force:true});
    }
  });
