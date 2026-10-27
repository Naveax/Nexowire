// Disposable native Windows Job security fixture. Never ship in a release.
// Verifies the exact HIGH guardian kernel process token from a process handle,
// creates a real OS-issued UAC-linked MEDIUM process in the same logon/session,
// independently reads the child token, and probes PROCESS_DUP_HANDLE.
// No installed Broker, UAC prompt, ACL or service is ever modified.
// Exit 0 = bounded cross-integrity synthetic Job fixture only.
// Exit 3 = SECURITY FAILURE (medium peer received PROCESS_DUP_HANDLE).
// Exit 77 = BLOCKED (missing/unverifiable OS token or process evidence).
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <stdint.h>

static int blocked(const wchar_t *reason) {
  wprintf(L"NX_MEDIUM_HIGH_PROOF_BLOCKED %ls\n",reason);
  return 77;
}
static BOOL token_identity(HANDLE token,DWORD *level,DWORD *elevated) {
  BYTE raw[sizeof(TOKEN_MANDATORY_LABEL)+SECURITY_MAX_SID_SIZE]={0};
  DWORD size=0;
  TOKEN_ELEVATION elevation={0};
  if(!GetTokenInformation(token,TokenIntegrityLevel,raw,sizeof(raw),&size) ||
     !GetTokenInformation(token,TokenElevation,&elevation,sizeof(elevation),&size))
    return FALSE;
  PSID sid=((TOKEN_MANDATORY_LABEL*)raw)->Label.Sid;
  if(!IsValidSid(sid))return FALSE;
  DWORD count=*GetSidSubAuthorityCount(sid);
  if(!count)return FALSE;
  *level=*GetSidSubAuthority(sid,count-1);
  *elevated=elevation.TokenIsElevated;
  return TRUE;
}
static BOOL same_logon_session(HANDLE a,HANDLE b) {
  BYTE left[1024]={0},right[1024]={0};
  DWORD bytes=0;
  if(!GetTokenInformation(a,TokenUser,left,sizeof(left),&bytes) ||
     !GetTokenInformation(b,TokenUser,right,sizeof(right),&bytes))
    return FALSE;
  if(!EqualSid(((TOKEN_USER*)left)->User.Sid,
               ((TOKEN_USER*)right)->User.Sid))return FALSE;
  TOKEN_STATISTICS one={0},two={0};
  DWORD size1=0,size2=0;
  DWORD session1=0,session2=0;
  if(!GetTokenInformation(a,TokenStatistics,&one,sizeof(one),&size1) ||
     !GetTokenInformation(b,TokenStatistics,&two,sizeof(two),&size2) ||
     !GetTokenInformation(a,TokenSessionId,&session1,sizeof(session1),&size1) ||
     !GetTokenInformation(b,TokenSessionId,&session2,sizeof(session2),&size2))
    return FALSE;
  return one.AuthenticationId.HighPart==two.AuthenticationId.HighPart &&
         one.AuthenticationId.LowPart==two.AuthenticationId.LowPart &&
         session1==session2;
}
static BOOL process_identity(HANDLE process,FILETIME *birth) {
  FILETIME exitTime={0},kernel={0},user={0};
  if(!GetProcessTimes(process,birth,&exitTime,&kernel,&user))return FALSE;
  if(WaitForSingleObject(process,0)!=WAIT_TIMEOUT)return FALSE;
  return TRUE;
}
static int child_probe(DWORD pid,HANDLE current) {
  DWORD level=0,elevated=0;
  if(!token_identity(current,&level,&elevated) ||
     level!=SECURITY_MANDATORY_MEDIUM_RID || elevated)
    return 78;
  // A successful open is already a security failure: the caller could
  // duplicate any readable guardian Job handle. No real Job is touched.
  HANDLE dup=OpenProcess(PROCESS_DUP_HANDLE,FALSE,pid);
  if(dup) {CloseHandle(dup);return 3;}
  DWORD error=GetLastError();
  return error==ERROR_ACCESS_DENIED?0:79;
}

/*
 * Equal-HIGH same-logon attack fixture against the EXACT synthetic guardian.
 * It first independently checks both kernel token objects, SID, integrity,
 * elevation, logon LUID, session ID and a held guardian process HANDLE.
 * Never enable SeDebugPrivilege or alter any process ACL. If SeDebug is already
 * enabled, report BLOCKED instead of claiming a DACL result.
 */
static BOOL debug_privilege_enabled(HANDLE token,BOOL *enabled) {
  *enabled=FALSE;
  LUID debug={0};
  if(!LookupPrivilegeValueW(NULL,SE_DEBUG_NAME,&debug))return FALSE;
  DWORD bytes=0;
  GetTokenInformation(token,TokenPrivileges,NULL,0,&bytes);
  if(!bytes || bytes>128*1024)return FALSE;
  TOKEN_PRIVILEGES *privileges=(TOKEN_PRIVILEGES*)calloc(1,bytes);
  if(!privileges)return FALSE;
  BOOL valid=GetTokenInformation(token,TokenPrivileges,privileges,bytes,&bytes);
  if(valid){
    for(DWORD i=0;i<privileges->PrivilegeCount;i++){
      LUID luid=privileges->Privileges[i].Luid;
      if(luid.HighPart==debug.HighPart && luid.LowPart==debug.LowPart)
        *enabled=(privileges->Privileges[i].Attributes&SE_PRIVILEGE_ENABLED)!=0;
    }
  }
  free(privileges);
  return valid;
}
static int equal_high_probe(DWORD pid,uintptr_t jobValue,HANDLE current) {
  DWORD level=0,elevated=0;
  BOOL debug=FALSE;
  if(!token_identity(current,&level,&elevated) ||
     level<SECURITY_MANDATORY_HIGH_RID || !elevated ||
     !debug_privilege_enabled(current,&debug) || debug)
    return blocked(L"attacker_token_not_high_or_debug_enabled");
  HANDLE guardian=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,
    FALSE,pid);
  if(!guardian)return blocked(L"guardian_query_denied");
  HANDLE victimToken=NULL;
  FILETIME created={0},after={0};
  DWORD gLevel=0,gElevated=0;
  BOOL verified=OpenProcessToken(guardian,TOKEN_QUERY,&victimToken) &&
    token_identity(victimToken,&gLevel,&gElevated) &&
    gLevel==level && gElevated && same_logon_session(current,victimToken) &&
    process_identity(guardian,&created);
  if(victimToken)CloseHandle(victimToken);
  if(!verified) {CloseHandle(guardian);return blocked(L"high_equal_logon_not_verified");}

  HANDLE source=OpenProcess(PROCESS_DUP_HANDLE,FALSE,pid);
  DWORD error=source?ERROR_SUCCESS:GetLastError();
  BOOL duplicateSucceeded=FALSE;
  if(source) {
    HANDLE copied=NULL;
    duplicateSucceeded=DuplicateHandle(source,(HANDLE)jobValue,
      GetCurrentProcess(),&copied,JOB_OBJECT_QUERY,FALSE,0);
    if(copied)CloseHandle(copied);
    CloseHandle(source);
  }
  BOOL sameObject=process_identity(guardian,&after) &&
    created.dwHighDateTime==after.dwHighDateTime &&
    created.dwLowDateTime==after.dwLowDateTime;
  CloseHandle(guardian);
  if(!sameObject)return blocked(L"guardian_pid_or_creation_changed");
  if(source) {
    wprintf(L"NX_EQUAL_HIGH_PROCESS_DUP_HANDLE_ALLOWED duplicate_success=%d\n",
      duplicateSucceeded?1:0);
    return 3;
  }
  if(error!=ERROR_ACCESS_DENIED)
    return blocked(L"process_open_failed_without_access_denied");
  wprintf(L"NX_EQUAL_HIGH_PROCESS_DUP_HANDLE_DENIED sid_luid_session_verified=1 sedebug_enabled=0\n");
  return 0;
}

int wmain(int argc,wchar_t **argv) {
  BOOL highProbe=argc==4 && !wcscmp(argv[1],L"--probe-high");
  if(!highProbe && (argc!=3 || (wcscmp(argv[1],L"--probe") &&
                                  wcscmp(argv[1],L"--child"))))return 64;
  wchar_t *end=NULL;
  unsigned long parsed=wcstoul(argv[2],&end,10);
  if(!parsed || !end || *end)return 64;
  DWORD pid=(DWORD)parsed;
  HANDLE current=NULL;
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&current))
    return blocked(L"controller_token_unavailable");
  DWORD level=0,elevated=0;
  if(!token_identity(current,&level,&elevated)) {
    CloseHandle(current);return blocked(L"controller_token_unverifiable");
  }
  if(highProbe) {
    wchar_t *handleEnd=NULL;
    unsigned long long raw=_wcstoui64(argv[3],&handleEnd,10);
    if(!argv[3][0] || !handleEnd || *handleEnd || !raw ||
       (unsigned long long)(uintptr_t)raw!=raw) {
      CloseHandle(current);return 64;
    }
    int result=equal_high_probe(pid,(uintptr_t)raw,current);
    CloseHandle(current);
    return result;
  }
  if(!wcscmp(argv[1],L"--child")) {
    int result=child_probe(pid,current);
    CloseHandle(current);
    return result;
  }
  if(level<SECURITY_MANDATORY_HIGH_RID || !elevated) {
    CloseHandle(current);return blocked(L"controller_not_elevated_high");
  }

  // Kernel process handle stays open across spawning and token verification.
  // PID reuse cannot substitute a different process for the tested guardian.
  HANDLE guardian=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,
                             FALSE,pid);
  if(!guardian) {CloseHandle(current);return blocked(L"guardian_process_unavailable");}
  HANDLE targetToken=NULL;
  if(!OpenProcessToken(guardian,TOKEN_QUERY,&targetToken)) {
    CloseHandle(guardian);CloseHandle(current);
    return blocked(L"guardian_token_unavailable");
  }
  FILETIME birth={0};
  DWORD targetLevel=0,targetElevation=0;
  BOOL validated=token_identity(targetToken,&targetLevel,&targetElevation) &&
    targetLevel>=SECURITY_MANDATORY_HIGH_RID && targetElevation &&
    same_logon_session(current,targetToken) &&
    process_identity(guardian,&birth);
  if(!validated) {
    CloseHandle(targetToken);CloseHandle(guardian);CloseHandle(current);
    return blocked(L"guardian_high_token_or_logon_not_verified");
  }
  TOKEN_LINKED_TOKEN linked={0};DWORD returned=0;
  if(!GetTokenInformation(current,TokenLinkedToken,&linked,sizeof(linked),&returned)
     || !linked.LinkedToken) {
    CloseHandle(targetToken);CloseHandle(guardian);CloseHandle(current);
    return blocked(L"linked_token_unavailable");
  }
  DWORD medium=0,lowElevation=0;
  BOOL validMedium=token_identity(linked.LinkedToken,&medium,&lowElevation) &&
    medium==SECURITY_MANDATORY_MEDIUM_RID && !lowElevation &&
    same_logon_session(linked.LinkedToken,targetToken);
  CloseHandle(current);
  if(!validMedium) {
    CloseHandle(linked.LinkedToken);CloseHandle(targetToken);CloseHandle(guardian);
    return blocked(L"linked_token_not_medium_same_logon");
  }
  wchar_t image[MAX_PATH]={0},command[2*MAX_PATH]={0};
  if(!GetModuleFileNameW(NULL,image,MAX_PATH) ||
     wcslen(image)>=MAX_PATH-1 ||
     swprintf(command,2*MAX_PATH,L"\"%ls\" --child %lu",image,pid)<0) {
    CloseHandle(linked.LinkedToken);CloseHandle(targetToken);CloseHandle(guardian);
    return blocked(L"fixture_image_unavailable");
  }
  STARTUPINFOW startup={0};startup.cb=sizeof(startup);
  PROCESS_INFORMATION child={0};
  BOOL started=CreateProcessWithTokenW(linked.LinkedToken,0,image,command,
    CREATE_NO_WINDOW,NULL,NULL,&startup,&child);
  DWORD spawnError=started?ERROR_SUCCESS:GetLastError();
  CloseHandle(linked.LinkedToken);
  if(!started) {
    CloseHandle(targetToken);CloseHandle(guardian);
    wprintf(L"NX_MEDIUM_HIGH_PROOF_BLOCKED linked_medium_spawn_win32_%lu\n",spawnError);
    return 77;
  }

  // The child's own kernel token must be checked by the HIGH verifier.
  // Child-returned text or exit code is not evidence of medium integrity.
  HANDLE childToken=NULL;
  DWORD childLevel=0,childElevation=0;
  BOOL childVerified=OpenProcessToken(child.hProcess,TOKEN_QUERY,&childToken) &&
    token_identity(childToken,&childLevel,&childElevation) &&
    childLevel==SECURITY_MANDATORY_MEDIUM_RID && !childElevation &&
    same_logon_session(childToken,targetToken);
  if(childToken)CloseHandle(childToken);
  DWORD waited=WaitForSingleObject(child.hProcess,10000);
  DWORD status=79;
  if(waited==WAIT_OBJECT_0)GetExitCodeProcess(child.hProcess,&status);
  if(waited!=WAIT_OBJECT_0)TerminateProcess(child.hProcess,79);
  CloseHandle(child.hThread);
  CloseHandle(child.hProcess);

  // The original guardian must be the exact same live kernel object.
  FILETIME after={0};
  BOOL sameGuardian=process_identity(guardian,&after) &&
    birth.dwHighDateTime==after.dwHighDateTime &&
    birth.dwLowDateTime==after.dwLowDateTime;
  CloseHandle(targetToken);
  CloseHandle(guardian);
  if(!childVerified || !sameGuardian)
    return blocked(L"child_medium_token_or_guardian_identity_unverified");
  if(status==3) {
    wprintf(L"NX_REAL_MEDIUM_TO_HIGH_DUP_HANDLE_ALLOWED SECURITY_FAILURE\n");
    return 3;
  }
  if(status!=0) {
    wprintf(L"NX_MEDIUM_HIGH_PROOF_BLOCKED child_probe_status_%lu\n",status);
    return 77;
  }
  wprintf(L"NX_FIXTURE_MEDIUM_TO_HIGH_PROCESS_DUP_HANDLE_DENIED same_logon_luid=1 guardian_token=high child_token=medium\n");
  return 0;
}
