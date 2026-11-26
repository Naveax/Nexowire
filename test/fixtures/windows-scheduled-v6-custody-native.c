/* Hosted disposable acceptance ONLY. Never package this executable.
 * The only launched image is this fixture itself, with a fixed peer mode.
 * The inspected PE is mapped SEC_IMAGE_NO_EXECUTE, never started. */
#include "../../native/windows-scheduled-v6-custody.c"
#include <psapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

static int failed(const char *name){
  fprintf(stderr,"NX_CUSTODY_FAIL %s win32=%lu\n",name,GetLastError());
  return 1;
}
static void pass(const char *name){printf("NX_CUSTODY_PASS %s\n",name);fflush(stdout);}
static BOOL hex_digest(const wchar_t *s,BYTE out[32]){
  if(wcslen(s)!=64)return FALSE;
  for(int i=0;i<32;++i){
    unsigned v=0;
    for(int j=0;j<2;++j){
      wchar_t c=s[i*2+j];
      if(c>=L'0'&&c<=L'9')v=v*16+(unsigned)(c-L'0');
      else if(c>=L'a'&&c<=L'f')v=v*16+(unsigned)(c-L'a'+10);
      else return FALSE;
    }
    out[i]=(BYTE)v;
  }
  return TRUE;
}
static BOOL sharing_denied(const char *stage,const wchar_t *p,DWORD access,DWORD flags){
  SetLastError(ERROR_SUCCESS);
  HANDLE h=CreateFileW(p,access,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
    NULL,OPEN_EXISTING,flags,NULL);
  DWORD error=h==INVALID_HANDLE_VALUE?GetLastError():ERROR_SUCCESS;
  if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);
  printf("NX_CUSTODY_SHARE stage=%s access=0x%08lx opened=%u win32=%lu expected=%lu\n",
    stage,(unsigned long)access,h!=INVALID_HANDLE_VALUE?1U:0U,
    (unsigned long)error,(unsigned long)ERROR_SHARING_VIOLATION);
  fflush(stdout);
  if(error!=ERROR_SHARING_VIOLATION){
    fprintf(stderr,"NX_CUSTODY_FAIL %s win32=%lu\n",stage,(unsigned long)error);
    return FALSE;
  }
  return TRUE;
}
/* A genuine baseline: an attributes-only directory open does not establish
 * share-delete custody. This is a disposable fixture, not a fallback.
 * Verify the expected behavior and prove DELETE access is available before
 * the real held-file test, not denied by a preexisting ACL or unrelated lock. */
static BOOL metadata_baseline(const wchar_t *dir){
  HANDLE meta=CreateFileW(dir,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,
    NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  if(meta==INVALID_HANDLE_VALUE)return FALSE;
  HANDLE candidate=CreateFileW(dir,DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
    NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
  DWORD error=candidate==INVALID_HANDLE_VALUE?GetLastError():ERROR_SUCCESS;
  printf("NX_CUSTODY_SHARE stage=metadata_only_baseline opened=%u win32=%lu expected=0\n",
    candidate!=INVALID_HANDLE_VALUE?1U:0U,(unsigned long)error);
  fflush(stdout);
  if(candidate!=INVALID_HANDLE_VALUE)CloseHandle(candidate);
  CloseHandle(meta);
  return error==ERROR_SUCCESS;
}
static BOOL mapped_source(const NX_HELD_FILE *f){
  HANDLE section=CreateFileMappingW(f->file,NULL,PAGE_READONLY|SEC_IMAGE_NO_EXECUTE,0,0,NULL);
  if(!section)return FALSE;
  void *view=MapViewOfFile(section,FILE_MAP_READ,0,0,0);
  BOOL ok=FALSE;
  if(view){
    MEMORY_BASIC_INFORMATION m={0};
    wchar_t mapped[32768],held[32768];
    DWORD a=GetMappedFileNameW(GetCurrentProcess(),view,mapped,32768);
    DWORD b=GetFinalPathNameByHandleW(f->file,held,32768,VOLUME_NAME_NT);
    ok=VirtualQuery(view,&m,sizeof(m))==sizeof(m)&&m.Type==MEM_IMAGE&&
      a>0&&a<32768&&b>0&&b<32768&&!_wcsicmp(mapped,held)&&nx_v6_recheck_file(f);
    UnmapViewOfFile(view);
  }
  CloseHandle(section);
  return ok;
}
static BOOL peer_identity(HANDLE process,DWORD pid,FILETIME creation){
  FILETIME c,e,k,u;
  return GetProcessId(process)==pid&&WaitForSingleObject(process,0)==WAIT_TIMEOUT&&
    GetProcessTimes(process,&c,&e,&k,&u)&&CompareFileTime(&c,&creation)==0;
}
static BOOL write_exact(HANDLE h,const void *p,DWORD len){
  DWORD n=0;return WriteFile(h,p,len,&n,NULL)&&n==len;
}
static BOOL read_exact(HANDLE h,void *p,DWORD len){
  DWORD n=0;return ReadFile(h,p,len,&n,NULL)&&n==len;
}
typedef struct NX_PEER_REPLY { DWORD pid; FILETIME creation; BYTE nonce[32]; } NX_PEER_REPLY;
static int peer_child(const wchar_t *read_arg,const wchar_t *write_arg){
  wchar_t *end1=NULL,*end2=NULL;
  unsigned long long a=wcstoull(read_arg,&end1,10),b=wcstoull(write_arg,&end2,10);
  if(!a||!b||a==b||!end1||*end1||!end2||*end2)return 2;
  HANDLE input=(HANDLE)(uintptr_t)a,output=(HANDLE)(uintptr_t)b;
  NX_PEER_REPLY reply={0};FILETIME e,k,u;
  reply.pid=GetCurrentProcessId();
  if(GetFileType(input)!=FILE_TYPE_PIPE||GetFileType(output)!=FILE_TYPE_PIPE||
     !GetProcessTimes(GetCurrentProcess(),&reply.creation,&e,&k,&u)||
     !read_exact(input,reply.nonce,32)||
     !write_exact(output,&reply,(DWORD)sizeof(reply)))return 3;
  // Parent closes input only after verifying held live process incarnation.
  BYTE last=0;DWORD got=0;
  if(ReadFile(input,&last,1,&got,NULL)||GetLastError()!=ERROR_BROKEN_PIPE)return 4;
  CloseHandle(input);CloseHandle(output);return 0;
}
static BOOL wait_reply(HANDLE h,HANDLE process,NX_PEER_REPLY *out){
  ULONGLONG began=GetTickCount64();
  while(GetTickCount64()-began<5000){
    DWORD avail=0;
    if(!PeekNamedPipe(h,NULL,0,NULL,&avail,NULL))return FALSE;
    if(avail>=sizeof(*out))return read_exact(h,out,(DWORD)sizeof(*out));
    if(WaitForSingleObject(process,0)!=WAIT_TIMEOUT)return FALSE;
    Sleep(10);
  }
  return FALSE;
}
/* Exact child handle, two endpoint allowlist, and live incarnation challenge.
 * This proves only the disposable peer transport, not a protected production
 * peer or equal-HIGH/SYSTEM isolation. No authority payload is exchanged. */
static int ipc_case(void){
  NX_PRIVATE_CHANNEL to={0},from={0},excluded={0};
  PROCESS_INFORMATION pi={0};
  STARTUPINFOEXW si={0};
  SIZE_T bytes=0;BOOL initialized=FALSE;
  int rc=1;DWORD code=99;
  wchar_t exe[32768],command[32768];
  FILETIME created,e,k,u;
  BYTE nonce[32];NX_PEER_REPLY reply={0};
  if(!nx_v6_open_channel(&to)||!nx_v6_open_channel(&from)||!nx_v6_open_channel(&excluded))goto done;
  if(!nx_noninheritable(to.read_end)||!nx_noninheritable(to.write_end)||
     !nx_noninheritable(from.read_end)||!nx_noninheritable(from.write_end))goto done;
  pass("anonymous_noninherited_endpoints");
  // Mark only child endpoints (and one deliberate excluded canary) inheritable.
  if(!SetHandleInformation(to.read_end,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT)||
     !SetHandleInformation(from.write_end,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT)||
     !SetHandleInformation(excluded.write_end,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT))goto done;
  HANDLE allowed[2]={to.read_end,from.write_end};
  InitializeProcThreadAttributeList(NULL,1,0,&bytes);
  if(!bytes)goto done;
  si.lpAttributeList=HeapAlloc(GetProcessHeap(),0,bytes);
  if(!si.lpAttributeList||!InitializeProcThreadAttributeList(si.lpAttributeList,1,0,&bytes))goto done;
  initialized=TRUE;
  if(!UpdateProcThreadAttribute(si.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      allowed,sizeof(allowed),NULL,NULL))goto done;
  DWORD length=GetModuleFileNameW(NULL,exe,32768);
  if(!length||length>=32768||swprintf_s(command,32768,L"\"%ls\" --peer %llu %llu",exe,
    (unsigned long long)(uintptr_t)to.read_end,(unsigned long long)(uintptr_t)from.write_end)<0)goto done;
  si.StartupInfo.cb=sizeof(si);
  if(!CreateProcessW(exe,command,NULL,NULL,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,
    NULL,NULL,&si.StartupInfo,&pi))goto done;
  CloseHandle(to.read_end);to.read_end=NULL;
  CloseHandle(from.write_end);from.write_end=NULL;
  CloseHandle(excluded.write_end);excluded.write_end=NULL;
  DWORD avail=0;
  if(PeekNamedPipe(excluded.read_end,NULL,0,NULL,&avail,NULL)||GetLastError()!=ERROR_BROKEN_PIPE)goto done;
  pass("explicit_handle_allowlist_excludes_inheritable_canary");
  if(!GetProcessTimes(pi.hProcess,&created,&e,&k,&u)||
     !peer_identity(pi.hProcess,pi.dwProcessId,created)||
     BCryptGenRandom(NULL,nonce,32,BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0||
     !write_exact(to.write_end,nonce,32)||!wait_reply(from.read_end,pi.hProcess,&reply)||
     reply.pid!=pi.dwProcessId||CompareFileTime(&created,&reply.creation)||
     memcmp(nonce,reply.nonce,32)||!peer_identity(pi.hProcess,reply.pid,reply.creation))goto done;
  pass("held_peer_pid_filetime_nonce");
  FILETIME wrong=created;wrong.dwLowDateTime^=1;
  if(peer_identity(pi.hProcess,pi.dwProcessId,wrong)||
     peer_identity(pi.hProcess,pi.dwProcessId^1U,created))goto done;
  pass("wrong_peer_incarnation_denied");
  CloseHandle(to.write_end);to.write_end=NULL;
  if(WaitForSingleObject(pi.hProcess,5000)!=WAIT_OBJECT_0||
     !GetExitCodeProcess(pi.hProcess,&code)||code!=0||
     peer_identity(pi.hProcess,pi.dwProcessId,created))goto done;
  pass("exited_peer_denied");
  rc=0;
done:
  nx_v6_close_channel(&to);nx_v6_close_channel(&from);nx_v6_close_channel(&excluded);
  if(pi.hProcess){
    if(WaitForSingleObject(pi.hProcess,0)==WAIT_TIMEOUT){
      TerminateProcess(pi.hProcess,98);WaitForSingleObject(pi.hProcess,5000);
    }
    CloseHandle(pi.hProcess);
  }
  if(pi.hThread)CloseHandle(pi.hThread);
  if(initialized)DeleteProcThreadAttributeList(si.lpAttributeList);
  if(si.lpAttributeList)HeapFree(GetProcessHeap(),0,si.lpAttributeList);
  return rc?failed("ipc"):0;
}
int wmain(int argc,wchar_t **argv){
  if(argc==4&&!wcscmp(argv[1],L"--peer"))return peer_child(argv[2],argv[3]);
  if(argc!=6||wcscmp(argv[1],L"--fixture"))return failed("args");
  const wchar_t *file=argv[2],*dir=argv[4],*linked=argv[5];
  BYTE expected[32],wrong[32];
  NX_HELD_FILE held={0};
  DWORD before=0,after=0;
  if(!hex_digest(argv[3],expected)||!GetProcessHandleCount(GetCurrentProcess(),&before))return failed("setup");
  memcpy(wrong,expected,32);wrong[0]^=1;
  for(int i=0;i<16;++i){
    if(nx_v6_hold_file(file,wrong,&held)){nx_v6_close_file(&held);return failed("wrong_digest");}
    if(nx_v6_hold_file(linked,expected,&held)){nx_v6_close_file(&held);return failed("hardlink");}
  }
  pass("wrong_digest_denied");pass("hardlink_denied");
  if(!metadata_baseline(dir))return failed("metadata_only_baseline");
  if(!nx_v6_hold_file(file,expected,&held))return failed("hold");
  const char *failure="held_sha256_fileid_recheck";
  DWORD failure_error=0;
  if(!nx_v6_recheck_file(&held)){failure_error=GetLastError();goto done;}
  pass("held_sha256_fileid_recheck");
  // Execute all three observations; do not short-circuit or lose the failing
  // operation's error when closing the retained HANDLEs.
  BOOL write_denied=sharing_denied("held_file_write",file,GENERIC_WRITE,0);
  BOOL delete_denied=sharing_denied("held_file_delete",file,DELETE,0);
  BOOL ancestor_denied=sharing_denied("held_ancestor_delete",dir,DELETE,FILE_FLAG_BACKUP_SEMANTICS);
  if(!write_denied||!delete_denied||!ancestor_denied){
    failure="held_share_exclusion";goto done;
  }
  pass("held_file_write_delete_ancestor_denied");
  failure="nonexecuted_image_mapping_path_matches";
  if(!mapped_source(&held)){failure_error=GetLastError();goto done;}
  pass("nonexecuted_image_mapping_path_matches");
  failure=NULL;
done:
  nx_v6_close_file(&held);
  if(failure){
    fprintf(stderr,"NX_CUSTODY_FAIL %s captured_win32=%lu\n",failure,(unsigned long)failure_error);
    return 1;
  }
  // Same access must work after cleanup, proving exclusion was held custody.
  HANDLE unlocked=CreateFileW(file,GENERIC_WRITE|DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
    NULL,OPEN_EXISTING,0,NULL);
  if(unlocked==INVALID_HANDLE_VALUE)return failed("unlocked_file");
  CloseHandle(unlocked);
  unlocked=CreateFileW(dir,DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
    NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
  if(unlocked==INVALID_HANDLE_VALUE)return failed("unlocked_ancestor");
  CloseHandle(unlocked);pass("held_handles_released");
  if(ipc_case())return 1;
  ULONGLONG start=GetTickCount64();
  if(!nx_v6_native_gate_live(start)||nx_v6_native_gate_live(0)||
     nx_v6_native_gate_live(start+60000ULL))return failed("deadline_initial");
  pass("monotonic_initial_future_zero");
  while(GetTickCount64()-start<NX_NATIVE_GATE_MS)Sleep(10);
  ULONGLONG elapsed=GetTickCount64()-start;
  if(nx_v6_native_gate_live(start)||elapsed<NX_NATIVE_GATE_MS)return failed("deadline_expired");
  printf("NX_CUSTODY_MEASURE native_elapsed_ms=%llu\n",(unsigned long long)elapsed);
  pass("monotonic_expiry_no_renewal");
  NX_BOOT_OBSERVATION boot={0};
  if(nx_v6_observe_boot(&boot))printf("NX_CUSTODY_OBSERVATION boot_support=AVAILABLE authoritative=false\n");
  else printf("NX_CUSTODY_OBSERVATION boot_support=UNAVAILABLE authoritative=false\n");
  if(!GetProcessHandleCount(GetCurrentProcess(),&after)||before!=after){
    fprintf(stderr,"NX_CUSTODY_HANDLES before=%lu after=%lu\n",before,after);
    return failed("handle_leak");
  }
  pass("exact_handle_count_restored");
  printf("NX_CUSTODY_RESULT pass=14 fail=0 production_authorized=false\n");
  return 0;
}
