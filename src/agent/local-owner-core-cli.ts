import {agentTokenFromEnv,loadOrCreateAgentIdentity} from './native-agent.js';
import {readExistingPrivilegedBrokerToken} from '../security/privileged-broker-secret.js';
import {PrivilegedBrokerClient} from './privileged-broker-client.js';
import {createWindowsCoreConsoleAdmission} from './windows-core-console-provider.js';

/** Local executable entry point; consent is shown by Windows, never inferred
 * from a shell exit, an environment flag or a remote approved:true argument. */
export async function runLocalOwnerCoreCommand(args:readonly string[],env=process.env){
  const action=args[0]??'status';
  if(args.length>1||!['status','enroll','revoke'].includes(action))
    throw Error('Usage: nexowire core-console status|enroll|revoke');
  if(process.platform!=='win32')throw Error('WINDOWS_REQUIRED');
  const identity=await loadOrCreateAgentIdentity(env);
  const credential=agentTokenFromEnv(env);
  const token=await readExistingPrivilegedBrokerToken({
    ...(env.NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE?.trim()
      ?{file:env.NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE.trim()}:{}),
  });
  const broker=new PrivilegedBrokerClient({
    url:env.NEXOWIRE_PRIVILEGED_BROKER_URL?.trim()||'http://127.0.0.1:43112',token,
  });
  const admission=await createWindowsCoreConsoleAdmission({deviceId:identity.id,credential,broker,
    env:{...env,NEXOWIRE_CORE_APPROVAL_MODE:'local-owner'}});
  try{
    if(action==='enroll')await admission.enroll(AbortSignal.timeout(180000));
    if(action==='revoke')await admission.revoke();
    process.stdout.write(JSON.stringify(await admission.status('full'))+'\n');
  }finally{admission.close();}
}
