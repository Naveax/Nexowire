import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * Real disposable Linux kernel test, NOT a task worker or OS sandbox acceptance.
 * Both processes are forked exclusively by this test fixture; a subreaper
 * and PIDFD track the exact identity, with alarm/cleanup fallback on failure.
 * Requires pidfd_open and PR_SET_CHILD_SUBREAPER; unsupported means BLOCKED.
 */
const nativeFixture=String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int read_ready(int fd,void *out,size_t n,int milliseconds){
  struct pollfd p={.fd=fd,.events=POLLIN};
  int ok;
  do {ok=poll(&p,1,milliseconds);} while(ok<0 && errno==EINTR);
  if(ok!=1 || !(p.revents&POLLIN))return -1;
  return read(fd,out,n)==(ssize_t)n?0:-1;
}
int main(void){
  /* Test-owned subtree only: subreaper allows waitpid cleanup of grandchild. */
  if(prctl(PR_SET_CHILD_SUBREAPER,1)<0)return 39;
  int parent_pipe[2],ack_pipe[2],child_pipe[2];
  if(pipe(parent_pipe)||pipe(ack_pipe)||pipe(child_pipe))return 40;
  pid_t actor=fork();
  if(actor<0)return 41;
  if(actor==0){
    close(parent_pipe[0]);close(ack_pipe[1]);
#ifndef NW07_TEST_DISABLE_PDEATHSIG
    pid_t original=getpid();
#endif
    pid_t subject=fork();
    if(subject<0)_exit(42);
    if(subject==0){
      close(parent_pipe[1]);close(ack_pipe[0]);close(child_pipe[0]);
#ifndef NW07_TEST_DISABLE_PDEATHSIG
      if(prctl(PR_SET_PDEATHSIG,SIGKILL)<0)_exit(43);
      if(getppid()!=original)_exit(44);
#endif
      alarm(8); /* failsafe: no surviving test-owned child after failure */
      char yes='R';
      if(write(child_pipe[1],&yes,1)!=1)_exit(45);
      for(;;)pause();
    }
    close(child_pipe[1]);
    char ready=0;
    if(read_ready(child_pipe[0],&ready,1,2000)<0 || ready!='R')_exit(46);
    if(write(parent_pipe[1],&subject,sizeof(subject))!=(ssize_t)sizeof(subject))_exit(47);
    char ack=0;
    if(read_ready(ack_pipe[0],&ack,1,2000)<0 || ack!='K')_exit(48);
    _exit(0);
  }
  close(parent_pipe[1]);close(ack_pipe[0]);close(child_pipe[0]);close(child_pipe[1]);
  pid_t subject=0;
  int result=0,fd=-1;
  if(read_ready(parent_pipe[0],&subject,sizeof(subject),2500)<0 || subject<=1){result=50;goto cleanup;}
#ifdef SYS_pidfd_open
  fd=(int)syscall(SYS_pidfd_open,subject,0);
#else
  result=51;goto cleanup;
#endif
  if(fd<0){result=52;goto cleanup;}
  if(write(ack_pipe[1],"K",1)!=1){result=53;goto cleanup;}
  int status=0;
  int reaped_actor=0;
  for(int attempt=0;attempt<150;attempt++){
    pid_t got=waitpid(actor,&status,WNOHANG);
    if(got==actor){reaped_actor=1;break;}
    if(got<0 && errno!=EINTR)break;
    struct timespec nap={.tv_sec=0,.tv_nsec=20000000L};
    (void)nanosleep(&nap,NULL);
  }
  if(!reaped_actor){result=54;goto cleanup;}
  actor=-1;
  if(!WIFEXITED(status) || WEXITSTATUS(status)!=0){result=54;goto cleanup;}
  struct pollfd observed={.fd=fd,.events=POLLIN};
  int ok;
  do {ok=poll(&observed,1,1500);} while(ok<0 && errno==EINTR);
  if(ok!=1 || !(observed.revents&POLLIN)){result=55;goto cleanup;}
  int subject_status=0;
  if(waitpid(subject,&subject_status,0)!=subject ||
     !WIFSIGNALED(subject_status) || WTERMSIG(subject_status)!=SIGKILL){result=56;goto cleanup;}
  subject=-1;
  puts("NW07_ISOLATED_PARENT_DEATH_PIDFD_KERNEL_NEGATIVE_PASS (NOT_TASK_WORKER_ACCEPTANCE)");
cleanup:
  if(result!=0)fprintf(stderr,"NW07_KERNEL_FIXTURE_BLOCKED=%d\n",result);
  if(actor>1){
    (void)kill(actor,SIGKILL); /* only own unreaped test child */
    int s=0, reaped=0;
    for(int attempt=0;attempt<150;attempt++){
      pid_t got=waitpid(actor,&s,WNOHANG);
      if(got==actor){reaped=1;break;}
      if(got<0 && errno==ECHILD){reaped=1;break;}
      if(got<0 && errno!=EINTR)break;
      struct timespec nap={.tv_sec=0,.tv_nsec=20000000L};
      (void)nanosleep(&nap,NULL);
    }
    if(!reaped)result=58;
  }
#ifdef SYS_pidfd_send_signal
  if(fd>=0 && subject>1){(void)syscall(SYS_pidfd_send_signal,fd,SIGKILL,NULL,0);}
  else if(subject>1){(void)kill(subject,SIGKILL);}
#else
  if(subject>1){(void)kill(subject,SIGKILL);}
#endif
  /* Exact subreaper-owned child only: bounded wait, no arbitrary host PID. */
  if(subject>1){
    int final_status=0;
    for(int attempt=0;attempt<240;attempt++){
      pid_t got=waitpid(subject,&final_status,WNOHANG);
      if(got==subject) {subject=-1;break;}
      if(got<0 && errno==ECHILD){subject=-1;break;}
      if(got<0 && errno!=EINTR)break;
      struct timespec nap={.tv_sec=0,.tv_nsec=20000000L};
      (void)nanosleep(&nap,NULL);
    }
    if(subject>1)result=57; /* no verified reaping means blocked */
  }
  if(fd>=0)close(fd);
  close(parent_pipe[0]);close(ack_pipe[1]);
  return result;
}
`;

test('AI-07 disposable Linux kernel parent-death fence has a failing negative control', {
  skip: process.platform !== 'linux' ? 'Linux-only kernel test; NOT_RUN on this OS' : false,
  timeout: 25000,
}, () => {
  const dir=mkdtempSync(join(tmpdir(),'nw07-pdeathsig-'));
  try {
    const src=join(dir,'fixture.c');
    writeFileSync(src,nativeFixture,{mode:0o600});
    for(const [label,flag,expected] of [
      ['fenced','',0],
      ['no-pdeathsig-negative-control','-DNW07_TEST_DISABLE_PDEATHSIG',55],
    ] as const){
      const output=join(dir,label);
      const args=['-std=c11','-O2','-Wall','-Wextra','-Werror'];
      if(flag)args.push(flag);
      args.push(src,'-o',output);
      const compiled=spawnSync('cc',args,{encoding:'utf8',timeout:8000,env:{PATH:'/usr/bin:/bin'}});
      assert.equal(compiled.status,0,'BLOCKED native compile: '+
        String(compiled.stderr||compiled.error||compiled.stdout));
      const checked=spawnSync(output,[],{encoding:'utf8',timeout:10500,
        env:{PATH:'/usr/bin:/bin'}});
      assert.equal(checked.status,expected,
        'Kernel result '+label+': '+String(checked.stderr||checked.error||checked.stdout));
      if(expected===0){
        assert.match(checked.stdout,/NW07_ISOLATED_PARENT_DEATH_PIDFD_KERNEL_NEGATIVE_PASS/);
        assert.doesNotMatch(checked.stdout,/TASK_WORKER_ACCEPTED/);
      } else {
        assert.match(checked.stderr,/NW07_KERNEL_FIXTURE_BLOCKED=55/);
        assert.doesNotMatch(checked.stdout,/PIDFD_KERNEL_NEGATIVE_PASS/);
      }
    }
  }finally {rmSync(dir,{recursive:true,force:true,maxRetries:2,retryDelay:100});}
});
