// Nexowire Windows Job Object owner. Build as a console subsystem EXE.
// No native process is resumed unless its Job assignment is proven.
#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <wchar.h>
#include <string.h>
#include <aclapi.h>
#include <sddl.h>

// The Job handle is not safe in a medium-integrity same-logon guardian:
// any peer that opens the guardian with PROCESS_DUP_HANDLE can retain it
// after guardian death. The first P0 trust boundary is a genuinely HIGH
// integrity, elevated Administrator token. The process is born HIGH (MIC)
// before it can create a Job; the restrictive DACL is defense in depth.
// This does NOT protect against high/SYSTEM/SeDebug peers and cannot serve
// as installed-Broker or production acceptance evidence.
static BOOL enforce_guardian_isolation(void) {
  HANDLE token=NULL;
  BYTE integrity[sizeof(TOKEN_MANDATORY_LABEL)+SECURITY_MAX_SID_SIZE]={0};
  DWORD returned=0;
  TOKEN_ELEVATION elevation={0};
  TOKEN_MANDATORY_POLICY mandatory={0};
  BOOL admin=FALSE;
  BYTE adminSid[SECURITY_MAX_SID_SIZE]={0};
  DWORD sidBytes=sizeof(adminSid);
  BOOL trusted=FALSE;
  const wchar_t *stage=L"token_open";
  DWORD win32=ERROR_SUCCESS;
  PSECURITY_DESCRIPTOR descriptor=NULL;
  PACL dacl=NULL;
  HANDLE self=NULL;

  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))goto cleanup;
  stage=L"integrity_query";
  if(!GetTokenInformation(token,TokenIntegrityLevel,integrity,sizeof(integrity),
       &returned))goto cleanup;
  TOKEN_MANDATORY_LABEL *label=(TOKEN_MANDATORY_LABEL*)integrity;
  if(!IsValidSid(label->Label.Sid))goto cleanup;
  DWORD count=*GetSidSubAuthorityCount(label->Label.Sid);
  if(count==0)goto cleanup;
  DWORD level=*GetSidSubAuthority(label->Label.Sid,count-1);
  stage=L"integrity_not_high";
  if(level<SECURITY_MANDATORY_HIGH_RID)goto cleanup;
  stage=L"token_elevation";
  if(!GetTokenInformation(token,TokenElevation,&elevation,sizeof(elevation),
       &returned) || !elevation.TokenIsElevated)goto cleanup;
  stage=L"mandatory_policy";
  if(!GetTokenInformation(token,TokenMandatoryPolicy,&mandatory,sizeof(mandatory),
       &returned) || !(mandatory.Policy&TOKEN_MANDATORY_POLICY_NO_WRITE_UP))
    goto cleanup;
  stage=L"admins_sid";
  if(!CreateWellKnownSid(WinBuiltinAdministratorsSid,NULL,adminSid,&sidBytes))
    goto cleanup;
  stage=L"admins_membership";
  if(!CheckTokenMembership(NULL,adminSid,&admin) || !admin)goto cleanup;

  // An OWNER_RIGHTS ACE suppresses the implicit WRITE_DAC privilege of
  // the creator SID. Only SYSTEM and an enabled Administrators SID get
  // PROCESS_DUP_HANDLE. Medium filtered admin tokens are not enabled BA.
  // Explicitly fail if the DACL cannot be applied and read back.
  stage=L"dacl_sddl";
  // Use the exact PROCESS_ALL_ACCESS mask, not generic "GA". Windows
  // translates generic rights when applying a process DACL, so a raw GA
  // comparison on readback falsely disagrees with the installed ACE.
  wchar_t processDacl[160]={0};
  if(swprintf(processDacl,160,
       L"D:P(A;;0x%08lx;;;SY)(A;;0x%08lx;;;BA)(A;;0x00101000;;;OW)",
       (unsigned long)PROCESS_ALL_ACCESS,(unsigned long)PROCESS_ALL_ACCESS)<0)
    goto cleanup;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(
       processDacl,SDDL_REVISION_1,&descriptor,NULL))goto cleanup;
  stage=L"dacl_parse";
  BOOL present=FALSE,defaulted=FALSE;
  if(!GetSecurityDescriptorDacl(descriptor,&present,&dacl,&defaulted) ||
     !present || !dacl)goto cleanup;
  stage=L"self_open";
  self=OpenProcess(READ_CONTROL|WRITE_DAC,FALSE,GetCurrentProcessId());
  if(!self)goto cleanup;
  stage=L"dacl_set";
  if(SetSecurityInfo(self,SE_KERNEL_OBJECT,
       DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,
       NULL,NULL,dacl,NULL)!=ERROR_SUCCESS)goto cleanup;
  stage=L"dacl_readback";
  PSECURITY_DESCRIPTOR observed=NULL;
  PACL installed=NULL;
  DWORD verify=GetSecurityInfo(self,SE_KERNEL_OBJECT,DACL_SECURITY_INFORMATION,
    NULL,NULL,&installed,NULL,&observed);
  if(verify!=ERROR_SUCCESS) {
    stage=L"dacl_readback_api";win32=verify;
  } else if(!installed || !observed) {
    stage=L"dacl_readback_empty";
  } else {
    SECURITY_DESCRIPTOR_CONTROL flags=0;DWORD revision=0;
    BOOL identical=(installed->AceCount==dacl->AceCount);
    if(!identical)stage=L"dacl_readback_ace_count";
    for(DWORD i=0;identical && i<dacl->AceCount;i++) {
      LPVOID want=NULL,actual=NULL;
      if(!GetAce(dacl,i,&want) || !GetAce(installed,i,&actual)) {
        identical=FALSE;stage=L"dacl_readback_get_ace";break;
      }
      ACE_HEADER *w=(ACE_HEADER*)want,*a=(ACE_HEADER*)actual;
      if(w->AceSize!=a->AceSize || memcmp(w,a,w->AceSize)!=0) {
        identical=FALSE;stage=L"dacl_readback_ace_bytes";
      }
    }
    if(identical && !GetSecurityDescriptorControl(observed,&flags,&revision)) {
      stage=L"dacl_readback_control";
    } else if(identical && !(flags&SE_DACL_PROTECTED)) {
      stage=L"dacl_readback_unprotected";
    } else if(identical) trusted=TRUE;
  }
  if(observed)LocalFree(observed);

cleanup:
  if(self)CloseHandle(self);
  if(descriptor)LocalFree(descriptor);
  if(token)CloseHandle(token);
  if(!trusted)fwprintf(stderr,
    L"NEXOWIRE_WINJOB_ERROR guardian_high_token_or_acl_unverified stage=%ls win32=%lu\n",
    stage,win32?win32:GetLastError());
  return trusted;
}

/**
 * The Agent must temporarily duplicate the Job handle from this process to
 * verify membership while the root is suspended. That bootstrap handle is a
 * genuine same-HIGH attack window. Once the Agent has acknowledged the
 * verification gate, remove PROCESS_DUP_HANDLE from BA/OWNER_RIGHTS before
 * ResumeThread. Failure to apply/read back the ACL MUST terminate the Job;
 * a suspended root may never be resumed with a broadly duplicable guardian.
 *
 * Keep PROCESS_TERMINATE so the trusted caller can stop its guardian; a
 * same-HIGH attacker can also kill this process, but without a stolen Job
 * handle that death still triggers KILL_ON_JOB_CLOSE. Never grant DUP_HANDLE.
 *
 * This mitigates new opens AFTER the seal only. It cannot revoke any Job
 * handle already stolen before the seal; SeDebugPrivilege, equal-HIGH admins
 * that can modify the DACL, and SYSTEM remain outside the trust boundary.
 * A separate service SID/principal with trusted IPC is required for P0.
 */
static BOOL seal_guardian_after_attestation(void) {
  const DWORD queryOnly=PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE|PROCESS_TERMINATE;
  wchar_t sddl[160]={0};
  if(swprintf(sddl,160,
       L"D:P(A;;0x%08lx;;;SY)(A;;0x%08lx;;;BA)(A;;0x%08lx;;;OW)",
       (unsigned long)PROCESS_ALL_ACCESS,
       (unsigned long)queryOnly,(unsigned long)queryOnly)<0)
    return FALSE;
  PSECURITY_DESCRIPTOR desired=NULL,observed=NULL;
  PACL desiredAcl=NULL,installed=NULL;
  BOOL hasDacl=FALSE,wasDefaulted=FALSE;
  HANDLE processHandle=NULL;
  BOOL valid=FALSE;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(
       sddl,SDDL_REVISION_1,&desired,NULL))goto cleanup;
  if(!GetSecurityDescriptorDacl(desired,&hasDacl,&desiredAcl,&wasDefaulted)
     || !hasDacl || !desiredAcl)goto cleanup;
  // Obtain the WRITE_DAC/READ_CONTROL handle while bootstrap BA still has it.
  processHandle=OpenProcess(READ_CONTROL|WRITE_DAC,FALSE,GetCurrentProcessId());
  if(!processHandle)goto cleanup;
  if(SetSecurityInfo(processHandle,SE_KERNEL_OBJECT,
       DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,
       NULL,NULL,desiredAcl,NULL)!=ERROR_SUCCESS)goto cleanup;
  if(GetSecurityInfo(processHandle,SE_KERNEL_OBJECT,
       DACL_SECURITY_INFORMATION,NULL,NULL,&installed,NULL,&observed)
       !=ERROR_SUCCESS || !observed || !installed)goto cleanup;
  if(installed->AceCount!=desiredAcl->AceCount)goto cleanup;
  for(DWORD i=0;i<desiredAcl->AceCount;i++){
    void *left=NULL,*right=NULL;
    if(!GetAce(desiredAcl,i,&left) || !GetAce(installed,i,&right))
      goto cleanup;
    ACE_HEADER *a=(ACE_HEADER*)left,*c=(ACE_HEADER*)right;
    if(a->AceSize!=c->AceSize || memcmp(a,c,a->AceSize)!=0)
      goto cleanup;
  }
  SECURITY_DESCRIPTOR_CONTROL control=0;
  DWORD revision=0;
  if(!GetSecurityDescriptorControl(observed,&control,&revision) ||
     !(control&SE_DACL_PROTECTED))goto cleanup;
  valid=TRUE;
cleanup:
  if(observed)LocalFree(observed);
  if(processHandle)CloseHandle(processHandle);
  if(desired)LocalFree(desired);
  if(!valid)fwprintf(stderr,
    L"NEXOWIRE_WINJOB_ERROR post_attestation_guardian_dacl_unsealed\\n");
  return valid;
}

static int quote_arg(const wchar_t *src, wchar_t **pos, const wchar_t *end) {
  int needs=!*src;
  const wchar_t *s=src;
  for(;*s;s++) if(*s==L' '||*s==L'\t'||*s==L'"')needs=1;
  if(!needs){for(s=src;*s;s++){if(*pos>=end)return 0;*(*pos)++=*s;}return 1;}
  if(*pos>=end)return 0;*(*pos)++=L'"';
  s=src;
  while(1){
    int slash=0;
    while(*s==L'\\'){slash++;s++;}
    if(*s==L'"'){
      for(int i=0;i<slash*2+1;i++){if(*pos>=end)return 0;*(*pos)++=L'\\';}
      if(*pos>=end)return 0;*(*pos)++=L'"';s++;continue;
    }
    if(!*s){
      for(int i=0;i<slash*2;i++){if(*pos>=end)return 0;*(*pos)++=L'\\';}
      break;
    }
    for(int i=0;i<slash;i++){if(*pos>=end)return 0;*(*pos)++=L'\\';}
    if(*pos>=end)return 0;*(*pos)++=*s++;
  }
  if(*pos>=end)return 0;*(*pos)++=L'"';
  return 1;
}

static void diagnostic(const wchar_t *stage) {
  fwprintf(stderr,L"NEXOWIRE_WINJOB_ERROR %ls win32=%lu\n",stage,GetLastError());
}

/* Managed Node protocol v6 reuses the existing guardian, unnamed Job,
 * and independent suspended-root verification. A cancellation marker
 * can only STOP this Job; it is never an admission or recovery grant.
 * Terminal evidence is local guardian observation, not a signed observer
 * receipt and not evidence about out-of-Job COM or shell brokers. */
static BOOL managed_session_trusted(HANDLE parent, DWORD parentPid, DWORD *session){
  DWORD parentSession=0, tokenSession=0, bytes=0;
  FILETIME pc,pe,pk,pu,gc,ge,gk,gu;
  HANDLE token=NULL,parentToken=NULL;
  BOOL trusted=FALSE;
  if(!parent || WaitForSingleObject(parent,0)!=WAIT_TIMEOUT ||
     GetProcessId(parent)!=parentPid ||
     !GetProcessTimes(parent,&pc,&pe,&pk,&pu) ||
     !GetProcessTimes(GetCurrentProcess(),&gc,&ge,&gk,&gu) ||
     CompareFileTime(&pc,&gc)>0 ||
     !ProcessIdToSessionId(GetCurrentProcessId(),session) ||
     !ProcessIdToSessionId(parentPid,&parentSession) || parentSession!=*session)
    return FALSE;
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return FALSE;
  if(!GetTokenInformation(token,TokenSessionId,&tokenSession,sizeof(tokenSession),&bytes)
      || tokenSession!=*session)goto done;
  BYTE user[sizeof(TOKEN_USER)+SECURITY_MAX_SID_SIZE]={0};
  BYTE owner[sizeof(TOKEN_USER)+SECURITY_MAX_SID_SIZE]={0};
  DWORD ownerSession=0;
  TOKEN_ELEVATION ownerElevation={0};
  if(!GetTokenInformation(token,TokenUser,user,sizeof(user),&bytes) ||
     !OpenProcessToken(parent,TOKEN_QUERY,&parentToken) ||
     !GetTokenInformation(parentToken,TokenUser,owner,sizeof(owner),&bytes) ||
     !GetTokenInformation(parentToken,TokenSessionId,&ownerSession,sizeof(ownerSession),&bytes) ||
     !GetTokenInformation(parentToken,TokenElevation,&ownerElevation,sizeof(ownerElevation),&bytes) ||
     ownerSession!=*session || !ownerElevation.TokenIsElevated ||
     !EqualSid(((TOKEN_USER*)user)->User.Sid,((TOKEN_USER*)owner)->User.Sid))
    goto done;
  // Session 0 requires the actual LocalSystem identity. This is not proof
  // of private desktop placement or isolation of external COM processes.
  if(*session==0 && !IsWellKnownSid(((TOKEN_USER*)user)->User.Sid,WinLocalSystemSid))
    goto done;
  trusted=TRUE;
done:
  if(parentToken)CloseHandle(parentToken);
  CloseHandle(token);
  return trusted;
}

static BOOL create_managed_root(wchar_t *cmd,const wchar_t *cwd,PROCESS_INFORMATION *pi){
  STARTUPINFOEXW info={0};
  info.StartupInfo.cb=sizeof(info);
  info.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
  // Only three explicit, duplicated pipe handles cross into the root.
  // Never inherit an unrelated handle owned by the guardian or caller.
  HANDLE pipes[3]={NULL,NULL,NULL};
  const DWORD ids[3]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};
  SIZE_T bytes=0;
  BOOL ready=FALSE, created=FALSE;
  for(int i=0;i<3;i++){
    HANDLE source=GetStdHandle(ids[i]);
    if(!source || source==INVALID_HANDLE_VALUE || GetFileType(source)!=FILE_TYPE_PIPE ||
       !DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),&pipes[i],
         0,TRUE,DUPLICATE_SAME_ACCESS))goto cleanup;
  }
  info.StartupInfo.hStdInput=pipes[0];
  info.StartupInfo.hStdOutput=pipes[1];
  info.StartupInfo.hStdError=pipes[2];
  (void)InitializeProcThreadAttributeList(NULL,1,0,&bytes);
  if(!bytes)goto cleanup;
  info.lpAttributeList=(LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(),0,bytes);
  if(!info.lpAttributeList)goto cleanup;
  if(!InitializeProcThreadAttributeList(info.lpAttributeList,1,0,&bytes))goto cleanup;
  ready=TRUE;
  if(!UpdateProcThreadAttribute(info.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
       pipes,sizeof(pipes),NULL,NULL))goto cleanup;
  // Inherited session/desktop is NOT a private desktop attestation.
  created=CreateProcessW(NULL,cmd,NULL,NULL,TRUE,
    CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,NULL,cwd,&info.StartupInfo,pi);
cleanup:
  if(ready)DeleteProcThreadAttributeList(info.lpAttributeList);
  if(info.lpAttributeList)HeapFree(GetProcessHeap(),0,info.lpAttributeList);
  for(int i=0;i<3;i++)if(pipes[i])CloseHandle(pipes[i]);
  return created;
}

static BOOL cancellation_pending(const wchar_t *file){
  DWORD a=GetFileAttributesW(file);
  if(a!=INVALID_FILE_ATTRIBUTES)return TRUE;
  // Unknown or inaccessible control state also cancels; never permits work.
  return GetLastError()!=ERROR_FILE_NOT_FOUND;
}

static BOOL terminate_and_observe_empty(HANDLE job,DWORD reason){
  if(!TerminateJobObject(job,reason))return FALSE;
  ULONGLONG start=GetTickCount64();
  do{
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a={0};
    if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&a,sizeof(a),NULL))
      return FALSE;
    if(a.ActiveProcesses==0)return TRUE;
    Sleep(25);
  }while(GetTickCount64()-start<5000);
  return FALSE;
}

static BOOL publish_managed_terminal(const wchar_t *file,DWORD pid,
    unsigned long long ticks,DWORD reason,DWORD rootExit){
  // Exclusive, flushed result. No result means UNKNOWN even if guardian
  // exited. This local result is not externally authenticated.
  char message[160]={0};
  int size=snprintf(message,sizeof(message),"NWJOB6 %lu %llu %lu %lu %lu\n",
    (unsigned long)pid,ticks,(unsigned long)GetCurrentProcessId(),
    (unsigned long)reason,(unsigned long)rootExit);
  if(size<=0||(size_t)size>=sizeof(message))return FALSE;
  HANDLE output=CreateFileW(file,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
  if(output==INVALID_HANDLE_VALUE)return FALSE;
  DWORD written=0;
  BOOL result=WriteFile(output,message,(DWORD)size,&written,NULL) &&
    written==(DWORD)size && FlushFileBuffers(output);
  CloseHandle(output);
  return result;
}

int main(void){
  int argc=0;
  wchar_t **argv=CommandLineToArgvW(GetCommandLineW(),&argc);
  // Read-only-to-host test mode; only secures this temporary probe process.
  // Does not create a Job, shell, root or any installed host object.
  if(argv && argc==2 && !wcscmp(argv[1],L"--probe-isolation")) {
    if(!enforce_guardian_isolation())return 79;
    fwprintf(stdout,L"NX_GUARDIAN_HIGH_DACL_PROVISIONAL\\n");
    return 0;
  }
  if(!argv || argc<11 || wcscmp(argv[1],L"--status") ||
     wcscmp(argv[3],L"--cwd") || wcscmp(argv[5],L"--parent") ||
     wcscmp(argv[7],L"--release")){
    fwprintf(stderr,L"NEXOWIRE_WINJOB_ERROR invalid_arguments\n");
    return 64;
  }
  int commandIndex=10;
  BOOL managed=FALSE;
  DWORD runtimeTimeout=0;
  if(!wcscmp(argv[9],L"--lifecycle-v6")){
    if(argc<13 || wcscmp(argv[11],L"--") || !argv[10][0])return 64;
    for(const wchar_t *digit=argv[10];*digit;digit++)
      if(*digit<L'0'||*digit>L'9')return 64;
    wchar_t *timeoutEnd=NULL;
    unsigned long budget=wcstoul(argv[10],&timeoutEnd,10);
    if(*timeoutEnd || budget>600000)return 64;
    runtimeTimeout=(DWORD)budget;
    managed=TRUE;
    commandIndex=12;
  }else if(wcscmp(argv[9],L"--"))return 64;
  const wchar_t *statusPath=argv[2];
  const wchar_t *cwd=wcscmp(argv[4],L"-")==0?NULL:argv[4];
  const wchar_t *releasePath=argv[8];
  if(!statusPath[0]||!releasePath[0]||!argv[commandIndex][0])return managed ? 512 : 64;
  wchar_t cancelPath[32768]={0}, terminalPath[32768]={0};
  if(managed && (wcslen(statusPath)>32000 ||
      swprintf(cancelPath,32768,L"%ls.cancel",statusPath)<0 ||
      swprintf(terminalPath,32768,L"%ls.terminal",statusPath)<0))return managed ? 512 : 64;
  wchar_t *parentEnd=NULL;
  unsigned long parentPid=wcstoul(argv[6],&parentEnd,10);
  if(!argv[6][0]||*parentEnd)return managed ? 512 : 64;
  // No Job is created, handle published, or root resumed on missing HIGH
  // token/elevation/mandatory no-write-up or failed process DACL readback.
  if(!enforce_guardian_isolation())return managed ? 512 : 79;
  // Guardian's handle to volatile parent prevents PID reuse while it lives.
  // Volatile sessions watch Agent; durable sidecars watch their own worker.
  // Neither mode may depend solely on ancestry after Agent exit.
  HANDLE parent=parentPid?OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,
    FALSE,parentPid):NULL;
  if(parentPid&&!parent){diagnostic(L"parent_open");return managed ? 512 : 70;}
  DWORD session=0;
  if(managed && (!managed_session_trusted(parent,(DWORD)parentPid,&session) ||
      cancellation_pending(cancelPath))){
    diagnostic(L"managed_parent_session_or_cancel");
    if(parent)CloseHandle(parent);
    return managed ? 512 : 79;
  }
  size_t total=1;
  for(int i=commandIndex;i<argc;i++)total+=wcslen(argv[i])*2+4;
  if(total>32760){fwprintf(stderr,L"NEXOWIRE_WINJOB_ERROR command_too_long\n");return managed ? 512 : 64;}
  wchar_t *cmd=(wchar_t*)calloc(total,sizeof(wchar_t));
  if(!cmd)return managed ? 512 : 70;
  wchar_t *out=cmd; const wchar_t *end=cmd+total-1;
  for(int i=commandIndex;i<argc;i++){
    if(i>commandIndex){if(out>=end){free(cmd);return managed ? 512 : 64;}*out++=L' ';}
    if(!quote_arg(argv[i],&out,end)){free(cmd);return managed ? 512 : 64;}
  }
  *out=0;

  // Unnamed Job: no public OpenJobObject(name) surface.
  // The guardian's HIGH integrity/token and protected process DACL form
  // the separate boundary against MEDIUM-integrity PROCESS_DUP_HANDLE.
  // A same-HIGH attacker can still duplicate and retain this handle.
  HANDLE job=CreateJobObjectW(NULL,NULL);
  if(!job){diagnostic(L"create_job");free(cmd);return managed ? 512 : 70;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit={0};
  limit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,
       &limit,sizeof(limit))){
    diagnostic(L"set_limit");CloseHandle(job);free(cmd);return managed ? 512 : 70;
  }
  STARTUPINFOW si={0};si.cb=sizeof(si);
  si.dwFlags=STARTF_USESTDHANDLES;
  si.hStdInput=GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError=GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION pi={0};
  // Inherited stdout/stderr/stdin are Node's pipes to this helper.
  BOOL created=managed ? create_managed_root(cmd,cwd,&pi) :
    CreateProcessW(NULL,cmd,NULL,NULL,TRUE,
      CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,cwd,&si,&pi);
  free(cmd);
  if(!created){diagnostic(L"create_process");CloseHandle(job);return managed ? 512 : 70;}
  if(!AssignProcessToJobObject(job,pi.hProcess)){
    diagnostic(L"assign_job");
    TerminateProcess(pi.hProcess,71);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return managed ? 512 : 71;
  }
  BOOL inside=FALSE;
  if(!IsProcessInJob(pi.hProcess,job,&inside)||!inside){
    diagnostic(L"verify_job");
    TerminateJobObject(job,72);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return managed ? 512 : 72;
  }
  DWORD childSession=0;
  if(managed && (!ProcessIdToSessionId(pi.dwProcessId,&childSession) || childSession!=session)){
    (void)terminate_and_observe_empty(job,79);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    if(parent)CloseHandle(parent);
    return managed ? 512 : 79;
  }
  FILETIME c={0},e={0},k={0},u={0};
  if(!GetProcessTimes(pi.hProcess,&c,&e,&k,&u)){
    diagnostic(L"process_times");
    TerminateJobObject(job,73);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return managed ? 512 : 73;
  }
  unsigned long long ticks=((unsigned long long)c.dwHighDateTime<<32)|c.dwLowDateTime;
  wchar_t message[128]={0};
  int length=0;
  if(managed){
    FILETIME gc,ge,gk,gu;
    if(!GetProcessTimes(GetCurrentProcess(),&gc,&ge,&gk,&gu)){
      (void)terminate_and_observe_empty(job,79);
      CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
      if(parent)CloseHandle(parent);
      return 512;
    }
    unsigned long long guardianTicks=((unsigned long long)gc.dwHighDateTime<<32)|gc.dwLowDateTime;
    length=swprintf(message,128,L"NWJOB6 %lu %llu %llu %llu %lu\n",pi.dwProcessId,ticks,
      (unsigned long long)(uintptr_t)job,guardianTicks,(unsigned long)session);
  }else length=swprintf(message,128,L"NWJOB5 %lu %llu %llu\n",pi.dwProcessId,ticks,
    (unsigned long long)(uintptr_t)job);
  if(length<=0 || length>=128){
    (void)terminate_and_observe_empty(job,74);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    if(parent)CloseHandle(parent);
    return managed ? 512 : 74;
  }
  HANDLE marker=CreateFileW(statusPath,GENERIC_WRITE,0,NULL,CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL,NULL);
  if(marker==INVALID_HANDLE_VALUE){
    diagnostic(L"status_create");
    TerminateJobObject(job,74);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return managed ? 512 : 74;
  }
  char utf8[128]={0};DWORD count=0;
  int size=WideCharToMultiByte(CP_UTF8,0,message,length,utf8,sizeof(utf8),NULL,NULL);
  BOOL published=size>0&&WriteFile(marker,utf8,(DWORD)size,&count,NULL)&&
    count==(DWORD)size&&FlushFileBuffers(marker);
  CloseHandle(marker);
  if(!published){
    diagnostic(L"status_write");
    DeleteFileW(statusPath);
    TerminateJobObject(job,75);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return managed ? 512 : 75;
  }
  // The suspended root MUST remain suspended until the Agent independently
  // duplicates this exact unnamed Job handle from the guardian and verifies
  // the kernel membership, creation identity and Job limits.
  // A plaintext marker never authorizes process execution on its own.
  BOOL released=FALSE;
  for(int i=0;i<400;i++){
    if(parent && WaitForSingleObject(parent,0)!=WAIT_TIMEOUT)break;
    if(managed && cancellation_pending(cancelPath))break;
    HANDLE gate=CreateFileW(releasePath,GENERIC_READ,FILE_SHARE_READ,NULL,
      OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    if(gate!=INVALID_HANDLE_VALUE){CloseHandle(gate);released=TRUE;break;}
    Sleep(25);
  }
  if(!released){
    fwprintf(stderr,L"NEXOWIRE_WINJOB_ERROR verification_gate_timeout\\n");
    TerminateJobObject(job,76);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    if(parent)CloseHandle(parent);
    return managed ? 512 : 76;
  }
  // A release marker alone does not allow the root to resume. New equal-HIGH
  // PROCESS_DUP_HANDLE opens must be denied BEFORE the first side effect.
  // A stolen handle from the initial attestation window remains P0 BLOCKED.
  if(!seal_guardian_after_attestation()){
    TerminateJobObject(job,79);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    if(parent)CloseHandle(parent);
    return managed ? 512 : 79;
  }
  if((parent && WaitForSingleObject(parent,0)!=WAIT_TIMEOUT) ||
     (managed && cancellation_pending(cancelPath)) || ResumeThread(pi.hThread)!=1){
    diagnostic(L"resume");
    TerminateJobObject(job,76);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return managed ? 512 : 76;
  }
  CloseHandle(pi.hThread);
  // A Job handle is NOT signaled on ordinary last-process exit. Query the
  // accounting instead, and also watch the owning Agent for volatile tasks.
  DWORD reason=0; // 0 natural, 1 requested stop, 2 timeout, 3 owner loss
  BOOL empty=FALSE;
  ULONGLONG began=GetTickCount64();
  for(;;){
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting={0};
    if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,
           &accounting,sizeof(accounting),NULL)){
      diagnostic(L"job_accounting");
      (void)terminate_and_observe_empty(job,77);
      break;
    }
    if(accounting.ActiveProcesses==0){empty=TRUE;break;}
    if(parent && WaitForSingleObject(parent,0)!=WAIT_TIMEOUT)reason=3;
    else if(managed && cancellation_pending(cancelPath))reason=1;
    else if(managed && runtimeTimeout && GetTickCount64()-began>=runtimeTimeout)reason=2;
    if(reason){
      DWORD terminationCode=reason==1?125:reason==2?124:78;
      // Terminate through our retained exact Job HANDLE, then query its
      // accounting. Closing/killing the guardian is not cleanup evidence.
      empty=terminate_and_observe_empty(job,terminationCode);
      break;
    }
    Sleep(25);
  }
  DWORD result=1;
  BOOL terminal=empty && WaitForSingleObject(pi.hProcess,0)==WAIT_OBJECT_0 &&
    GetExitCodeProcess(pi.hProcess,&result);
  if(managed && terminal)
    terminal=publish_managed_terminal(terminalPath,pi.dwProcessId,ticks,reason,result);
  CloseHandle(pi.hProcess);
  CloseHandle(job);
  if(parent)CloseHandle(parent);
  // All managed protocol errors use a disjoint exit code. A root cannot
  // forge a valid local completion merely by precreating the terminal file.
  if(!terminal)return managed ? 512 : 77;
  if(reason==1)return 125;
  if(reason==2)return 124;
  if(reason==3)return 78;
  return result<=255?(int)result:1;
}
