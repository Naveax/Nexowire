import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {prepareTrustedCloudflared,OFFICIAL_CLOUDFLARED_SHA256} from '../src/mcp/cloudflare-binary-trust.js';

/** CI downloads official cloudflared, independently pins the release SHA, then
 * runs ONLY --version from the exact open verified image. No tunnel/token/DNS. */
test('CLEAN-13 P1-A/B: official cloudflared Linux x64 executes by sealed FD after unlink',{
  skip:process.platform!=='linux'||process.arch!=='x64',
  timeout:45000,
},async()=>{
  const binary=process.env.NEXOWIRE_CLOUDFLARED_TEST_BINARY;
  assert.ok(binary,'official artifact must be provisioned by the focused CI step');
  const trusted=await prepareTrustedCloudflared(binary,OFFICIAL_CLOUDFLARED_SHA256['linux-x64']);
  try{
    const launch=spawnSync(trusted.command,['--version'],{
      stdio:['ignore','pipe','pipe',trusted.imageFd],
      encoding:'utf8',timeout:12000,maxBuffer:16384,
      env:{PATH:'/usr/bin:/bin',HOME:'/tmp',LANG:'C.UTF-8'},
    });
    assert.equal(launch.status,0,launch.error?.message??launch.stderr);
    assert.match(launch.stdout,/cloudflared version 2026\.10\.1/i);
  }finally{await trusted.dispose();}
});
