import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const wf=readFileSync(
  new URL('../.github/workflows/preflight-control-plane-ui-only.yml',import.meta.url),'utf8',
);

test('UI-only preview is manually invoked and pins the previously deployed backend',()=>{
  assert.match(wf,/workflow_dispatch:/);
  assert.doesNotMatch(wf,/\bon:\s*\[?push|\bpush:\s*\n/);
  assert.match(wf,/ref: 6f5863363b4ad25bbecceca5b5c78e8ffdd8fffd/);
  assert.match(wf,/cp ui-source\/web\/app\.js pinned-production\/web\/app\.js/);
  assert.match(wf,/cp ui-source\/web\/styles\.css pinned-production\/web\/styles\.css/);
  assert.match(wf,/node ui-source\/scripts\/preflight-control-plane-ui-only\.mjs pinned-production/);
});

test('preview workflow lacks Cloudflare secrets, deployment, D1 migration or mutation credentials',()=>{
  assert.doesNotMatch(wf,/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|NEXOWIRE_SESSION_SECRET/);
  assert.doesNotMatch(wf,/wrangler\s+(deploy|d1\s+migrations\s+apply)/);
  assert.doesNotMatch(wf,/gh\s+workflow\s+run|curl\s+-X\s+POST/);
  assert.match(wf,/permissions:\s*\n\s*contents: read/);
  assert.match(wf,/PRODUCTION_DEPLOYMENT_PERFORMED=false/);
});
