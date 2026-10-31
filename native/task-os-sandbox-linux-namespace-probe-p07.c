/*
 * Nexowire #07 SOURCE-ONLY: Linux kernel namespace diagnostic, NOT A WORKER.
 * Never accepts command, argv, payload, pathname, credentials or arbitrary
 * environment. No Nexowire task can execute through this entry point.
 *
 * The probe demonstrates a narrow rootless Linux user/mount/PID/net isolation
 * feasibility check, not task containment. It has no resource cgroup,
 * independent attester, trusted publisher, task-capable seccomp policy or revoke drain.
 * Build: cc -std=c11 -O2 -Wall -Wextra -Werror FILE.c -o PROBE
 */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <poll.h>
#include <time.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <netinet/in.h>

static int put(const char *path,const char *content) {
  int fd=open(path,O_WRONLY|O_CLOEXEC|O_NOFOLLOW);
  if(fd<0)return -1;
  size_t len=strlen(content);
  ssize_t n=write(fd,content,len);
  int saved=errno;
  if(close(fd)<0)return -1;
  errno=saved;
  return n==(ssize_t)len?0:-1;
}
static int map_ids(uid_t outer_uid,gid_t outer_gid) {
  char line[80];
  if(put("/proc/self/setgroups","deny\n")<0)return -1;
  if(snprintf(line,sizeof(line),"0 %lu 1\n",(unsigned long)outer_uid)<0 ||
     put("/proc/self/uid_map",line)<0)return -1;
  if(snprintf(line,sizeof(line),"0 %lu 1\n",(unsigned long)outer_gid)<0 ||
     put("/proc/self/gid_map",line)<0)return -1;
  return 0;
}
/*
 * Source-only minimal SECcomp evidence: after this syscall fence there is no
 * shell, exec, socket, filesystem or child-creation syscall available.
 * This probe never executes task payload; no production sandbox is accepted.
 */
#if defined(__x86_64__)
#define NW07_SECCOMP_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NW07_SECCOMP_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported native seccomp audit architecture: fail closed
#endif
#define NW07_SC_ALLOW(n) \
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_##n,0,1), \
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
static int install_probe_seccomp(void) {
  const struct sock_filter filter[] = {
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,(unsigned)offsetof(struct seccomp_data,arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,NW07_SECCOMP_ARCH,1,0),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,(unsigned)offsetof(struct seccomp_data,nr)),
    /* No inherited outputs remain after close_range(0,...), so even write
     * is unnecessary. Only termination and signal return are permitted. */
    NW07_SC_ALLOW(exit),
    NW07_SC_ALLOW(exit_group),
    NW07_SC_ALLOW(rt_sigreturn),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  };
  const struct sock_fprog program = {
    .len=(unsigned short)(sizeof(filter)/sizeof(filter[0])),
    .filter=(struct sock_filter*)filter,
  };
  if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)<0)return -1;
  if(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program)<0)return -1;
  return 0;
}
/*
 * This is an OUTER PARENT process kernel readback of the disposable probe,
 * independent from child stdout. It remains the SAME unsigned program,
 * hence is NOT a trusted production verifier or protected principal.
 */
static int observe_kernel_namespaces(pid_t child,uid_t outer_uid) {
  const char *names[]={"user","mnt","net","ipc","uts"};
  for(size_t i=0;i<sizeof(names)/sizeof(names[0]);++i) {
    char path[96];
    struct stat observed, host;
    int n=snprintf(path,sizeof(path),"/proc/%ld/ns/%s",(long)child,names[i]);
    if(n<0 || (size_t)n>=sizeof(path) ||
       stat(path,&observed)<0)return -1;
    n=snprintf(path,sizeof(path),"/proc/self/ns/%s",names[i]);
    if(n<0 || (size_t)n>=sizeof(path) ||
       stat(path,&host)<0)return -1;
    if(host.st_dev==observed.st_dev && host.st_ino==observed.st_ino)return -1;
  }
  char path[96],map[128];
  int n=snprintf(path,sizeof(path),"/proc/%ld/uid_map",(long)child);
  if(n<0 || (size_t)n>=sizeof(path))return -1;
  int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  if(fd<0)return -1;
  ssize_t got=read(fd,map,sizeof(map)-1);
  int saved=errno;
  if(close(fd)<0)return -1;
  errno=saved;
  if(got<=0)return -1;
  map[got]='\0';
  unsigned long inner=1,outer=0,count=0,extra=0;
  if(sscanf(map," %lu %lu %lu %lu",&inner,&outer,&count,&extra)!=3 ||
     inner!=0 || outer!=(unsigned long)outer_uid || count!=1)return -1;
  return 0;
}

static int kernel_child(const char *root,int ready_fd,int resume_fd) {
  /* Self-observed namespace inode difference: NOT an independent attester. */
  struct stat user_before, net_before, user_after, net_after;
  if(stat("/proc/self/ns/user",&user_before)<0 ||
     stat("/proc/self/ns/net",&net_before)<0)return 27;
  uid_t outer_uid=getuid();
  gid_t outer_gid=getgid();
  if(unshare(CLONE_NEWUSER|CLONE_NEWNS|CLONE_NEWNET|
             CLONE_NEWIPC|CLONE_NEWUTS|CLONE_NEWPID)<0)return 30;
  if(map_ids(outer_uid,outer_gid)<0)return 31;
  if(stat("/proc/self/ns/user",&user_after)<0 ||
     stat("/proc/self/ns/net",&net_after)<0 ||
     (user_before.st_dev==user_after.st_dev &&
      user_before.st_ino==user_after.st_ino) ||
     (net_before.st_dev==net_after.st_dev &&
      net_before.st_ino==net_after.st_ino))return 50;
  /* Parent must read real kernel namespace inodes and uid_map before resume.
   * A forged stdout or local bool cannot satisfy this synchronized barrier. */
  const char announced='R';
  char approval=0;
  if(write(ready_fd,&announced,1)!=1 ||
     read(resume_fd,&approval,1)!=1 || approval!='Y')return 61;
  if(close(ready_fd)<0||close(resume_fd)<0)return 62;
  if(mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL)<0)return 32;
  if(mount("tmpfs",root,"tmpfs",MS_NODEV|MS_NOSUID|MS_NOEXEC,
           "size=2m,mode=0700")<0)return 33;
  char oldroot[4096];
  if(snprintf(oldroot,sizeof(oldroot),"%s/.old",root)>=(int)sizeof(oldroot))
    return 34;
  if(mkdir(oldroot,0700)<0)return 35;
  pid_t pid=fork();
  if(pid<0)return 36;
  if(pid>0) {
    int status=0;
    while(waitpid(pid,&status,0)<0)if(errno!=EINTR)return 37;
    return WIFEXITED(status)?WEXITSTATUS(status):38;
  }
  /* Child is PID 1 of the new PID namespace. If its outer forked parent
   * dies, request kernel termination rather than leaving an orphaned init.
   * The parent also kills its isolated process group on a timed-out probe.
   * This is not an OS task cleanup proof for production. */
  if(prctl(PR_SET_PDEATHSIG,SIGKILL)<0)_exit(55);
  if(chdir(root)<0)_exit(39);
  if(syscall(SYS_pivot_root,".",".old")<0)_exit(40);
  if(chdir("/")<0)_exit(41);
  if(umount2("/.old",MNT_DETACH)<0||rmdir("/.old")<0)_exit(42);
  /* An inherited stdin/stdout/stderr can itself be a Broker IPC socket or
   * credential-bearing open file. Close *all* descriptors, including 0/1/2,
   * rather than claiming that they are harmless terminal streams. Parent
   * prints the static selftest marker after observing our final exit status.
   */
#ifdef SYS_close_range
  if(syscall(SYS_close_range,0U,~0U,0U)<0)_exit(43);
#else
  /* Never accept a finite-FD-loop as proof that all handles were closed. */
  _exit(43);
#endif
  for(int fd=0;fd<=2;++fd) {
    errno=0;
    if(fcntl(fd,F_GETFD)!=-1 || errno!=EBADF)_exit(54);
  }
  if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)<0)_exit(44);
  struct stat st;
  if(getpid()!=1||getuid()!=0)_exit(45);
  if(stat("/etc/passwd",&st)==0||errno!=ENOENT)_exit(46);
  if(stat("/proc/self/environ",&st)==0||errno!=ENOENT)_exit(47);
  if(install_probe_seccomp()<0)_exit(51);
  /* Direct kernel denial, not a connection-refused / no-listener false pass. */
  errno=0;
  int s=socket(AF_INET,SOCK_STREAM|SOCK_CLOEXEC,0);
  if(s!=-1 || errno!=EPERM)_exit(52);
  /* No stdout, stderr, inherited socket or host file remains here. */
  _exit(0);
}
/* Bound both readiness and final reaping. The only process we may signal
 * is the direct child forked by this disposable diagnostic. Never target a
 * caller-supplied PID, task or real Agent process. */
static int monotonic_ms(long long *out) {
  struct timespec now;
  if(clock_gettime(CLOCK_MONOTONIC,&now)<0)return -1;
  *out=(long long)now.tv_sec*1000LL+(long long)now.tv_nsec/1000000LL;
  return 0;
}
static ssize_t read_ready_bounded(int fd,char *out) {
  long long start,now;
  if(monotonic_ms(&start)<0)return -1;
  for(;;) {
    if(monotonic_ms(&now)<0)return -1;
    long long remaining=5000LL-(now-start);
    if(remaining<=0)return -1;
    struct pollfd pfd={.fd=fd,.events=POLLIN|POLLHUP,.revents=0};
    int ready=poll(&pfd,1,(int)remaining);
    if(ready<0&&errno==EINTR)continue;
    if(ready<=0)return -1;
    ssize_t n=read(fd,out,1);
    if(n<0&&errno==EINTR)continue;
    return n;
  }
}
static int terminate_owned_child(pid_t pid,int *status) {
  if(pid<=1)return -1;
  /* Kill only the own unreaped diagnostic child and verified process group.
   * A group-signal failure must NOT prevent attempting direct-child cleanup. */
  int signals_ok=1;
  pid_t pgid=getpgid(pid);
  if(pgid==pid && kill(-pid,SIGKILL)<0 && errno!=ESRCH)signals_ok=0;
  if(pgid<0 && errno!=ESRCH)signals_ok=0;
  if(kill(pid,SIGKILL)<0 && errno!=ESRCH)signals_ok=0;
  /* SIGKILL itself is not a verified reaping receipt: bounded WNOHANG
   * prevents a stuck child from hanging the diagnostic indefinitely. */
  long long start,now;
  if(monotonic_ms(&start)<0)return -1;
  for(;;) {
    pid_t got=waitpid(pid,status,WNOHANG);
    if(got==pid)return signals_ok?-2:-1;
    if(got<0&&errno!=EINTR)return -1;
    if(monotonic_ms(&now)<0||now-start>=5000LL)return -1;
    const struct timespec pause={.tv_sec=0,.tv_nsec=20000000L};
    (void)nanosleep(&pause,NULL);
  }
}
static int wait_child_bounded(pid_t pid,int *status) {
  long long start,now;
  if(monotonic_ms(&start)<0)return terminate_owned_child(pid,status);
  for(;;) {
    pid_t got=waitpid(pid,status,WNOHANG);
    if(got==pid)return 0;
    if(got<0&&errno!=EINTR)return -1;
    if(monotonic_ms(&now)<0||now-start>=12000LL)
      return terminate_owned_child(pid,status);
    const struct timespec pause={.tv_sec=0,.tv_nsec=20000000L};
    (void)nanosleep(&pause,NULL);
  }
}

int main(int argc,char **argv) {
  if(argc!=2||strcmp(argv[1],"--selftest-only")!=0) {
    fputs("NW07_SOURCE_ONLY_NO_TASK_EXEC\n",stderr);
    return 64;
  }
  char template[]="/tmp/nw07-namespace-source-XXXXXX";
  char *root=mkdtemp(template);
  if(!root)return 70;
  int ready[2],resume[2];
  if(pipe2(ready,O_CLOEXEC)<0){(void)rmdir(root);return 75;}
  if(pipe2(resume,O_CLOEXEC)<0){
    (void)close(ready[0]);(void)close(ready[1]);
    (void)rmdir(root);return 76;
  }
  uid_t outer_uid=getuid();
  pid_t pid=fork();
  if(pid<0) {
    (void)close(ready[0]);(void)close(ready[1]);
    (void)close(resume[0]);(void)close(resume[1]);
    (void)rmdir(root);return 71;
  }
  if(pid==0) {
    (void)close(ready[0]);(void)close(resume[1]);
    /* Only this disposable diagnostic owns the process group. The parent
     * never targets arbitrary PIDs, a live Agent or a host task process. */
    if(setpgid(0,0)<0)_exit(80);
    if(clearenv()!=0)_exit(72);
    int code=kernel_child(root,ready[1],resume[0]);
    _exit(code);
  }
  (void)close(ready[1]);(void)close(resume[0]);
  char announcement=0;
  ssize_t bytes=read_ready_bounded(ready[0],&announcement);
  int independently_observed=(bytes==1 && announcement=='R' &&
    observe_kernel_namespaces(pid,outer_uid)==0);
  (void)close(ready[0]);
  const char approval=independently_observed?'Y':'N';
  if(bytes==1 && announcement=='R') {
    /* An early child exit must never kill the parent via SIGPIPE, leak the
     * temporary root, or permit a false positive resume. */
    if(signal(SIGPIPE,SIG_IGN)==SIG_ERR ||
       write(resume[1],&approval,1)!=1)independently_observed=0;
  }
  (void)close(resume[1]);
  int status=0;
  int waited=wait_child_bounded(pid,&status);
  if(rmdir(root)<0)return 73;
  if(waited==-2)return 78; /* Timed out: child killed, never PASS. */
  if(waited!=0||!WIFEXITED(status))return 74;
  if(!independently_observed)return 77;
  int rc=WEXITSTATUS(status);
  if(rc!=0)fprintf(stderr,"NW07_NAMESPACE_PROBE_BLOCKED stage=%d\n",rc);
  else puts("NW07_NAMESPACE_SECCOMP_SOURCE_SELFTEST_OK (NOT_RUNTIME_OR_PHYSICAL_ACCEPTANCE)");
  return rc;
}
