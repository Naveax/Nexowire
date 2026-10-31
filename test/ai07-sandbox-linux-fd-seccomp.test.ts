import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * Real disposable Linux FD/seccomp kernel negative fixture.
 * It creates only test-owned subprocesses, never a Nexowire task, a system
 * service or a production OS sandbox permission. Unsupported features FAIL.
 */
const nativeFixture=String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#if defined(__x86_64__)
#define NW_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NW_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported architecture: fail closed
#endif
#define ALLOW_SYSCALL(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_##n,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
#ifndef NW07_TEST_DISABLE_SECCOMP
static int seccomp_fence(void){
 struct sock_filter code[]={
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,(unsigned)offsetof(struct seccomp_data,arch)),
 BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,NW_ARCH,1,0),
 BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,(unsigned)offsetof(struct seccomp_data,nr)),
 ALLOW_SYSCALL(exit),ALLOW_SYSCALL(exit_group),ALLOW_SYSCALL(rt_sigreturn),
 BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
 };
 struct sock_fprog program={.len=(unsigned short)(sizeof(code)/sizeof(code[0])),.filter=code};
 if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)<0)return -1;
 return prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program);
}
#endif
static int child_probe(int inherited){
  /* Clear only the disposable child process's hardcoded test-only secret.
   * This is libc memory hygiene, not a protected production credential. */
#ifndef NW07_TEST_DISABLE_ENV_CLEAR
 if(clearenv()!=0)return 65;
#endif
 if(getenv("NW07_TEST_ONLY_SENTINEL")!=NULL)return 59;
#ifndef NW07_TEST_DISABLE_FD_CLOSURE
#ifdef SYS_close_range
 if(syscall(SYS_close_range,0U,~0U,0U)<0)return 52;
#else
 return 52;
#endif
#endif
 for(int i=0;i<4;i++){
  int fd=(i==3)?inherited:i;
  errno=0;
  if(fcntl(fd,F_GETFD)!=-1 || errno!=EBADF)return 53;
 }
#ifndef NW07_TEST_DISABLE_SECCOMP
 if(seccomp_fence()<0)return 54;
#endif
#ifdef NW07_TEST_DISABLE_SECCOMP
 /* Negative control must prove host permits the harmless syscalls.
  * External confinement is NOT evidence that our own filter works. */
 int s=socket(AF_INET,SOCK_STREAM|SOCK_CLOEXEC,0);
 if(s<0)return 58;
 close(s);
 int fd=openat(AT_FDCWD,"/dev/null",O_RDONLY|O_CLOEXEC);
 if(fd<0)return 58;
 close(fd);
 if(syscall(SYS_getpid)<=0)return 58;
 return 55; /* expected negative when our fence is absent */
#else
 errno=0;
 int s=socket(AF_INET,SOCK_STREAM|SOCK_CLOEXEC,0);
 if(s!=-1 || errno!=EPERM)return 55;
 errno=0;
 int fd=openat(AT_FDCWD,"/dev/null",O_RDONLY|O_CLOEXEC);
 if(fd!=-1 || errno!=EPERM)return 56;
 errno=0;
 long result=syscall(SYS_getpid);
 if(result!=-1 || errno!=EPERM)return 57;
 return 0;
#endif
}
static int monotonic_ms(long long *out){
 struct timespec t;
 if(clock_gettime(CLOCK_MONOTONIC,&t)<0)return -1;
 *out=(long long)t.tv_sec*1000+(long long)t.tv_nsec/1000000;
 return 0;
}
static int terminate_owned_child(pid_t pid){
 if(pid<=1)return -1;
 if(kill(pid,SIGKILL)<0&&errno!=ESRCH)return -1;
 for(int attempt=0;attempt<120;attempt++){
  int status=0;
  pid_t got=waitpid(pid,&status,WNOHANG);
  if(got==pid || (got<0&&errno==ECHILD))return 0;
  if(got<0&&errno!=EINTR)return -1;
  struct timespec nap={.tv_sec=0,.tv_nsec=20000000L};
  (void)nanosleep(&nap,NULL);
 }
 return -1;
}
int main(void){
 /* Hardcoded fixture-only sentinel, never a user or Broker credential. */
 if(setenv("NW07_TEST_ONLY_SENTINEL","FAKE_TEST_ONLY",1)!=0)return 66;
 int inherited=open("/dev/null",O_RDONLY|O_CLOEXEC);
 if(inherited<3){if(inherited>=0)close(inherited);return 60;}
 pid_t pid=fork();
 if(pid<0){close(inherited);return 61;}
 if(pid==0)_exit(child_probe(inherited));
 close(inherited);
 long long start,now;
 if(monotonic_ms(&start)<0){(void)terminate_owned_child(pid);return 62;}
 int status=0, reaped=0, forced=0;
 for(;;){
  pid_t got=waitpid(pid,&status,WNOHANG);
  if(got==pid){reaped=1;break;}
  if(got<0&&errno!=EINTR)break;
  if(monotonic_ms(&now)<0)break;
  if(now-start>=1500&&!forced){kill(pid,SIGKILL);forced=1;}
  if(now-start>=3000)break;
  struct timespec nap={.tv_sec=0,.tv_nsec=20000000L};
  (void)nanosleep(&nap,NULL);
 }
 if(!reaped){
  (void)terminate_owned_child(pid); /* no success on ambiguous cleanup */
  return 63; /* timeout always blocked */
 }
 if(forced || !WIFEXITED(status))return 64;
 int rc=WEXITSTATUS(status);
 if(rc==0)puts("NW07_DISPOSABLE_FD_SECCOMP_KERNEL_PASS (NOT_NATIVE_WORKER_ACCEPTANCE)");
 else fprintf(stderr,"NW07_KERNEL_NEGATIVE_BLOCKED=%d\n",rc);
 return rc;
}
`;

test('AI-07 Linux kernel closes inherited descriptors and denies socket/openat/getpid with failing controls', {
  skip:process.platform!=='linux'?'Linux-only disposable kernel test; NOT_RUN':false,
  timeout:35000,
},()=>{
  const dir=mkdtempSync(join(tmpdir(),'nw07-fd-seccomp-'));
  try {
    const source=join(dir,'fixture.c');
    writeFileSync(source,nativeFixture,{mode:0o600});
    const variants=[
      {name:'protected',define:null,expected:0},
      {name:'fd-closure-disabled',define:'-DNW07_TEST_DISABLE_FD_CLOSURE',expected:53},
      {name:'seccomp-disabled',define:'-DNW07_TEST_DISABLE_SECCOMP',expected:55},
      {name:'env-clear-disabled',define:'-DNW07_TEST_DISABLE_ENV_CLEAR',expected:59},
    ] as const;
    for(const v of variants){
      const binary=join(dir,v.name);
      const args=['-std=c11','-O2','-Wall','-Wextra','-Werror'];
      if(v.define)args.push(v.define);
      args.push(source,'-o',binary);
      const built=spawnSync('cc',args,{
        encoding:'utf8',timeout:12000,env:{PATH:'/usr/bin:/bin'},
      });
      assert.equal(built.status,0,
        'BLOCKED '+v.name+' compile: '+String(built.stderr||built.error||built.stdout));
      const run=spawnSync(binary,[],{
        encoding:'utf8',timeout:8000,env:{PATH:'/usr/bin:/bin'},
      });
      assert.equal(run.status,v.expected,
        'BLOCKED '+v.name+' kernel: '+String(run.stderr||run.error||run.stdout));
      if(v.expected===0){
        assert.match(run.stdout,/NW07_DISPOSABLE_FD_SECCOMP_KERNEL_PASS/);
        assert.match(run.stdout,/NOT_NATIVE_WORKER_ACCEPTANCE/);
        assert.equal(run.stderr,'');
      }else{
        assert.match(run.stderr,new RegExp('NW07_KERNEL_NEGATIVE_BLOCKED='+v.expected));
        assert.doesNotMatch(run.stdout,/KERNEL_PASS/);
      }
    }
  }finally{
    rmSync(dir,{recursive:true,force:true,maxRetries:2,retryDelay:100});
  }
});
