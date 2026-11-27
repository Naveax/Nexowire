/* Hosted disposable acceptance ONLY. Never package this executable.
 * The only launched image is this fixture itself, with a fixed peer mode.
 * The inspected PE is mapped SEC_IMAGE_NO_EXECUTE, never started. */
#include "../../native/windows-scheduled-v6-custody.c"
#include <psapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>

/* Test-only current-process handle table census. No foreign processes, object
 * names, duplicated handles or production authority. ProcessHandleInformation
 * (51) is a private NT ABI; unsupported or unstable snapshots FAIL this test.
 * Type names come from NtQueryObject(ObjectTypeInformation=2). */
typedef struct NX_AUDIT_ENTRY {
  HANDLE value;
  ULONG_PTR handle_count,pointer_count;
  ULONG access,type_index,attributes,reserved;
} NX_AUDIT_ENTRY;
#define NX_AUDIT_CAP 2048
typedef struct NX_AUDIT_TABLE {
  ULONG_PTR count,reserved;
  NX_AUDIT_ENTRY entry[NX_AUDIT_CAP];
} NX_AUDIT_TABLE;
typedef LONG (NTAPI *NX_QPROCESS)(HANDLE,ULONG,PVOID,ULONG,PULONG);
typedef LONG (NTAPI *NX_QOBJECT)(HANDLE,ULONG,PVOID,ULONG,PULONG);
typedef struct NX_AUDIT_STRING { USHORT length,maximum; PWSTR buffer; } NX_AUDIT_STRING;
static NX_QPROCESS audit_process=NULL;
static NX_QOBJECT audit_object=NULL;
static NX_AUDIT_TABLE audit_initial,audit_previous,audit_current,product_initial,after_first_digest;
static wchar_t audit_types[512][64];
static BOOL audit_capture(NX_AUDIT_TABLE *out){
  ULONG used=0;DWORD before=0,after=0;
  if(!GetProcessHandleCount(GetCurrentProcess(),&before))return FALSE;
  LONG status=audit_process(GetCurrentProcess(),51,out,(ULONG)sizeof(*out),&used);
  if(status!=0||out->count>NX_AUDIT_CAP||
     used>sizeof(*out)||used<offsetof(NX_AUDIT_TABLE,entry)+out->count*sizeof(NX_AUDIT_ENTRY)){
    fprintf(stderr,"NX_HANDLE_SNAPSHOT_UNAVAILABLE ntstatus=0x%08lx used=%lu\n",
      (unsigned long)status,(unsigned long)used);return FALSE;
  }
  for(ULONG_PTR i=0;i<out->count;++i){
    NX_AUDIT_ENTRY *e=&out->entry[i];
    if(!e->value||e->type_index>=512)return FALSE;
    if(audit_types[e->type_index][0])continue;
    union { void *align; BYTE bytes[1024]; } info={0};
    ULONG length=0;
    status=audit_object(e->value,2,info.bytes,(ULONG)sizeof(info.bytes),&length);
    NX_AUDIT_STRING name={0};memcpy(&name,info.bytes,sizeof(name));
    uintptr_t address=(uintptr_t)name.buffer,base=(uintptr_t)info.bytes;
    if(status!=0||!name.length||name.length%sizeof(wchar_t)||
       name.length>=sizeof(audit_types[0])||address<base||
       address-base>sizeof(info.bytes)-name.length){
      fprintf(stderr,"NX_HANDLE_TYPE_UNAVAILABLE index=%lu ntstatus=0x%08lx\n",
        (unsigned long)e->type_index,(unsigned long)status);return FALSE;
    }
    memcpy(audit_types[e->type_index],name.buffer,name.length);
  }
  if(!GetProcessHandleCount(GetCurrentProcess(),&after)||before!=after||out->count!=after){
    fprintf(stderr,"NX_HANDLE_SNAPSHOT_UNSTABLE before=%lu after=%lu table=%llu\n",
      (unsigned long)before,(unsigned long)after,(unsigned long long)out->count);return FALSE;
  }
  return TRUE;
}
static BOOL audit_has(const NX_AUDIT_TABLE *table,const NX_AUDIT_ENTRY *e){
  for(ULONG_PTR i=0;i<table->count;++i){
    const NX_AUDIT_ENTRY *x=&table->entry[i];
    if(x->value==e->value&&x->type_index==e->type_index&&x->access==e->access&&
       x->attributes==e->attributes)return TRUE;
  }
  return FALSE;
}
static BOOL audit_delta(const char *stage,const NX_AUDIT_TABLE *before,const NX_AUDIT_TABLE *after,BOOL require_same){
  ULONG added=0,removed=0;
  for(ULONG_PTR i=0;i<after->count;++i){
    const NX_AUDIT_ENTRY *e=&after->entry[i];
    if(audit_has(before,e))continue;
    ++added;
    printf("NX_HANDLE_DELTA stage=%s op=add type=%ls access=%08lx attrs=%08lx value=%p\n",
      stage,audit_types[e->type_index],(unsigned long)e->access,(unsigned long)e->attributes,e->value);
  }
  for(ULONG_PTR i=0;i<before->count;++i){
    const NX_AUDIT_ENTRY *e=&before->entry[i];
    if(audit_has(after,e))continue;
    ++removed;
    printf("NX_HANDLE_DELTA stage=%s op=remove type=%ls access=%08lx attrs=%08lx value=%p\n",
      stage,audit_types[e->type_index],(unsigned long)e->access,(unsigned long)e->attributes,e->value);
  }
  printf("NX_HANDLE_STAGE stage=%s before=%llu after=%llu added=%lu removed=%lu\n",stage,
    (unsigned long long)before->count,(unsigned long long)after->count,
    (unsigned long)added,(unsigned long)removed);
  fflush(stdout);
  return !require_same||(!added&&!removed);
}
static BOOL audit_stage(const char *stage,BOOL same){
  if(!audit_capture(&audit_current))return FALSE;
  BOOL ok=audit_delta(stage,&audit_previous,&audit_current,same);
  audit_previous=audit_current;return ok;
}
static BOOL audit_init(void){
  HMODULE ntdll=GetModuleHandleW(L"ntdll.dll");
  if(!ntdll)return FALSE;
  FARPROC a=GetProcAddress(ntdll,"NtQueryInformationProcess"),b=GetProcAddress(ntdll,"NtQueryObject");
  if(!a||!b||sizeof(a)!=sizeof(audit_process)||sizeof(b)!=sizeof(audit_object))return FALSE;
  memcpy(&audit_process,&a,sizeof(a));memcpy(&audit_object,&b,sizeof(b));
  // Warm only the diagnostic's output path, not CNG or custody operations.
  printf("NX_HANDLE_AUDIT current_process_only=true\n");fflush(stdout);
  if(!audit_capture(&audit_previous)||!audit_stage("census_stability",TRUE))return FALSE;
  audit_initial=audit_previous;
  return TRUE;
}
/* Independent API-only control: no native custody function, files, pipes,
 * peer creation or image mapping. Check actual close results and a known
 * SHA256 answer; never silently warm an unmeasured product operation. */
static BOOL control_sha(void){
  static const BYTE expected[32]={0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,
    0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad};
  BCRYPT_ALG_HANDLE alg=NULL;BCRYPT_HASH_HANDLE hash=NULL;
  BYTE input[3]={'a','b','c'},digest[32]={0};
  BOOL ok=FALSE;
  if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,NULL,0)>=0&&
     BCryptCreateHash(alg,&hash,NULL,0,NULL,0,0)>=0&&
     BCryptHashData(hash,input,3,0)>=0&&BCryptFinishHash(hash,digest,32,0)>=0&&
     !memcmp(digest,expected,32))ok=TRUE;
  if(hash&&BCryptDestroyHash(hash)<0)ok=FALSE;
  if(alg&&BCryptCloseAlgorithmProvider(alg,0)<0)ok=FALSE;
  SecureZeroMemory(digest,sizeof(digest));return ok;
}
static BOOL control_rng(void){
  BYTE nonce[32];
  BOOL ok=BCryptGenRandom(NULL,nonce,32,BCRYPT_USE_SYSTEM_PREFERRED_RNG)>=0;
  SecureZeroMemory(nonce,sizeof(nonce));return ok;
}
static BOOL audit_control(void){
  if(!control_sha()||!audit_stage("control_sha",FALSE)||
     !control_rng()||!audit_stage("control_rng",FALSE))return FALSE;
  if(!audit_delta("control_final",&audit_initial,&audit_previous,FALSE))return FALSE;
  for(int i=0;i<4;++i){
    if(!control_sha()||!audit_stage("control_repeat_sha",TRUE)||
       !control_rng()||!audit_stage("control_repeat_rng",TRUE))return FALSE;
  }
  return TRUE;
}

static int failed(const char *name){
  fprintf(stderr,"NX_CUSTODY_FAIL %s win32=%lu\n",name,GetLastError());
  return 1;
}
static BOOL repeating_ipc=FALSE;
static void pass(const char *name){printf(repeating_ipc?"NX_CUSTODY_REPEAT_PASS %s\n":"NX_CUSTODY_PASS %s\n",name);fflush(stdout);}
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
  if(!audit_stage("ipc_pipes_open",FALSE))goto done;
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
      allowed,sizeof(allowed),NULL,NULL)||!audit_stage("ipc_attrlist_ready",FALSE))goto done;
  DWORD length=GetModuleFileNameW(NULL,exe,32768);
  if(!length||length>=32768||swprintf_s(command,32768,L"\"%ls\" --peer %llu %llu",exe,
    (unsigned long long)(uintptr_t)to.read_end,(unsigned long long)(uintptr_t)from.write_end)<0)goto done;
  si.StartupInfo.cb=sizeof(si);
  if(!CreateProcessW(exe,command,NULL,NULL,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,
    NULL,NULL,&si.StartupInfo,&pi))goto done;
  if(!audit_stage("ipc_createprocess_returned",FALSE))goto done;
  CloseHandle(to.read_end);to.read_end=NULL;
  CloseHandle(from.write_end);from.write_end=NULL;
  CloseHandle(excluded.write_end);excluded.write_end=NULL;
  DWORD avail=0;
  if(PeekNamedPipe(excluded.read_end,NULL,0,NULL,&avail,NULL)||GetLastError()!=ERROR_BROKEN_PIPE)goto done;
  pass("explicit_handle_allowlist_excludes_inheritable_canary");
  if(!audit_stage("ipc_spawned",FALSE)||
     !GetProcessTimes(pi.hProcess,&created,&e,&k,&u)||
     !peer_identity(pi.hProcess,pi.dwProcessId,created))goto done;
  if(BCryptGenRandom(NULL,nonce,32,BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0||
     !audit_stage("ipc_rng",FALSE)||
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
  if(!audit_stage("ipc_peer_exited",FALSE))goto done;
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

/* Independent controls run in separate fresh processes. Their cold origin is
 * immutable. Every iteration is compared with that origin AND the first
 * measured settled table; neither substitutes for the product acceptance.
 * No type exemptions; instability is retained as a failing diagnostic. */
static NX_AUDIT_TABLE control_first;
static BOOL control_mapping(const wchar_t *file){
  HANDLE h=CreateFileW(file,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,0,NULL);
  if(h==INVALID_HANDLE_VALUE)return FALSE;
  HANDLE section=CreateFileMappingW(h,NULL,PAGE_READONLY|SEC_IMAGE_NO_EXECUTE,0,0,NULL);
  void *view=section?MapViewOfFile(section,FILE_MAP_READ,0,0,0):NULL;
  BOOL ok=FALSE;
  if(view){
    MEMORY_BASIC_INFORMATION m={0};
    wchar_t mapped[32768],held[32768];
    DWORD a=GetMappedFileNameW(GetCurrentProcess(),view,mapped,32768);
    DWORD b=GetFinalPathNameByHandleW(h,held,32768,VOLUME_NAME_NT);
    ok=VirtualQuery(view,&m,sizeof(m))==sizeof(m)&&m.Type==MEM_IMAGE&&
      a>0&&a<32768&&b>0&&b<32768&&!_wcsicmp(mapped,held);
    if(!UnmapViewOfFile(view))ok=FALSE;
  }
  if(section&&!CloseHandle(section))ok=FALSE;
  if(!CloseHandle(h))ok=FALSE;
  return ok;
}
static BOOL control_pipes(void){
  HANDLE ends[6]={0};BOOL ok=TRUE;
  for(int i=0;i<3;++i){
    if(!CreatePipe(&ends[i*2],&ends[i*2+1],NULL,4096)){ok=FALSE;break;}
  }
  for(int i=0;i<6;++i)if(ends[i]&&!CloseHandle(ends[i]))ok=FALSE;
  return ok;
}
/* No CNG/custody calls. Fixed self child only, no production process.
 * Plain spawn and extended spawn are separate experiments. For the latter,
 * build raw pipes and explicit HANDLE_LIST, never inherit all. */
static BOOL control_spawn(BOOL extended){
  HANDLE ends[2]={0};STARTUPINFOEXW si={0};PROCESS_INFORMATION pi={0};
  SIZE_T bytes=0;BOOL initialized=FALSE,ok=FALSE;
  wchar_t exe[32768],command[32768];
  DWORD n=GetModuleFileNameW(NULL,exe,32768),code=99;
  if(!n||n>=32768||swprintf_s(command,32768,L"\"%ls\" --control-child",exe)<0)goto done;
  si.StartupInfo.cb=extended?(DWORD)sizeof(si):(DWORD)sizeof(STARTUPINFOW);
  if(extended){
    if(!CreatePipe(&ends[0],&ends[1],NULL,4096)||
       !SetHandleInformation(ends[0],HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT))goto done;
    InitializeProcThreadAttributeList(NULL,1,0,&bytes);
    if(!bytes)goto done;
    si.lpAttributeList=HeapAlloc(GetProcessHeap(),0,bytes);
    if(!si.lpAttributeList||!InitializeProcThreadAttributeList(si.lpAttributeList,1,0,&bytes))goto done;
    initialized=TRUE;
    if(!UpdateProcThreadAttribute(si.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
       &ends[0],sizeof(HANDLE),NULL,NULL))goto done;
  }
  if(!CreateProcessW(exe,command,NULL,NULL,extended,
      CREATE_NO_WINDOW|(extended?EXTENDED_STARTUPINFO_PRESENT:0),NULL,NULL,&si.StartupInfo,&pi))goto done;
  if(WaitForSingleObject(pi.hProcess,5000)!=WAIT_OBJECT_0||
     !GetExitCodeProcess(pi.hProcess,&code)||code!=0)goto done;
  ok=TRUE;
done:
  if(pi.hProcess){
    if(WaitForSingleObject(pi.hProcess,0)==WAIT_TIMEOUT){
      if(!TerminateProcess(pi.hProcess,98)||WaitForSingleObject(pi.hProcess,5000)!=WAIT_OBJECT_0)ok=FALSE;
    }
    if(!CloseHandle(pi.hProcess))ok=FALSE;
  }
  if(pi.hThread&&!CloseHandle(pi.hThread))ok=FALSE;
  if(initialized)DeleteProcThreadAttributeList(si.lpAttributeList);
  if(si.lpAttributeList&&!HeapFree(GetProcessHeap(),0,si.lpAttributeList))ok=FALSE;
  for(int i=0;i<2;++i)if(ends[i]&&!CloseHandle(ends[i]))ok=FALSE;
  return ok;
}
static void describe_residual_files(const char *stage,const NX_AUDIT_TABLE *origin,const NX_AUDIT_TABLE *now){
  for(ULONG_PTR i=0;i<now->count;++i){
    const NX_AUDIT_ENTRY *e=&now->entry[i];
    if(audit_has(origin,e)||wcscmp(audit_types[e->type_index],L"File"))continue;
    SetLastError(0);DWORD kind=GetFileType(e->value),kind_error=GetLastError();
    DWORD flags=0,out_size=0,in_size=0,max=0,pipe_error=0;BOOL pipe=FALSE;
    if(kind==FILE_TYPE_PIPE){
      SetLastError(0);pipe=GetNamedPipeInfo(e->value,&flags,&out_size,&in_size,&max);
      pipe_error=GetLastError();
    }
    printf("NX_HANDLE_FILE stage=%s value=%p access=%08lx filetype=%lu type_error=%lu pipe_info=%u pipe_error=%lu\n",
      stage,e->value,(unsigned long)e->access,(unsigned long)kind,(unsigned long)kind_error,
      pipe?1U:0U,(unsigned long)pipe_error);
  }
  fflush(stdout);
}
static int independent_control(const wchar_t *mode,const wchar_t *file){
  if(!audit_init())return failed("independent_control_setup");
  BOOL all_ok=TRUE;
  for(int i=0;i<8;++i){
    BOOL ok=FALSE;
    if(!wcscmp(mode,L"--control-observer")){Sleep(10);ok=TRUE;}
    else if(!wcscmp(mode,L"--control-sha"))ok=control_sha();
    else if(!wcscmp(mode,L"--control-rng"))ok=control_rng();
    else if(!wcscmp(mode,L"--control-mapping"))ok=control_mapping(file);
    else if(!wcscmp(mode,L"--control-pipes"))ok=control_pipes();
    else if(!wcscmp(mode,L"--control-spawn"))ok=control_spawn(FALSE);
    else if(!wcscmp(mode,L"--control-spawn-extended"))ok=control_spawn(TRUE);
    else return failed("independent_control_mode");
    if(!ok){all_ok=FALSE;fprintf(stderr,"NX_CONTROL_API_FAILED iteration=%d win32=%lu\n",i+1,GetLastError());}
    char stage[64];
    sprintf_s(stage,sizeof(stage),"control_%d_immediate",i+1);
    if(!audit_stage(stage,FALSE))return failed("control_immediate_snapshot");
    // Observe both immediate and delayed state. A transient object is logged,
    // not silently removed from the census or ignored by a type whitelist.
    Sleep(250);
    sprintf_s(stage,sizeof(stage),"control_%d_settled",i+1);
    if(!audit_stage(stage,FALSE))return failed("control_settled_snapshot");
    sprintf_s(stage,sizeof(stage),"control_%d_from_origin",i+1);
    if(!audit_delta(stage,&audit_initial,&audit_previous,FALSE))return failed("control_origin_delta");
    if(!i)control_first=audit_previous;
    else {
      sprintf_s(stage,sizeof(stage),"control_%d_vs_first",i+1);
      if(!audit_delta(stage,&control_first,&audit_previous,TRUE))all_ok=FALSE;
    }
  }
  Sleep(1000);
  if(!audit_stage("control_delayed",FALSE))return failed("control_delayed_snapshot");
  if(!audit_delta("control_final_from_origin",&audit_initial,&audit_previous,FALSE)||
     !audit_delta("control_final_vs_first",&control_first,&audit_previous,TRUE))all_ok=FALSE;
  describe_residual_files("control_final_from_origin",&audit_initial,&audit_previous);
  if(!audit_stage("control_file_description",TRUE))all_ok=FALSE;
  printf("NX_CONTROL_RESULT mode=%ls repetitions=8 stable=%u origin_retained=true production_authorized=false\n",mode,all_ok?1U:0U);
  fflush(stdout);
  return all_ok?0:1;
}
/* Count-only observer control has no NtQueryObject or typed census. It
 * distinguishes measurement machinery from ordinary elapsed time. */
static int count_observer(void){
  DWORD before=0,after=0;
  if(!GetProcessHandleCount(GetCurrentProcess(),&before))return failed("count_observer_start");
  BOOL same=TRUE;
  for(int i=0;i<8;++i){
    Sleep(260);
    if(!GetProcessHandleCount(GetCurrentProcess(),&after))return failed("count_observer_read");
    printf("NX_COUNT_OBSERVER iteration=%d origin=%lu current=%lu\n",i+1,before,after);
    if(before!=after)same=FALSE;
  }
  Sleep(1000);
  if(!GetProcessHandleCount(GetCurrentProcess(),&after))return failed("count_observer_final");
  if(before!=after)same=FALSE;
  printf("NX_CONTROL_RESULT mode=--control-count-observer repetitions=8 stable=%u origin_retained=true production_authorized=false\n",same?1U:0U);
  return same?0:1;
}

int wmain(int argc,wchar_t **argv){
  if(argc==2&&!wcscmp(argv[1],L"--control-child"))return 0;
  if(argc==6&&!wcscmp(argv[1],L"--control-count-observer"))return count_observer();
  if(argc==6&&!wcsncmp(argv[1],L"--control-",10))return independent_control(argv[1],argv[2]);
  if(argc==4&&!wcscmp(argv[1],L"--peer"))return peer_child(argv[2],argv[3]);
  if(argc!=6||(wcscmp(argv[1],L"--fixture")&&wcscmp(argv[1],L"--fixture-cold")))return failed("args");
  BOOL cold=!wcscmp(argv[1],L"--fixture-cold");
  const wchar_t *file=argv[2],*dir=argv[4],*linked=argv[5];
  BYTE expected[32],wrong[32];
  NX_HELD_FILE held={0};
  if(!hex_digest(argv[3],expected)||!audit_init())return failed("setup");
  if(!cold&&!audit_control())return failed("control_unstable");
  product_initial=audit_previous;
  memcpy(wrong,expected,32);wrong[0]^=1;
  for(int i=0;i<16;++i){
    if(nx_v6_hold_file(file,wrong,&held)){nx_v6_close_file(&held);return failed("wrong_digest");}
    if(!audit_stage(i?"wrong_digest_repeat":"wrong_digest_first",i!=0||!cold))return failed("wrong_digest_handle_delta");
    if(!i)after_first_digest=audit_previous;
    if(nx_v6_hold_file(linked,expected,&held)){nx_v6_close_file(&held);return failed("hardlink");}
    if(!audit_stage("hardlink_rejected",TRUE))return failed("hardlink_handle_delta");
  }
  pass("wrong_digest_denied");pass("hardlink_denied");
  if(!metadata_baseline(dir)||!audit_stage("metadata_closed",TRUE))return failed("metadata_only_baseline");
  if(!nx_v6_hold_file(file,expected,&held))return failed("hold");
  const char *failure="held_sha256_fileid_recheck";
  DWORD failure_error=0;
  if(!nx_v6_recheck_file(&held)||!audit_stage("custody_held",FALSE)){failure_error=GetLastError();goto done;}
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
  if(!mapped_source(&held)||!audit_stage("mapping_closed",TRUE)){failure_error=GetLastError();goto done;}
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
  if(!audit_stage("custody_closed",FALSE))return failed("custody_snapshot");
  if(!audit_delta(cold?"cold_custody_vs_hash_base":"custody_vs_product_base",
      cold?&after_first_digest:&product_initial,&audit_previous,TRUE))
    return failed("custody_residual_handles");
  if(ipc_case())return 1;
  if(!audit_stage("ipc_closed",FALSE))return failed("ipc_snapshot");
  // Repeat full peer lifecycle, comparing cumulative deltas against the
  // original process origin. No baseline reset. Preserve the initial 13 named
  // behavior cases; repetitions have explicit separate diagnostic labels.
  NX_AUDIT_TABLE first_ipc=audit_previous;
  BOOL repeats_ok=TRUE;
  for(int i=0;i<7;++i){
    // Suppress duplicate acceptance labels, not audit data or behavior checks.
    printf("NX_CUSTODY_IPC_REPEAT_BEGIN iteration=%d\n",i+2);
    repeating_ipc=TRUE;
    int repeat_result=ipc_case();
    repeating_ipc=FALSE;
    if(repeat_result)return failed("ipc_repeat_behavior");
    char stage[64];sprintf_s(stage,sizeof(stage),"ipc_repeat_%d_closed",i+2);
    if(!audit_stage(stage,FALSE))return failed("ipc_repeat_snapshot");
    sprintf_s(stage,sizeof(stage),"ipc_repeat_%d_origin",i+2);
    if(!audit_delta(stage,&product_initial,&audit_previous,FALSE))return failed("ipc_repeat_origin");
    sprintf_s(stage,sizeof(stage),"ipc_repeat_%d_vs_first",i+2);
    if(!audit_delta(stage,&first_ipc,&audit_previous,TRUE))repeats_ok=FALSE;
    printf("NX_CUSTODY_IPC_REPEAT_END iteration=%d\n",i+2);
  }
  describe_residual_files("ipc_residual",&product_initial,&audit_previous);
  if(!audit_stage("ipc_file_description",TRUE))repeats_ok=FALSE;
  if(!repeats_ok)return failed("ipc_repeat_handle_growth");
  if(!cold&&!audit_delta("ipc_vs_product_base",&product_initial,&audit_previous,TRUE))
    return failed("ipc_residual_handles");
  ULONGLONG start=GetTickCount64();
  if(!nx_v6_native_gate_live(start)||nx_v6_native_gate_live(0)||
     nx_v6_native_gate_live(start+60000ULL))return failed("deadline_initial");
  pass("monotonic_initial_future_zero");
  while(GetTickCount64()-start<NX_NATIVE_GATE_MS)Sleep(10);
  ULONGLONG elapsed=GetTickCount64()-start;
  if(nx_v6_native_gate_live(start)||elapsed<NX_NATIVE_GATE_MS)return failed("deadline_expired");
  printf("NX_CUSTODY_MEASURE native_elapsed_ms=%llu\n",(unsigned long long)elapsed);
  pass("monotonic_expiry_no_renewal");
  if(!audit_stage("deadline_closed",TRUE))return failed("deadline_handle_delta");
  NX_BOOT_OBSERVATION boot={0};
  if(nx_v6_observe_boot(&boot))printf("NX_CUSTODY_OBSERVATION boot_support=AVAILABLE authoritative=false\n");
  else printf("NX_CUSTODY_OBSERVATION boot_support=UNAVAILABLE authoritative=false\n");
  if(!audit_stage("boot_readback_closed",TRUE))return failed("boot_readback_handle_delta");
  describe_residual_files("final_residual",&product_initial,&audit_previous);
  if(!audit_stage("final_file_description",TRUE))return failed("final_file_description_delta");
  if(!audit_delta(cold?"cold_final":"product_final",&product_initial,&audit_previous,TRUE)){
    fprintf(stderr,"NX_CUSTODY_FAIL handle_table_changed logical=true\n");
    return cold?19:1;
  }
  pass("exact_handle_count_restored");
  printf("NX_CUSTODY_RESULT pass=14 fail=0 production_authorized=false\n");
  return 0;
}
