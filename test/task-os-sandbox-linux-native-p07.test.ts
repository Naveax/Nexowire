import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Source-only native diagnostic: never a real task worker. Linux kernels that
 * forbid rootless namespaces are BLOCKED and must not be advertised as PASS.
 * Opt-in local smoke: NW07_RUN_NATIVE_NAMESPACE_PROBE=1 npm test -- ...
 */
const nativeFile=new URL('../native/task-os-sandbox-linux-namespace-probe-p07.c',import.meta.url);
const source=readFileSync(nativeFile,'utf8');

test('#07 Linux diagnostic has no arbitrary shell entry point',()=>{
  assert.match(source,/--selftest-only/);
  assert.match(source,/NW07_SOURCE_ONLY_NO_TASK_EXEC/);
  for(const token of ['CLONE_NEWUSER','CLONE_NEWNS','CLONE_NEWNET',
    'CLONE_NEWIPC','CLONE_NEWUTS','CLONE_NEWPID','SYS_pivot_root',
    'stat("/proc/self/ns/user"', 'stat("/proc/self/ns/net"',
    'MS_PRIVATE','PR_SET_NO_NEW_PRIVS','PR_SET_SECCOMP',
    'SECCOMP_MODE_FILTER','SECCOMP_RET_ERRNO|EPERM',
    'SYS_close_range','clearenv()']){
    assert.ok(source.includes(token),token);
  }
  assert.doesNotMatch(source,/\b(?:execve|execvp|execl|system|popen|posix_spawn)\s*\(/);
  assert.doesNotMatch(source,/for\s*\(int fd=3;fd<1024/);
  // FD 0, 1 and 2 are untrusted too: they may be inherited host sockets.
  assert.match(source,/SYS_close_range,0U,~0U,0U/);
  assert.doesNotMatch(source,/SYS_close_range,3U,/);
  assert.match(source,/fcntl\(fd,F_GETFD\)/);
  // Never give task child a write syscall merely to print its own PASS marker.
  assert.doesNotMatch(source,/NW07_SC_ALLOW\(write\)/);
  assert.match(source,/else puts\("NW07_NAMESPACE_SECCOMP_SOURCE_SELFTEST_OK/);
  // Missing/blocked kernel handshake must never hang the caller indefinitely.
  assert.match(source,/read_ready_bounded\(ready\[0\],&announcement\)/);
  assert.match(source,/poll\(&pfd,1,\(int\)remaining\)/);
  assert.match(source,/waitpid\(pid,status,WNOHANG\)/);
  assert.match(source,/terminate_owned_child\(pid,status\)/);
  assert.match(source,/if\(waited==-2\)return 78/);
  assert.match(source,/if\(setpgid\(0,0\)<0\)_exit\(80\)/);
  assert.match(source,/if\(prctl\(PR_SET_PDEATHSIG,SIGKILL\)<0\)_exit\(55\)/);
  assert.match(source,/pgid==pid && kill\(-pid,SIGKILL\)/);
  assert.match(source,/if\(pid<=1\)return -1/);
  // Group kill failure cannot bypass direct-child kill or wait verification.
  assert.match(source,/if\(kill\(pid,SIGKILL\)<0 && errno!=ESRCH\)signals_ok=0/);
  assert.match(source,/if\(got==pid\)return signals_ok\?-2:-1/);
  assert.match(source,/now-start>=5000LL/);
  assert.doesNotMatch(source,/waitpid\(pid,status,0\)/);

});

test('#07 probe seccomp cannot allow task exec, networking, process creation or mount syscalls',()=>{
  assert.match(source,/NW07_SECCOMP_ARCH/);
  assert.match(source,/SECCOMP_RET_KILL_PROCESS/);
  assert.match(source,/SECCOMP_RET_ERRNO\|EPERM/);
  assert.match(source,/if\(s!=-1 \|\| errno!=EPERM\)_exit\(52\)/);
  assert.match(source,/observe_kernel_namespaces\(pid,outer_uid\)/);
  for(const denied of [
    'execve','execveat','socket','connect','sendmsg','recvmsg',
    'clone','clone3','fork','vfork','mount','umount2','open','openat',
    'setns','unshare','ptrace','bpf','keyctl','memfd_create'
  ]){
    assert.doesNotMatch(source,new RegExp('NW07_SC_ALLOW\\('+denied+'\\)'),
      'A disallowed syscall was added to the test-only seccomp whitelist: '+denied);
  }
});

test('#07 native probe compiles and refuses arbitrary command',{
  skip:process.platform!=='linux'?'Linux-only source diagnostic':false,
},()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'nw07-compile-'));
  try{
    const exe=path.join(dir,'probe');
    const built=spawnSync('cc',['-std=c11','-O2','-Wall','-Wextra','-Werror',
      nativeFile.pathname,'-o',exe],{encoding:'utf8',timeout:20000,env:{PATH:'/usr/bin:/bin'}});
    assert.equal(built.status,0,String(built.stderr||built.error));
    const forbidden=spawnSync(exe,['--run','sh','-c','id'],{
      encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin'}});
    assert.equal(forbidden.status,64);
    assert.match(forbidden.stderr,/NW07_SOURCE_ONLY_NO_TASK_EXEC/);
    assert.equal(spawnSync(exe,[],{encoding:'utf8',timeout:5000}).status,64);
    if(process.env.NW07_RUN_NATIVE_NAMESPACE_PROBE==='1'){
      const checked=spawnSync(exe,['--selftest-only'],{
        encoding:'utf8',timeout:20000,env:{PATH:'/usr/bin:/bin'}});
      assert.equal(checked.status,0,
        'OS_NAMESPACE_DIAGNOSTIC_BLOCKED: '+checked.stderr);
      assert.match(checked.stdout,/NW07_NAMESPACE_SECCOMP_SOURCE_SELFTEST_OK/);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
