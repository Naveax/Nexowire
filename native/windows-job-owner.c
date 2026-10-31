// Nexowire Windows Job Object owner. Build as a console subsystem EXE.
// No native process is resumed unless its Job assignment is proven.
#define WIN32_LEAN_AND_MEAN
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
  SID_IDENTIFIER_AUTHORITY ntAuthority=SECURITY_NT_AUTHORITY;
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
     wcscmp(argv[7],L"--release") || wcscmp(argv[9],L"--")){
    fwprintf(stderr,L"NEXOWIRE_WINJOB_ERROR invalid_arguments\n");
    return 64;
  }
  const wchar_t *statusPath=argv[2];
  const wchar_t *cwd=wcscmp(argv[4],L"-")==0?NULL:argv[4];
  const wchar_t *releasePath=argv[8];
  if(!statusPath[0]||!releasePath[0]||!argv[10][0])return 64;
  wchar_t *parentEnd=NULL;
  unsigned long parentPid=wcstoul(argv[6],&parentEnd,10);
  if(!argv[6][0]||*parentEnd)return 64;
  // No Job is created, handle published, or root resumed on missing HIGH
  // token/elevation/mandatory no-write-up or failed process DACL readback.
  if(!enforce_guardian_isolation())return 79;
  // Guardian's handle to volatile parent prevents PID reuse while it lives.
  // Volatile sessions watch Agent; durable sidecars watch their own worker.
  // Neither mode may depend solely on ancestry after Agent exit.
  HANDLE parent=parentPid?OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,
    FALSE,parentPid):NULL;
  if(parentPid&&!parent){diagnostic(L"parent_open");return 70;}
  size_t total=1;
  for(int i=10;i<argc;i++)total+=wcslen(argv[i])*2+4;
  if(total>32760){fwprintf(stderr,L"NEXOWIRE_WINJOB_ERROR command_too_long\n");return 64;}
  wchar_t *cmd=(wchar_t*)calloc(total,sizeof(wchar_t));
  if(!cmd)return 70;
  wchar_t *out=cmd; const wchar_t *end=cmd+total-1;
  for(int i=10;i<argc;i++){
    if(i>10){if(out>=end){free(cmd);return 64;}*out++=L' ';}
    if(!quote_arg(argv[i],&out,end)){free(cmd);return 64;}
  }
  *out=0;

  // Unnamed Job: no public OpenJobObject(name) surface.
  // The guardian's HIGH integrity/token and protected process DACL form
  // the separate boundary against MEDIUM-integrity PROCESS_DUP_HANDLE.
  // A same-HIGH attacker can still duplicate and retain this handle.
  HANDLE job=CreateJobObjectW(NULL,NULL);
  if(!job){diagnostic(L"create_job");free(cmd);return 70;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit={0};
  limit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,
       &limit,sizeof(limit))){
    diagnostic(L"set_limit");CloseHandle(job);free(cmd);return 70;
  }
  // Do NOT allow CreateProcessW(TRUE) to leak unrelated inheritable guardian
  // handles into the target. Duplicate only the three expected standard IO
  // handles as inheritable, then restrict inheritance to that exact allowlist.
  // A missing standard handle or attribute-list failure is terminal: the
  // suspended root must never start with an unrestricted inheritance fallback.
  HANDLE originalStdio[3]={
    GetStdHandle(STD_INPUT_HANDLE),
    GetStdHandle(STD_OUTPUT_HANDLE),
    GetStdHandle(STD_ERROR_HANDLE)
  };
  HANDLE inheritedStdio[3]={NULL,NULL,NULL};
  STARTUPINFOEXW si={0};
  PROCESS_INFORMATION pi={0};
  LPPROC_THREAD_ATTRIBUTE_LIST attrs=NULL;
  SIZE_T attrsSize=0;
  BOOL attrsReady=FALSE;
  BOOL canLaunch=TRUE;
  for(int i=0;i<3;i++){
    if(!originalStdio[i] || originalStdio[i]==INVALID_HANDLE_VALUE ||
       !DuplicateHandle(GetCurrentProcess(),originalStdio[i],
         GetCurrentProcess(),&inheritedStdio[i],0,TRUE,DUPLICATE_SAME_ACCESS)){
      canLaunch=FALSE;
      break;
    }
  }
  if(canLaunch){
    // First call obtains the required size and normally reports
    // ERROR_INSUFFICIENT_BUFFER; only a zero size is an error here.
    InitializeProcThreadAttributeList(NULL,1,0,&attrsSize);
    if(attrsSize==0)canLaunch=FALSE;
  }
  if(canLaunch){
    attrs=(LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(),0,attrsSize);
    if(!attrs || !InitializeProcThreadAttributeList(attrs,1,0,&attrsSize)){
      canLaunch=FALSE;
    } else {
      attrsReady=TRUE;
    }
  }
  if(canLaunch && !UpdateProcThreadAttribute(attrs,0,
      PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inheritedStdio,
      sizeof(inheritedStdio),NULL,NULL)){
    canLaunch=FALSE;
  }
  si.StartupInfo.cb=sizeof(si);
  si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput=inheritedStdio[0];
  si.StartupInfo.hStdOutput=inheritedStdio[1];
  si.StartupInfo.hStdError=inheritedStdio[2];
  si.lpAttributeList=attrs;
  BOOL created=FALSE;
  if(canLaunch){
    created=CreateProcessW(NULL,cmd,NULL,NULL,TRUE,
      CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,
      NULL,cwd,&si.StartupInfo,&pi);
  }
  // No source handle is made inheritable; close temporary duplicates even
  // if CreateProcessW failed. The Job kernel handle remains guardian-only.
  if(attrsReady)DeleteProcThreadAttributeList(attrs);
  if(attrs)HeapFree(GetProcessHeap(),0,attrs);
  for(int i=0;i<3;i++)if(inheritedStdio[i])CloseHandle(inheritedStdio[i]);
  free(cmd);
  if(!created){
    diagnostic(L"create_process_restricted_inheritance");
    CloseHandle(job);
    return 70;
  }
  if(!AssignProcessToJobObject(job,pi.hProcess)){
    diagnostic(L"assign_job");
    TerminateProcess(pi.hProcess,71);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return 71;
  }
  BOOL inside=FALSE;
  if(!IsProcessInJob(pi.hProcess,job,&inside)||!inside){
    diagnostic(L"verify_job");
    TerminateJobObject(job,72);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return 72;
  }
  FILETIME c={0},e={0},k={0},u={0};
  if(!GetProcessTimes(pi.hProcess,&c,&e,&k,&u)){
    diagnostic(L"process_times");
    TerminateJobObject(job,73);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return 73;
  }
  unsigned long long ticks=((unsigned long long)c.dwHighDateTime<<32)|c.dwLowDateTime;
  wchar_t message[128]={0};
  int length=swprintf(message,128,L"NWJOB5 %lu %llu %llu\n",pi.dwProcessId,ticks,
    (unsigned long long)(uintptr_t)job);
  HANDLE marker=CreateFileW(statusPath,GENERIC_WRITE,0,NULL,CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL,NULL);
  if(marker==INVALID_HANDLE_VALUE){
    diagnostic(L"status_create");
    TerminateJobObject(job,74);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return 74;
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
    return 75;
  }
  // The suspended root MUST remain suspended until the Agent independently
  // duplicates this exact unnamed Job handle from the guardian and verifies
  // the kernel membership, creation identity and Job limits.
  // A plaintext marker never authorizes process execution on its own.
  BOOL released=FALSE;
  for(int i=0;i<400;i++){
    HANDLE gate=CreateFileW(releasePath,GENERIC_READ,FILE_SHARE_READ,NULL,
      OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    if(gate!=INVALID_HANDLE_VALUE){CloseHandle(gate);released=TRUE;break;}
    if(parent && WaitForSingleObject(parent,0)==WAIT_OBJECT_0)break;
    Sleep(25);
  }
  if(!released){
    fwprintf(stderr,L"NEXOWIRE_WINJOB_ERROR verification_gate_timeout\\n");
    TerminateJobObject(job,76);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    if(parent)CloseHandle(parent);
    return 76;
  }
  // A release marker alone does not allow the root to resume. New equal-HIGH
  // PROCESS_DUP_HANDLE opens must be denied BEFORE the first side effect.
  // A stolen handle from the initial attestation window remains P0 BLOCKED.
  if(!seal_guardian_after_attestation()){
    TerminateJobObject(job,79);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    if(parent)CloseHandle(parent);
    return 79;
  }
  if(ResumeThread(pi.hThread)==(DWORD)-1){
    diagnostic(L"resume");
    TerminateJobObject(job,76);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);
    return 76;
  }
  CloseHandle(pi.hThread);
  // A Job handle is NOT signaled on ordinary last-process exit. Query the
  // accounting instead, and also watch the owning Agent for volatile tasks.
  for(;;){
    if(parent && WaitForSingleObject(parent,0)==WAIT_OBJECT_0){
      // Do not assume the guardian owns the only Job handle: the named Job
      // may temporarily be opened by an independent verifier. Explicitly
      // terminate members even when another query handle remains open.
      TerminateJobObject(job,78);
      CloseHandle(job);CloseHandle(pi.hProcess);CloseHandle(parent);return 78;
    }
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting={0};
    if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,
           &accounting,sizeof(accounting),NULL)){
      diagnostic(L"job_accounting");
      TerminateJobObject(job,77);
      CloseHandle(job);CloseHandle(pi.hProcess);
      if(parent)CloseHandle(parent);
      return 77;
    }
    if(accounting.ActiveProcesses==0)break;
    Sleep(25);
  }
  DWORD result=1;GetExitCodeProcess(pi.hProcess,&result);
  CloseHandle(pi.hProcess);
  CloseHandle(job);
  if(parent)CloseHandle(parent);
  return result<=255?(int)result:1;
}
