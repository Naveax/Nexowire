import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserControlError,isTransientNavigationReadinessTimeout}
  from '../src/agent/browser-manager.js';

test('navigation may retry only a read-only Runtime.evaluate timeout',()=>{
  assert.equal(isTransientNavigationReadinessTimeout(
    new BrowserControlError('CDP_REQUEST_TIMEOUT','Timeout',{
      method:'Runtime.evaluate',timeoutMs:5_000,
    })),true);
});

test('never retry mutating operations, target loss, protocol failures or arbitrary errors',()=>{
  for(const error of [
    new BrowserControlError('CDP_REQUEST_TIMEOUT','Timeout',{method:'Page.navigate'}),
    new BrowserControlError('CDP_REQUEST_TIMEOUT','Timeout',{method:'Input.dispatchMouseEvent'}),
    new BrowserControlError('CDP_REQUEST_TIMEOUT','Timeout'),
    new BrowserControlError('CDP_DISCONNECTED','Disconnected'),
    new BrowserControlError('CDP_ERROR','Page closed',{method:'Runtime.evaluate'}),
    new Error('Timeout'),
    null,
    {},
  ])assert.equal(isTransientNavigationReadinessTimeout(error),false);
});
