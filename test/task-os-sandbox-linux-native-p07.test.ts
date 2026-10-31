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
  // The outer parent death must kill its own direct diagnostic child,
  // even when the first/second namespace handshake has already completed.
  // Verify the parent PID while both share the pre-unshare PID namespace.
  assert.match(source,/pid_t outer_parent_pid=getpid\(\)/);
  assert.match(source,/if\(prctl\(PR_SET_PDEATHSIG,SIGKILL\)<0\)_exit\(82\)/);
  assert.match(source,/if\(getppid\(\)!=outer_parent_pid\)_exit\(85\)/);
  assert.match(source,/if\(pid==0\) \{[\s\S]*?if\(prctl\(PR_SET_PDEATHSIG,SIGKILL\)<0\)_exit\(82\);[\s\S]*?if\(getppid\(\)!=outer_parent_pid\)_exit\(85\);[\s\S]*?if\(setpgid\(0,0\)<0\)_exit\(80\)/);

  assert.match(source,/if\(prctl\(PR_SET_PDEATHSIG,SIGKILL\)<0\)_exit\(55\)/);
  // Before PID1's private approval read, install its parent-death fence.
  assert.ok(source.indexOf('if(prctl(PR_SET_PDEATHSIG,SIGKILL)<0)_exit(55);') <
    source.indexOf("if(read(gate[0],&child_approved,1)!=1"));
  // A dead child reader must return EPIPE instead of asynchronously killing
  // the direct probe process before its exact-PID cleanup path can execute.
  assert.match(source,/int accepted=signal\(SIGPIPE,SIG_IGN\)!=SIG_ERR/);
  assert.match(source,/if\(!accepted \|\| write\(gate\[1\],"Y",1\)!=1\)/);
  assert.match(source,/if\(pgid==pid\)/);
  assert.match(source,/kill\(-pid,SIGKILL\)/);
  assert.match(source,/if\(getpgid\(child\)!=child\)return -1/);
  assert.match(source,/observe_child_pid_namespace\(pid\)==0/);
  assert.match(source,/second==1 && pid_ready=='P'/);
  assert.match(source,/if\(pipe2\(gate,O_CLOEXEC\)<0\)return 63/);
  assert.match(source,/if\(read\(gate\[0\],&child_approved,1\)!=1/);
  assert.match(source,/if\(close\(gate\[0\]\)<0\)_exit\(62\)/);
  assert.match(source,/signals_ok=0;/);
  assert.match(source,/if\(pid<=1\)return -1/);
  // Group kill failure cannot bypass direct-child kill or wait verification.
  assert.match(source,/if\(kill\(pid,SIGKILL\)<0 && errno!=ESRCH\)signals_ok=0/);
  assert.match(source,/if\(got==pid\)return signals_ok\?-2:-1/);
  assert.match(source,/now-start>=5000LL/);
  assert.doesNotMatch(source,/waitpid\(pid,status,0\)/);
  // Namespace PID1's normal and error-path waits must be bounded.
  assert.match(source,/reap_disposable_pid1\(pid,&blocked_status,1\)==1\?61:83/);
  assert.match(source,/int waited=reap_disposable_pid1\(pid,&status,0\)/);
  assert.match(source,/if\(waited==1\)return 81/);
  assert.match(source,/if\(waited!=0\)return 84/);
  assert.match(source,/if\(now-start>=9000LL\)return -1/);
  assert.doesNotMatch(source,/while\(waitpid\(pid,&status,0\)/);

});

test('#07 probe seccomp cannot allow task exec, networking, process creation or mount syscalls',()=>{
  assert.match(source,/NW07_SECCOMP_ARCH/);
  assert.match(source,/SECCOMP_RET_KILL_PROCESS/);
  assert.match(source,/SECCOMP_RET_ERRNO\|EPERM/);
  assert.match(source,/if\(s!=-1 \|\| errno!=EPERM\)_exit\(52\)/);
  assert.match(source,/filefd=openat\(AT_FDCWD,"\/etc\/passwd",O_RDONLY\|O_CLOEXEC\)/);
  assert.match(source,/if\(filefd!=-1 \|\| errno!=EPERM\)_exit\(56\)/);
  assert.match(source,/observe_kernel_namespaces\(pid,outer_uid\)/);
  assert.match(source,/stat\("\/proc\/self\/ns\/pid_for_children",&host\)/);
  assert.match(source,/stat\(path,&observed\)<0\)return -1/);
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
