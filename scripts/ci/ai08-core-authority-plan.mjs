import {assertTapSummary} from './assert-tap-summary.mjs';

export const COMPOSITION='test/ai03/native-verifier-composition.test.ts';
export const COMPOSITION_IMPORTS=Object.freeze({
 'test/core-native-consent-transport.test.ts':Object.freeze({blob:'9573376481d4d5a3b4e3ff8722a7032441101d8b',tests:14}),
 'test/core-native-enrollment-verifier-handler.test.ts':Object.freeze({blob:'f68edeb23be731297820fa868cd772e931de07a1',tests:19}),
 'test/core-native-verifier-server.test.ts':Object.freeze({blob:'e3d554e90a22aba4d5e394253a66bac0ab24d6bd',tests:9}),
});
export const WINDOWS_PLAN=Object.freeze({
 'test/broker-dispatch-authority-handler.test.ts':Object.freeze(['02ebe8b4d58af98464e84eb0c00ce920107aaf9b',12]),
 'test/https-broker-dispatch-authority.test.ts':Object.freeze(['d2c950ac40095f06000ef77e099cc3362f05cbe4',3]),
 [COMPOSITION]:Object.freeze(['a7e7fca6dc5b9dbd69269b4c0af0aa515bc4b00d',44]),
 'test/ai03/postgres-dispatch-credential-store.test.ts':Object.freeze(['91d0ce45d0135447d5febe08b560a726d5620107',3]),
 'test/ai03/protected-dispatch-credential-recheck.test.ts':Object.freeze(['e0d3ecdc465a0ccf2ddecc0f54ad6fc29a313592',1]),
 'test/ai03/protected-dispatch-mtls-client.test.ts':Object.freeze(['987af4c60fd0a93e718e63b842ac5c6950d1c50f',4]),
 'test/ai03/protected-dispatch-native-installation-readback.test.ts':Object.freeze(['61ef1709f0b2e88f8fd8efcd2ba9032e4429d468',1]),
 'test/ai03/protected-dispatch-service.test.ts':Object.freeze(['ced75a452a4e062672f710f56e6c182613fe29bc',6]),
 'test/ai03/protected-native-completion-reader.test.ts':Object.freeze(['2810fc94aef1d7e29d1d02858580861d7c2b033e',2]),
 'test/ai03/production-authority-boundary.test.ts':Object.freeze(['09d3cbd09ded092aebd3c3a527572645b4419f6f',2])
});
export const COMPOSITION_TOP_LEVEL=Object.freeze([
 'signed native client requires protected issuer pin and session-bound one-use receipt',
 'independent D1 verifier consumes receipt once and checks owner Windows logon SID/session/LUID/epoch',
 'response tampering, nonce swaps, wrong receipt and stale signed readback always fail closed',
 'insecure origin, absent trust bootstrap and unresponsive verifier never authorize',
 'omitted protected transport refuses global fetch fallback before exposing bearer',
 'shared authority transport rejects ambiguous HTTP media metadata even with a valid signature',
 'signed non-200 success responses are terminal and never accepted as verifier ACK',
 'native authority deadline is absolute when injected transport, body or cancel ignores abort',
 'approval response cannot follow a caller owner/session change during transport await',
 'independent readback cannot match a caller-mutated SID, LUID or receipt',
 'in-flight signing pin replacement cannot authenticate another issuer',
 'valid original signed response survives later mutation of caller-owned nested request',
 'native request snapshot is detached, deeply immutable, bounded and rejects cycles',
 'native ceremony request binds the enrollment issuer hash into signed response context',
 'independent native enrollment verifier enforces real TLS transport and scoped one-use responses',
 'verifier refuses absent protected dependencies and non-Ed25519 signing pins',
 'bounded native verifier host: actual mTLS, admission, deadlines and overload',
 'AI-03 verifier composition: credential and actual peer pin bind one immutable scope',
 'AI-03 real verifier listener denies absent independent provenance without DB fallback'
]);
export function validateWindowsPlan(plan=WINDOWS_PLAN){
 const expected=2+Object.values(COMPOSITION_IMPORTS).reduce((n,p)=>n+p.tests,0);
 if(plan[COMPOSITION]?.[1]!==expected||Object.keys(COMPOSITION_IMPORTS).some(f=>Object.hasOwn(plan,f)))
  throw Error('COMPOSITION_DUPLICATE_OR_COUNT_MISMATCH');
}
export function assertCoreExactTap(file,tap,expected){
 const counts=assertTapSummary(tap,expected);
 if(counts.tests!==expected)throw Error('EXACT_TEST_COUNT_MISMATCH');
 if(file===COMPOSITION){
  // Node TAP footer counts both parent and nested tests; top-level plan is 19.
  // Require the actual reviewed composition, not just an arbitrary 44 footer.
  const lines=tap.split(/\r?\n/);
  const top=lines.filter(l=>/^ok \d+ - /.test(l));
  if(lines.filter(l=>l==='TAP version 13').length!==1||
     lines.filter(l=>/^1\.\.\d+$/.test(l)).join(',')!=='1..19'||
     top.length!==COMPOSITION_TOP_LEVEL.length||
     top.some((l,i)=>l!=='ok '+(i+1)+' - '+COMPOSITION_TOP_LEVEL[i])||
     lines.filter(l=>/^\s*ok \d+ - /.test(l)).length!==expected)
    throw Error('COMPOSITION_TAP_STRUCTURE_MISMATCH');
 }
 return counts;
}
