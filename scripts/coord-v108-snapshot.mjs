/**
 * Read-only GitHub snapshot for the Nexowire v1.0.8 merge-tree simulator.
 * This retrieves PR metadata only. It does not fetch git objects, trigger
 * workflows, merge anything, modify a branch or enable CORE.
 *
 * Usage: node scripts/coord-v108-snapshot.mjs > /tmp/v108-prs.json
 * Set GITHUB_TOKEN only when extra read-only API rate limit is needed.
 */
const repo='Naveax/Nexowire';
const numbers=[986,980,981,982,988,983,984,993,989,987,992,985,990];

async function read(endpoint){
  const token=process.env.GITHUB_TOKEN?.trim();
  const response=await fetch('https://api.github.com/repos/'+repo+endpoint,{
    headers:{Accept:'application/vnd.github+json',
      'User-Agent':'nexowire-coord-merge-snapshot',
      ...(token?{Authorization:'Bearer '+token}:{})},
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw Error('GITHUB_READ_ONLY_HTTP_'+response.status);
  const payload=await response.text();
  if(payload.length>1024*1024)throw Error('GITHUB_RESPONSE_OVERSIZE');
  return JSON.parse(payload);
}

const sha=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
function normalize(pr){
  if(pr?.state!=='open'||pr.draft!==true||
    !numbers.includes(pr.number)||
    !sha(pr.head?.sha)||!sha(pr.base?.sha)||
    typeof pr.head.ref!=='string'||typeof pr.base.ref!=='string'){
    throw Error('PR_METADATA_INVALID_OR_NOT_DRAFT_'+String(pr?.number));
  }
  return {number:pr.number,state:'open',draft:true,
    head:{ref:pr.head.ref,sha:pr.head.sha},
    base:{ref:pr.base.ref,sha:pr.base.sha}};
}

async function captureConsistentSnapshot(){
  const start=await read('/commits/main');
  if(!sha(start?.sha))throw Error('MAIN_SHA_MISSING');
  const prs=[];
  for(const number of numbers){
    prs.push(normalize(await read('/pulls/'+number)));
  }
  const end=await read('/commits/main');
  if(start.sha!==end?.sha)throw Error('MAIN_MOVED_DURING_SNAPSHOT');
  for(const original of prs){
    const again=normalize(await read('/pulls/'+original.number));
    if(JSON.stringify(original)!==JSON.stringify(again)){
      throw Error('PR_MOVED_DURING_SNAPSHOT_'+original.number);
    }
  }
  return {
    schemaVersion:1,repository:repo,source:'READ_ONLY_GITHUB_API_SNAPSHOT',
    capturedAt:new Date().toISOString(),mainSha:start.sha,prs,
  };
}

// Active AI writers may advance their HEAD during the ~28 API reads.
// Retry the entire immutable snapshot a bounded number of times, never mix
// partially verified snapshots and never treat a moving ref as a success.
const maxAttempts=3;
for(let attempt=1;attempt<=maxAttempts;attempt++){
  try{
    const snapshot=await captureConsistentSnapshot();
    process.stdout.write(JSON.stringify(snapshot,null,2)+'\n');
    break;
  }catch(error){
    const code=error instanceof Error?error.message:'UNKNOWN';
    const moving=code==='MAIN_MOVED_DURING_SNAPSHOT'||
      code.startsWith('PR_MOVED_DURING_SNAPSHOT_');
    if(moving&&attempt<maxAttempts){
      process.stderr.write('NEXOWIRE_MERGE_SNAPSHOT_MOVED_RETRY '+attempt+'/'+maxAttempts+'\n');
      continue;
    }
    process.stderr.write('NEXOWIRE_MERGE_SNAPSHOT_BLOCKED: '+code+'\n');
    process.exitCode=2;
    break;
  }
}
