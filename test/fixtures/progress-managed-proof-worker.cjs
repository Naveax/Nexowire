'use strict';
// Isolated fixture only. Reads one Agent-issued session ID from stdin; no network/GPU/bot.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [root,mode] = process.argv.slice(2);
if (!root || !['complete','false_progress'].includes(mode)) process.exit(2);
const timeout = setTimeout(() => process.exit(3), 8000);
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input+=chunk;
  if (input.length>128) process.exit(4);
  const at=input.indexOf('\n');
  if(at<0)return;
  clearTimeout(timeout);
  process.stdin.pause();
  const sessionId=input.slice(0,at).trim();
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) process.exit(5);
  const outcomes=mode==='complete'?['completed','completed']:['completed'];
  const artifacts=[],digests=[];
  fs.mkdirSync(path.join(root,'results'),{recursive:true});
  for(let i=0;i<outcomes.length;i++){
    const itemId='unit-'+i;
    const buf=Buffer.from(JSON.stringify({schemaVersion:1,runId:'run-fixture',itemId,outcome:outcomes[i]}));
    const filename=itemId+'.json';
    fs.writeFileSync(path.join(root,'results',filename),buf);
    const sha256=crypto.createHash('sha256').update(buf).digest('hex');
    artifacts.push({itemId,filename,sha256});
    digests.push({itemId,outcome:outcomes[i],sha256});
  }
  fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({
    schemaVersion:1,
    scope:{ownerAccountId:'owner-fixture',deviceId:'device-fixture',
      projectId:'project-fixture',runId:'run-fixture',sessionId},
    expectedCount:2,sealed:true,artifacts,
  }));
  const hash=crypto.createHash('sha256').update('NEXOWIRE_RESULT_SET_V1\n');
  for(const d of digests)hash.update(JSON.stringify([d.itemId,d.outcome,d.sha256])+'\n');
  process.stdout.write('NEXOWIRE_PROGRESS_V1 '+JSON.stringify({
    completed_count:2,pending_count:0,failure_count:0,
    result_artifact_sha256:hash.digest('hex'),
  })+'\n',()=>{
    process.stdin.destroy();
    process.exit(0);
  });
});
