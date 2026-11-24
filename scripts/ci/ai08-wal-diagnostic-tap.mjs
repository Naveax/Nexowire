/** A narrow exception for one reviewed historical Windows-only symlink skip.
 * No exception applies to any other WAL test or diagnostic. */
export const DIAGNOSTIC_TITLES=Object.freeze([
 'persistent startup failure records a bounded redacted restart-loop diagnosis and preserves the original error',
 'successful local initialization clears the failure streak without claiming a live connection or CORE',
 'diagnostic I/O failure cannot mask journal rejection or turn it into successful startup',
 'malformed, oversized and forged authority diagnostic files are not accepted as state',
 'custom journal configuration keeps the diagnostic beside that profile and never edits journal bytes',
 'a symlink diagnostic is ignored rather than followed',
 'startup diagnostics bind the process and a cutover nonce without treating the nonce as authority',
 'persistent WAL snapshot instability preserves exact startup failure and journal history',
 'startup diagnostic distinguishes UNSTABLE, CORRUPT, IN_USE and unrecognized failures without leaking messages',
 'UNSTABLE diagnostic cannot claim readiness or authority and diagnostic I/O cannot mask the original error'
]);
export const NAMED_SKIP=DIAGNOSTIC_TITLES[5];
export function assertWindowsDiagnosticTap(tap){
 const lines=tap.split(/\r?\n/);
 const counts=Object.create(null),keys=['tests','pass','fail','cancelled','skipped','todo'];
 for(const line of lines){
  const m=/^# (tests|pass|fail|cancelled|skipped|todo) (0|[1-9][0-9]*)$/.exec(line);
  if(!m)continue;
  if(Object.hasOwn(counts,m[1]))throw Error('DIAGNOSTIC_DUPLICATE_SUMMARY');
  const n=Number(m[2]);if(!Number.isSafeInteger(n))throw Error('DIAGNOSTIC_INVALID_COUNT');
  counts[m[1]]=n;
 }
 const expected={tests:10,pass:9,fail:0,cancelled:0,skipped:1,todo:0};
 for(const key of keys)if(counts[key]!==expected[key])throw Error('DIAGNOSTIC_SUMMARY_MISMATCH:'+key);
 const results=lines.filter(l=>/^\s*(?:not )?ok \d+ - /.test(l));
 if(lines.filter(l=>l==='TAP version 13').length!==1||lines.filter(l=>/^\s*1\.\.\d+$/.test(l)).join(',')!=='1..10'||results.length!==10)
  throw Error('DIAGNOSTIC_TAP_STRUCTURE');
 for(const [i,title] of DIAGNOSTIC_TITLES.entries()){
  const wanted='ok '+(i+1)+' - '+title+(i===5?' # SKIP':'');
  if(results[i]!==wanted)throw Error('DIAGNOSTIC_CASE_MISMATCH:'+title);
 }
 return {counts,expectedSkippedCases:[NAMED_SKIP],passedCases:DIAGNOSTIC_TITLES.filter((_,i)=>i!==5)};
}
