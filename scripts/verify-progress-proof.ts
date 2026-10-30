/**
 * Operator-only offline verifier of bounded worker result files.
 * The descriptor MUST be provisioned independently of the worker.
 * This command does not attest to OS process exit or work semantics and
 * therefore cannot claim completed_verified.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {verifyResultFiles, type ProgressProofRequest} from '../src/agent/progress-proof-verifier.js';

export async function verifyProgressProofRequestFile(filename:string):Promise<unknown>{
  if(typeof filename!=='string'||!path.isAbsolute(filename))throw new Error('TRUSTED_REQUEST_FILE_REQUIRED');
  const stats=await fs.lstat(filename);
  if(!stats.isFile()||stats.isSymbolicLink()||stats.size>8192||stats.size===0){
    throw new Error('TRUSTED_REQUEST_FILE_REQUIRED');
  }
  const input=JSON.parse(await fs.readFile(filename,'utf8')) as ProgressProofRequest;
  if(!input||typeof input!=='object'||Object.keys(input).sort().join(',')!=='expectedCount,runRoot,scope'){
    throw new Error('TRUSTED_REQUEST_FILE_INVALID');
  }
  const result=await verifyResultFiles(input);
  return {
    ...result,
    completedVerified:false,
    processExitIndependentlyAttested:false,
    noWorkerWasExecuted:true,
  };
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{
    if(process.argv.length!==4||process.argv[2]!=='--trusted-request'){
      throw new Error('TRUSTED_REQUEST_FILE_REQUIRED');
    }
    const outcome=await verifyProgressProofRequestFile(process.argv[3]!);
    process.stdout.write(JSON.stringify(outcome,null,2)+'\n');
    if((outcome as {status:string}).status!=='verified')process.exitCode=1;
  }catch{
    // Do not echo path, descriptor body or production identifiers.
    process.stderr.write('PROGRESS_PROOF_UNVERIFIED\n');
    process.exitCode=1;
  }
}
