import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const keys=['tests','pass','fail','cancelled','skipped','todo'];

/**
 * Validate one complete Node TAP footer. This is a count floor, not a
 * fixed assertion count: new tests must not turn a green run into false RED.
 * A partial, skipped, failed, duplicated or zero-test run is still RED.
 */
export function assertTapSummary(tap,minimumTests=1) {
  if(!Number.isSafeInteger(minimumTests)||minimumTests<1)
    throw new Error('TAP minimum count invalid');
  const counts=Object.create(null);
  for(const line of tap.split(/\r?\n/)) {
    const match=/^# (tests|pass|fail|cancelled|skipped|todo) (0|[1-9][0-9]*)$/.exec(line);
    if(!match)continue;
    const [,key,raw]=match;
    if(Object.hasOwn(counts,key))throw new Error('TAP duplicate '+key+' summary');
    const value=Number(raw);
    if(!Number.isSafeInteger(value))throw new Error('TAP '+key+' count invalid');
    counts[key]=value;
  }
  for(const key of keys) {
    if(!Object.hasOwn(counts,key))throw new Error('TAP missing '+key+' summary');
  }
  if(counts.tests<minimumTests)throw new Error('TAP below minimum test count');
  if(counts.pass!==counts.tests)throw new Error('TAP pass count mismatch');
  for(const key of ['fail','cancelled','skipped','todo']) {
    if(counts[key]!==0)throw new Error('TAP '+key+' count nonzero');
  }
  return counts;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [, , file, minimum='1']=process.argv;
    if(!file || !/^[1-9][0-9]*$/.test(minimum))
      throw new Error('Usage: assert-tap-summary.mjs <tap-file> <minimum-tests>');
    const contents=readFileSync(file);
    // PowerShell 5.1 redirects native process output as UTF-16LE. Bash and
    // modern shells use UTF-8. Both must have identical TAP acceptance.
    const encoding=contents[0]===0xff&&contents[1]===0xfe?'utf16le':'utf8';
    const tap=contents.toString(encoding).replace(/^\uFEFF/,'');
    const counts=assertTapSummary(tap,Number(minimum));
    process.stdout.write('TAP ACCEPTED: '+counts.pass+'/'+counts.tests+' PASS, 0 fail/cancel/skip/todo\n');
  }catch(error) {
    process.stderr.write('TAP DENIED: '+(error instanceof Error?error.message:'invalid summary')+'\n');
    process.exitCode=1;
  }
}
