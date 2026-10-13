import test from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { parseWindowsPrivateScreenCaptureRequest as parse } from '../src/agent/windows-private-screen.js';

test('default private screen capture targets ALL connected monitors', () => {
  const input = parse({});
  assert.equal(input.source, 'desktop');
  assert.equal(input.monitor_index, undefined);
  assert.equal(input.monitor_id, undefined);
  assert.equal(input.max_width, 1920);
  assert.equal(input.max_height, 1080);
});

test('select specific monitor using index zero without losing the selector', () => {
  assert.deepEqual(parse({source:'monitor',monitor_index:0}).monitor_index,0);
  assert.equal(parse({source:'monitor',monitor_index:15}).monitor_index,15);
  assert.equal(parse({source:'monitor',monitor_id:'\\\\.\\DISPLAY2'}).monitor_id,'\\\\.\\DISPLAY2');
});

test('cannot silently capture ALL when a requested monitor is missing or ambiguous', () => {
  const cases: unknown[] = [
    {source:'monitor'},
    {source:'monitor',monitor_index:16},
    {source:'monitor',monitor_index:-1},
    {source:'monitor',monitor_index:0,monitor_id:'MON2'},
    {source:'desktop',monitor_index:0},
    {source:'window',hwnd:'0x01',monitor_index:0},
    {source:'monitor',monitor_index:0,hwnd:'0x12'},
    {source:'window'},
    {source:'desktop',hwnd:'0x1234'},
    {source:'monitor',monitor_id:''},
    {source:'monitor',monitor_index:0.5},
  ];
  for(const value of cases) assert.throws(()=>parse(value),ZodError,JSON.stringify(value));
});

test('window source remains explicit and does not permit monitor selection',()=>{
  const parsed=parse({source:'window',hwnd:'0xC0FFEE'});
  assert.equal(parsed.source,'window');
  assert.equal(parsed.hwnd,'0xC0FFEE');
  assert.equal(parsed.monitor_index,undefined);
});
