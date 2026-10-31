import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/* Test-owned Linux subreaper, exact child PIDs, bounded waits and SIGALRM.
 * This is a negative fixture, NOT a trusted OS worker or grant. */
const nativeSource=String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static int bounded_wait(pid_t pid,int *status){
  for(int i=0;i<150;++i){
    pid_t got=waitpid(pid,status,WNOHANG);
    if(got==pid)return 0;
    if(got<0&&errno!=EINTR)return -1;
    struct timespec pause={.tv_sec=0,.tv_nsec=20000000L};
    (void)nanosleep(&pause,NULL);
  }
  return -1;
}
int main(void){
#ifdef SYS_pidfd_open
  if(prctl(PR_SET_CHILD_SUBREAPER,1)<0)return 70;
  int id_pipe[2],release[2];
  if(pipe(id_pipe)<0||pipe(release)<0)return 71;
  pid_t actor=fork();
  if(actor<0)return 72;
  if(actor==0){
    (void)close(id_pipe[0]);(void)close(release[1]);
    int self_pidfd=(int)syscall(SYS_pidfd_open,getpid(),0);
    if(self_pidfd<0)_exit(73);
    pid_t subject=fork();
    if(subject<0)_exit(74);
    if(subject==0){
      (void)close(id_pipe[1]);
      alarm(8);
      char permission=0;
      if(read(release[0],&permission,1)!=1||permission!='Y')_exit(75);
      if(prctl(PR_SET_PDEATHSIG,SIGKILL)<0)_exit(76);
#ifdef NW07_TEST_DISABLE_PIDFD_READBACK
      _exit(0); /* broken acceptance: dead parent cannot signal */
#else
      struct pollfd watch={.fd=self_pidfd,.events=POLLIN|POLLHUP};
      int rc=poll(&watch,1,0);
      if(rc==1&&(watch.revents&POLLIN))_exit(87);
      _exit(88);
#endif
    }
    (void)close(release[0]);
    if(write(id_pipe[1],&subject,sizeof(subject))!=(ssize_t)sizeof(subject))_exit(77);
    _exit(0);
  }
  (void)close(id_pipe[1]);(void)close(release[0]);
  pid_t subject=-1;int state=0,actor_state=0;
  int result=0;
  struct pollfd ready={.fd=id_pipe[0],.events=POLLIN};
  if(poll(&ready,1,2500)!=1||(ready.revents&POLLIN)==0 ||
     read(id_pipe[0],&subject,sizeof(subject))!=(ssize_t)sizeof(subject) ||
     subject<=1){result=78;goto done;}
  if(bounded_wait(actor,&actor_state)!=0){result=79;goto done;}
  actor=-1;
  if(!WIFEXITED(actor_state)||WEXITSTATUS(actor_state)!=0){result=80;goto done;}
  if(write(release[1],"Y",1)!=1){result=81;goto done;}
  if(bounded_wait(subject,&state)!=0){result=82;goto done;}
  subject=-1;
  if(!WIFEXITED(state)){result=83;goto done;}
#ifdef NW07_TEST_DISABLE_PIDFD_READBACK
  if(WEXITSTATUS(state)!=0){result=84;goto done;}
  fputs("NW07_UNSAFE_EARLY_ORPHAN_WOULD_PASS\n",stderr);
  result=55;
#else
  if(WEXITSTATUS(state)!=87){result=85;goto done;}
  puts("NW07_PIDFD_EARLY_ORPHAN_BLOCKED (NOT_WORKER_ACCEPTANCE)");
#endif
done:
  if(actor>1){(void)kill(actor,SIGKILL);(void)bounded_wait(actor,&actor_state);}
  if(subject>1){(void)kill(subject,SIGKILL);(void)bounded_wait(subject,&state);}
  (void)close(id_pipe[0]);(void)close(release[1]);
  return result;
#else
  return 91;
#endif
}
`;
test('AI-07 kernel pidfd rejects parent already dead before child PDEATHSIG', {
  skip:process.platform!=='linux'?'Linux-only kernel negative; NOT_RUN elsewhere':false,
  timeout:25000,
},()=>{
  const dir=mkdtempSync(join(tmpdir(),'nw07-pidfd-orphan-'));
  try{
    const source=join(dir,'fixture.c');
    writeFileSync(source,nativeSource,{mode:0o600});
    for(const v of [
      {name:'pidfd',define:null,expected:0},
      {name:'unprotected',define:'-DNW07_TEST_DISABLE_PIDFD_READBACK',expected:55},
    ] as const){
      const exe=join(dir,v.name);
      const args=['-std=c11','-O2','-Wall','-Wextra','-Werror'];
      if(v.define)args.push(v.define);
      args.push(source,'-o',exe);
      const built=spawnSync('cc',args,{encoding:'utf8',
        timeout:8000,env:{PATH:'/usr/bin:/bin'}});
      assert.equal(built.status,0,String(built.stderr||built.error||built.stdout));
      const run=spawnSync(exe,[],{encoding:'utf8',timeout:10000,
        env:{PATH:'/usr/bin:/bin'}});
      assert.equal(run.status,v.expected,
        v.name+': '+String(run.stderr||run.error||run.stdout));
      if(v.expected===0){
        assert.match(run.stdout,/NW07_PIDFD_EARLY_ORPHAN_BLOCKED/);
        assert.match(run.stdout,/NOT_WORKER_ACCEPTANCE/);
      }else{
        assert.match(run.stderr,/NW07_UNSAFE_EARLY_ORPHAN_WOULD_PASS/);
        assert.doesNotMatch(run.stdout,/PIDFD_EARLY_ORPHAN_BLOCKED/);
      }
    }
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:2,retryDelay:100});}
});
