import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyUiOnlyRelease,
  PINNED_BACKEND_COMMIT,
  UI_ONLY_FILES,
} from '../scripts/preflight-control-plane-ui-only.mjs';

function fixture() {
  const baseline={
    'web/app.js':Buffer.from("const api='/api/v1/me/dashboard'; const old=true;"),
    'web/styles.css':Buffer.from('.existing{color:white}'),
  };
  const candidate={
    'web/app.js':Buffer.from("const api='/api/v1/me/dashboard'; const newer=true; const control='bridge-quick-toggle bridge-toggle';"),
    'web/styles.css':Buffer.from('.existing{color:white}.bridge-toggle{display:flex}'),
  };
  return {
    backendSha:PINNED_BACKEND_COMMIT,
    modifiedPaths:[...UI_ONLY_FILES],
    baseline,candidate,
    live:{...baseline},
  };
}

test('only expected UI files change and live bytes match pinned baseline',()=>{
  const ok=verifyUiOnlyRelease(fixture());
  assert.equal(ok.productionDeploymentPerformed,false);
  assert.equal(ok.liveBaselineMatched,true);
  assert.equal(ok.backendRuntimeAttested,false);
  assert.deepEqual(ok.newApiRoutes,[]);
  assert.equal(ok.files.length,2);
  for(const f of ok.files) {
    assert.match(f.oldSha256,/^[a-f0-9]{64}$/);
    assert.match(f.newSha256,/^[a-f0-9]{64}$/);
    assert.notEqual(f.oldSha256,f.newSha256);
  }
});

test('reject any non-UI file, missing expected file or changed backend commit',()=>{
  assert.throws(()=>verifyUiOnlyRelease({
    ...fixture(),modifiedPaths:['web/app.js','cloudflare/worker.js'],
  }),/UI_ONLY_UNEXPECTED_FILE_CHANGES/);
  assert.throws(()=>verifyUiOnlyRelease({
    ...fixture(),modifiedPaths:['web/app.js','web/styles.css','cloudflare/migrations/0018_guardian_enrollment_challenges.sql'],
  }),/UI_ONLY_UNEXPECTED_FILE_CHANGES/);
  assert.throws(()=>verifyUiOnlyRelease({
    ...fixture(),backendSha:'8b1654c1f8b4b37441ef66302acfe99eaf478d10',
  }),/UI_ONLY_BACKEND_COMMIT_CHANGED/);
});

test('reject stale or incorrectly decoded live UTF-8 bytes',()=>{
  const f=fixture();
  assert.throws(()=>verifyUiOnlyRelease({
    ...f,live:{...f.live,'web/app.js':Buffer.from('BAD-CACHED-JS')},
  }),/UI_ONLY_LIVE_BASELINE_MISMATCH:web\/app.js/);
  const other=fixture();
  assert.throws(()=>verifyUiOnlyRelease({
    ...other,live:{...other.live,'web/styles.css':Buffer.from('wrong-css')},
  }),/UI_ONLY_LIVE_BASELINE_MISMATCH:web\/styles.css/);
});

test('never allow an additional backend endpoint in UI-only release',()=>{
  const f=fixture();
  f.candidate['web/app.js']=Buffer.from(
    f.candidate['web/app.js'].toString()+
      "\nconst extra='/api/v1/internal/device/bridge-command/receipt';",
  );
  assert.throws(()=>verifyUiOnlyRelease(f),
    /UI_ONLY_NEW_BACKEND_API_REQUIRED/);
});

test('reject no-op assets, oversized payloads and missing ON/OFF control',()=>{
  const f=fixture();
  assert.throws(()=>verifyUiOnlyRelease({
    ...f,candidate:{...f.candidate,'web/app.js':f.baseline['web/app.js']},
  }),/UI_ONLY_ASSET_MISSING_UNCHANGED_OR_UNBOUNDED/);
  assert.throws(()=>verifyUiOnlyRelease({
    ...f,candidate:{...f.candidate,'web/app.js':Buffer.alloc(300000,65)},
  }),/UI_ONLY_ASSET_MISSING_UNCHANGED_OR_UNBOUNDED/);
  assert.throws(()=>verifyUiOnlyRelease({
    ...f,candidate:{...f.candidate,'web/app.js':Buffer.from("const api='/api/v1/me/dashboard';")},
  }),/UI_ONLY_REQUIRED_ON_OFF_CONTROLS_MISSING/);
});

test('offline preflight is explicitly marked as not live-verified',()=>{
  const ok=verifyUiOnlyRelease({...fixture(),live:null});
  assert.equal(ok.liveBaselineMatched,false);
  assert.equal(ok.productionDeploymentPerformed,false);
});
