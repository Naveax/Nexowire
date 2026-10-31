import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * Real Linux openat2 negative fixture in a disposable temporary directory.
 * No user task, host credential, external network, privileged mount or Agent
 * is touched. The fixture demonstrates openat2's hardlink LIMITATION too.
 * This is NOT an independently attested production filesystem sandbox.
 */
const nativeFixture=String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static int fixture(void){
#ifndef SYS_openat2
 return 70;
#else
 char pattern[]="/tmp/nw07-openat2-source-XXXXXX";
 if(!mkdtemp(pattern))return 71;
 char root[PATH_MAX],allowed[PATH_MAX],outside[PATH_MAX],alias[PATH_MAX],hard[PATH_MAX];
 if(snprintf(root,sizeof(root),"%s/root",pattern)>=(int)sizeof(root) ||
    snprintf(allowed,sizeof(allowed),"%s/allowed",root)>=(int)sizeof(allowed) ||
    snprintf(outside,sizeof(outside),"%s/outside",pattern)>=(int)sizeof(outside) ||
    snprintf(alias,sizeof(alias),"%s/alias",root)>=(int)sizeof(alias) ||
    snprintf(hard,sizeof(hard),"%s/hard",root)>=(int)sizeof(hard))return 72;
 int result=0,dirfd=-1,fd=-1;
 struct stat outside_stat;
 if(mkdir(root,0700)<0){result=73;goto cleanup;}
 fd=open(allowed,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600);
 if(fd<0){result=74;goto cleanup;}
 if(write(fd,"SAFE",4)!=4){result=75;goto cleanup;}
 close(fd);fd=-1;
 fd=open(outside,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600);
 if(fd<0){result=76;goto cleanup;}
 if(write(fd,"SYNTHETIC",9)!=9){result=77;goto cleanup;}
 if(fstat(fd,&outside_stat)<0){result=78;goto cleanup;}
 close(fd);fd=-1;
 if(symlink("allowed",alias)<0){result=79;goto cleanup;}
 if(link(outside,hard)<0){result=80;goto cleanup;}
 dirfd=open(root,O_RDONLY|O_DIRECTORY|O_CLOEXEC);
 if(dirfd<0){result=81;goto cleanup;}
 struct open_how how={.flags=O_RDONLY|O_CLOEXEC,
   .resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV};
#ifdef NW07_TEST_DISABLE_TRAVERSAL_GUARD
 how.resolve &= ~((unsigned long long)RESOLVE_BENEATH);
#endif
#ifdef NW07_TEST_DISABLE_SYMLINK_FENCE
 how.resolve &= ~((unsigned long long)RESOLVE_NO_SYMLINKS);
#endif
 fd=(int)syscall(SYS_openat2,dirfd,"allowed",&how,sizeof(how));
 if(fd<0){result=82;goto cleanup;}
 struct stat good_stat;
 if(fstat(fd,&good_stat)<0||good_stat.st_nlink!=1){result=83;goto cleanup;}
 close(fd);fd=-1;
 errno=0;
 fd=(int)syscall(SYS_openat2,dirfd,"../outside",&how,sizeof(how));
#ifdef NW07_TEST_DISABLE_TRAVERSAL_GUARD
 if(fd<0){result=84;goto cleanup;}
 result=55;goto cleanup;
#else
 if(fd>=0||errno!=EXDEV){result=85;goto cleanup;}
#endif
 errno=0;
 fd=(int)syscall(SYS_openat2,dirfd,"alias",&how,sizeof(how));
#ifdef NW07_TEST_DISABLE_SYMLINK_FENCE
 if(fd<0){result=86;goto cleanup;}
 result=56;goto cleanup;
#else
 if(fd>=0||errno!=ELOOP){result=87;goto cleanup;}
#endif
 fd=(int)syscall(SYS_openat2,dirfd,"hard",&how,sizeof(how));
 if(fd<0){result=88;goto cleanup;}
 struct stat hard_stat;
 if(fstat(fd,&hard_stat)<0){result=89;goto cleanup;}
 if(hard_stat.st_dev!=outside_stat.st_dev ||
    hard_stat.st_ino!=outside_stat.st_ino || hard_stat.st_nlink<=1){result=90;goto cleanup;}
#ifdef NW07_TEST_DISABLE_HARDLINK_FENCE
 result=57;goto cleanup;
#else
 /* openat2 DOES NOT block a hardlinked outside inode. A test-only nlink
  * check prevents incorrectly claiming that RESOLVE_* solves hardlinks.
  * Real security requires independently attested inode/content ownership. */
 result=0;
#endif
cleanup:
 if(fd>=0)close(fd);
 if(dirfd>=0)close(dirfd);
 int clean=0;
 if(unlink(hard)<0 && errno!=ENOENT)clean=1;
 if(unlink(alias)<0 && errno!=ENOENT)clean=1;
 if(unlink(allowed)<0 && errno!=ENOENT)clean=1;
 if(unlink(outside)<0 && errno!=ENOENT)clean=1;
 if(rmdir(root)<0 && errno!=ENOENT)clean=1;
 if(rmdir(pattern)<0)clean=1;
 if(clean)return 91; /* fixture-owned temporary paths only */
 return result;
#endif
}
int main(void){
 int rc=fixture();
 if(rc==0)puts("NW07_OPENAT2_SYMLINK_TRAVERSAL_HARDLINK_NEGATIVE_OK (NOT_NATIVE_WORKER_ACCEPTANCE)");
 else fprintf(stderr,"NW07_OPENAT2_BOUNDARY_BLOCKED=%d\n",rc);
 return rc;
}
`;

test('AI-07 Linux openat2 traversal and symlink denial exposes hardlink limitation', {
  skip: process.platform!=='linux' ? 'Linux-only kernel negative; NOT_RUN' : false,
  timeout: 30000,
},()=>{
  const dir=mkdtempSync(join(tmpdir(),'nw07-openat2-build-'));
  try {
    const source=join(dir,'fixture.c');
    writeFileSync(source,nativeFixture,{mode:0o600});
    const variants=[
      {name:'protected',define:null,expected:0},
      {name:'traversal-unprotected',define:'-DNW07_TEST_DISABLE_TRAVERSAL_GUARD',expected:55},
      {name:'symlink-unprotected',define:'-DNW07_TEST_DISABLE_SYMLINK_FENCE',expected:56},
      {name:'hardlink-unguarded',define:'-DNW07_TEST_DISABLE_HARDLINK_FENCE',expected:57},
    ] as const;
    for(const v of variants){
      const output=join(dir,v.name);
      const args=['-std=c11','-O2','-Wall','-Wextra','-Werror'];
      if(v.define)args.push(v.define);
      args.push(source,'-o',output);
      const built=spawnSync('cc',args,{
        encoding:'utf8',timeout:12000,env:{PATH:'/usr/bin:/bin'},
      });
      assert.equal(built.status,0,
        v.name+' compile BLOCKED: '+String(built.stderr||built.error||built.stdout));
      const checked=spawnSync(output,[],{
        encoding:'utf8',timeout:8000,env:{PATH:'/usr/bin:/bin'},
      });
      assert.equal(checked.status,v.expected,
        v.name+' kernel BLOCKED: '+String(checked.stderr||checked.error||checked.stdout));
      if(v.expected===0){
        assert.match(checked.stdout,/NW07_OPENAT2_SYMLINK_TRAVERSAL_HARDLINK_NEGATIVE_OK/);
        assert.match(checked.stdout,/NOT_NATIVE_WORKER_ACCEPTANCE/);
      }else{
        assert.match(checked.stderr,new RegExp('NW07_OPENAT2_BOUNDARY_BLOCKED='+v.expected));
        assert.doesNotMatch(checked.stdout,/NEGATIVE_OK/);
      }
    }
  }finally{
    rmSync(dir,{recursive:true,force:true,maxRetries:2,retryDelay:100});
  }
});
