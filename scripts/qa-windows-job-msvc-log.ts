/** #11 CI QA only. A clean build log is not physical Windows trust evidence. */
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_LOG_BYTES=2*1024*1024;
type Assessment={ok:boolean;reason:string;physicalAcceptance:'NOT_PROVEN'};
const reject=(reason:string):Assessment=>({ok:false,reason,physicalAcceptance:'NOT_PROVEN'});

export function assessWindowsJobMsvcLog(input:unknown):Assessment{
  if(typeof input!=='string')return reject('BUILD_LOG_INVALID');
  if(Buffer.byteLength(input,'utf8')>MAX_LOG_BYTES)return reject('BUILD_LOG_TOO_LARGE');
  const clean=input.replace(/\x1b\[[0-9;]*m/g,'');
  if(/windows-job-medium-dup-probe\.c\(\d+(?:,\d+)?\):\s*(?:warning|error)\s+C4133\b/i.test(clean))
    return reject('PROBE_C4133_INCOMPATIBLE_POINTER');
  if(!/(?:^|\r?\n)[ \t]*(?:[^\r\n]*[\\/])?windows-job-medium-dup-probe\.c[ \t]*(?:\r?\n|$)/i.test(clean))
    return reject('PROBE_COMPILE_NOT_OBSERVED');
  return {ok:true,reason:'MSVC_FIXTURE_LOG_NO_C4133',physicalAcceptance:'NOT_PROVEN'};
}

function run():void{
  if(process.platform!=='win32'||process.env.CI!=='true'||
     process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||
     process.env.RUNNER_ENVIRONMENT!=='github-hosted')
    throw new Error('GITHUB_HOSTED_WINDOWS_RUNNER_REQUIRED');
  if(process.argv.length!==3||!process.env.RUNNER_TEMP)
    throw new Error('BUILD_LOG_ARGUMENT_INVALID');
  const logPath=process.argv[2]!;
  const stat=lstatSync(logPath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_LOG_BYTES)
    throw new Error('BUILD_LOG_INVALID');
  const root=realpathSync(process.env.RUNNER_TEMP).toLowerCase();
  const realLog=realpathSync(logPath);
  if(dirname(realLog).toLowerCase()!==root||
     !/^nexowire-msvc-qa-[a-f0-9]{32}\.log$/i.test(basename(realLog)))
    throw new Error('BUILD_LOG_OUTSIDE_RUNNER_TEMP');
  const result=assessWindowsJobMsvcLog(readFileSync(realLog,'utf8'));
  if(!result.ok)throw new Error(result.reason);
  process.stdout.write('MSVC fixture log checked; physical acceptance NOT_PROVEN.\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{run()}catch(error){
    const reason=error instanceof Error?error.message:'BUILD_LOG_UNVERIFIED';
    process.stderr.write('Windows Job MSVC QA failed closed: '+reason+'\n');
    process.exitCode=1;
  }
}

