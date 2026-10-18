// Test-only mock volatile Agent. Never points at the live Nexowire service.
import {ProcessManager} from '../../src/agent/process-manager.js';
import {PathPolicy} from '../../src/agent/path-policy.js';
const marker=process.argv[2];
if (!marker || !/^NW_PARENT_DEATH_[0-9a-f]{24}$/.test(marker)) process.exit(64);
const manager=new ProcessManager();
const session=await manager.start({
  command:"node -e \"const marker='"+marker+"';setInterval(() => {}, 1000)\"",
  shell:'powershell',
},new PathPolicy(['*']));
process.stdout.write(JSON.stringify({
  parentPid:process.pid, rootPid:session.pid, guardianPid:session.jobGuardianPid,
  creationFiletime:session.processCreationFiletime, marker,
})+'\n');
setInterval(()=>{},1000);
