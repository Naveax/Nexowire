import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * Disposable real-Linux negative: setsid() can escape a process-group kill.
 * Subreaper and PIDFD bind and reap only test-owned processes; the actor
 * has a parent-death signal and the grandchild an eight-second alarm.
 * This is NOT cgroup/Job or installed Nexowire task-worker acceptance.
 */
const nativeSource=String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int bounded_reap(pid_t pid,int *status){
 if(pid<=1)return -1;
 for(int i=0;i<120;i++){
  pid_t got=waitpid(pid,status,WNOHANG);
  if(got==pid)return 0;
  if(got<0 && errno!=EINTR)return -1;
  struct timespec delay={.tv_sec=0,.tv_nsec=20000000L};
  (void)nanosleep(&delay,NULL);
 }
 return -1;
}
static int fixture(void){
#ifndef SYS_pidfd_open
 return 70;
#else
 if(prctl(PR_SET_CHILD_SUBREAPER,1)<0)return 71;
 int ready[2];
 if(pipe2(ready,O_CLOEXEC)<0)return 72;
 pid_t original_parent=getpid();
 pid_t actor=fork();
 if(actor<0){close(ready[0]);close(ready[1]);return 73;}
 if(actor==0){
  (void)close(ready[0]);
  if(prctl(PR_SET_PDEATHSIG,SIGKILL)<0)_exit(89);
  if(getppid()!=original_parent)_exit(90);
  if(setpgid(0,0)<0)_exit(74);
  pid_t subject=fork();
  if(subject<0)_exit(75);
  if(subject==0){
#ifndef NW07_TEST_DISABLE_BREAKAWAY
   if(setsid()<0)_exit(76);
#endif
   alarm(8);
   pid_t self=getpid();
   if(write(ready[1],&self,sizeof(self))!=(ssize_t)sizeof(self))_exit(77);
   (void)close(ready[1]);
   for(;;)pause();
  }
  (void)close(ready[1]);
  for(;;)pause();
 }
 (void)close(ready[1]);
 int result=0,actor_status=0,subject_status=0;
 pid_t subject=-1;
 int subject_pidfd=-1;
 struct pollfd wait_ready={.fd=ready[0],.events=POLLIN,.revents=0};
 if(poll(&wait_ready,1,2000)!=1 || !(wait_ready.revents&POLLIN) ||
    read(ready[0],&subject,sizeof(subject))!=(ssize_t)sizeof(subject) ||
    subject<=1){result=78;goto done;}
 if(getpgid(actor)!=actor){result=79;goto done;}
#ifdef NW07_TEST_DISABLE_BREAKAWAY
 if(getpgid(subject)!=actor){result=80;goto done;}
#else
 if(getpgid(subject)!=subject){result=81;goto done;}
#endif
 subject_pidfd=(int)syscall(SYS_pidfd_open,subject,0);
 if(subject_pidfd<0){result=82;goto done;}
 if(kill(-actor,SIGKILL)<0){result=83;goto done;}
 if(bounded_reap(actor,&actor_status)<0 || !WIFSIGNALED(actor_status) ||
    WTERMSIG(actor_status)!=SIGKILL){result=84;goto done;}
 actor=-1;
 struct pollfd observed={.fd=subject_pidfd,.events=POLLIN,.revents=0};
 int n=poll(&observed,1,700);
 if(n<0){result=85;goto done;}
#ifdef NW07_TEST_DISABLE_BREAKAWAY
 if(n!=1 || !(observed.revents&POLLIN)){result=86;goto done;}
 result=55; /* no escape => cannot show group-kill blind spot */
#else
 if(n!=0){result=87;goto done;}
 result=0; /* escaped subject alive => group SIGKILL did not drain it */
#endif
done:
 if(subject_pidfd>=0){
#ifdef SYS_pidfd_send_signal
  if(subject>1 && syscall(SYS_pidfd_send_signal,subject_pidfd,SIGKILL,NULL,0)<0 && errno==ENOSYS)
   (void)kill(subject,SIGKILL);
#else
  if(subject>1)(void)kill(subject,SIGKILL);
#endif
  (void)close(subject_pidfd);
 } else if(subject>1){(void)kill(subject,SIGKILL);}
 if(actor>1){(void)kill(actor,SIGKILL);if(bounded_reap(actor,&actor_status)<0)result=91;}
 if(subject>1 && bounded_reap(subject,&subject_status)<0)result=88;
 (void)close(ready[0]);
 return result;
#endif
}
int main(void){
 int rc=fixture();
 if(rc==0)puts("NW07_SETSID_BREAKAWAY_SURVIVED_GROUP_KILL (NOT_CGROUP_OR_WORKER_ACCEPTANCE)");
 else fprintf(stderr,"NW07_BREAKAWAY_FIXTURE_BLOCKED=%d\n",rc);
 return rc;
}
`;

test('AI-07 Linux setsid breakaway survives process-group kill until independently reaped', {
  skip:process.platform!=='linux'?'Linux-only native negative test; NOT_RUN':false,
  timeout:25000,
},()=>{
  const dir=mkdtempSync(join(tmpdir(),'nw07-breakaway-negative-'));
  try{
    const src=join(dir,'probe.c');
    writeFileSync(src,nativeSource,{mode:0o600});
    for(const v of [
      {name:'breakaway-witness',define:null,expected:0},
      {name:'no-breakaway-negative-control',define:'-DNW07_TEST_DISABLE_BREAKAWAY',expected:55},
    ] as const){
      const output=join(dir,v.name);
      const argv=['-std=c11','-O2','-Wall','-Wextra','-Werror'];
      if(v.define)argv.push(v.define);
      argv.push(src,'-o',output);
      const compiled=spawnSync('cc',argv,{encoding:'utf8',timeout:8000,
        env:{PATH:'/usr/bin:/bin'}});
      assert.equal(compiled.status,0,'Native compiler BLOCKED: '+
        String(compiled.error||compiled.stderr||compiled.stdout));
      const result=spawnSync(output,[],{encoding:'utf8',timeout:10000,
        env:{PATH:'/usr/bin:/bin'}});
      assert.equal(result.status,v.expected,v.name+' kernel BLOCKED: '+
        String(result.error||result.stderr||result.stdout));
      if(v.expected===0){
        assert.match(result.stdout,/NW07_SETSID_BREAKAWAY_SURVIVED_GROUP_KILL/);
        assert.match(result.stdout,/NOT_CGROUP_OR_WORKER_ACCEPTANCE/);
      }else{
        assert.match(result.stderr,/NW07_BREAKAWAY_FIXTURE_BLOCKED=55/);
        assert.doesNotMatch(result.stdout,/SURVIVED_GROUP_KILL/);
      }
    }
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:2,retryDelay:100});}
});
