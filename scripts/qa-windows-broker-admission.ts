/**
 * #11 source QA only. Runs two test-only loopback Broker suites on the Windows
 * CI runner and refuses a green result when either required case was skipped.
 * This cannot prove installed Broker identity, HIGH token, ACL or external CAS.
 */
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REQUIRED_BROKER_CASES=[
  'Windows privileged broker refuses bearer-only elevated callbacks',
  'Broker HTTP route gates native, injected, installer, updater and no-provider',
] as const;

/** Parse TAP output from a local fixture run; never claim physical acceptance. */
export function assessBrokerFixtureTap(output:string,exitCode:number|null):{
  ok:boolean;reason:string;physicalAcceptance:'NOT_PROVEN';
}{
  const fail=(reason:string)=>({ok:false,reason,physicalAcceptance:'NOT_PROVEN' as const});
  if(exitCode!==0)return fail('TEST_PROCESS_NOT_SUCCESSFUL');
  if(output.length>2*1024*1024)return fail('TEST_OUTPUT_TOO_LARGE');
  const lines=output.split(/\r?\n/);
  for(const name of REQUIRED_BROKER_CASES){
    const matching=lines.filter(line=>{
      const result=/^(?:not )?ok\s+\d+\s+-\s+(.+)$/.exec(line);
      if(!result)return false;
      const rest=result[1]!;
      return rest===name||rest.startsWith(name+' #');
    });
    if(matching.length!==1)return fail('REQUIRED_CASE_MISSING_OR_DUPLICATED');
    if(!matching[0]!.startsWith('ok ')||matching[0]!.includes(' #'))
      return fail('REQUIRED_CASE_FAILED_OR_SKIPPED');
  }
  return {ok:true,reason:'FIXTURE_CASES_REPORTED_PASSED',physicalAcceptance:'NOT_PROVEN'};
}

async function run():Promise<void>{
  // This tool is deliberately limited to a disposable CI Windows runner.
  if(process.platform!=='win32'||process.env.CI!=='true'){
    throw new Error('WINDOWS_CI_RUNNER_REQUIRED');
  }
  const child=spawn(process.execPath,[
    '--test','--test-reporter=tap','--test-concurrency=1','--import','tsx',
    'test/privileged-broker-effect-admission.test.ts',
    'test/privilege-boundary.test.ts',
  ],{shell:false,stdio:['ignore','pipe','pipe']});
  let output='',tooLarge=false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{
    process.stdout.write(chunk);
    if(output.length+chunk.length>2*1024*1024){tooLarge=true;child.kill();return}
    output+=chunk;
  });
  child.stderr.on('data',(chunk:string)=>process.stderr.write(chunk));
  const exit=await new Promise<number|null>((resolveExit,reject)=>{
    child.once('error',reject);
    child.once('close',code=>resolveExit(code));
  });
  const result=assessBrokerFixtureTap(output,tooLarge?null:exit);
  if(!result.ok)throw new Error(result.reason);
  process.stdout.write('Windows Broker fixture cases passed; physical acceptance NOT_PROVEN.\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await run()}catch{
    process.stderr.write('Windows Broker fixture verification failed closed.\n');
    process.exitCode=1;
  }
}
