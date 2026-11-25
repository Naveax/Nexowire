import {runNativeAgent} from '../../src/agent/native-agent.js';
// Isolated child harness. No protected Publisher, native provider or credentials.
const lease=new AbortController(),stop=new AbortController();
process.stdin.once('data',chunk=>{
  process.stdin.pause();
  if(String(chunk).trim()==='revoke')lease.abort();else stop.abort();
});
try{
  await runNativeAgent(process.env,undefined,undefined,undefined,undefined,lease.signal,undefined,stop.signal);
  process.stdout.write('AI07_LOCAL_SHUTDOWN_RETURNED\n');
}catch(error){
  process.stderr.write(String(error)+'\n');
  process.exitCode=1;
}finally{process.stdin.destroy();}
