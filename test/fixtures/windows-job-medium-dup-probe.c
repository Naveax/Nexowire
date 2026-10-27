// Isolated Windows P0 security regression, never bundled into a release.
// Uses a real UAC-linked MEDIUM token belonging to this HIGH caller.
// Does not install software, alter token/ACL of a running host process,
// or manipulate any Job. Child only requests PROCESS_DUP_HANDLE on the
// exact disposable guardian PID supplied by the test harness.
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static BOOL token_identity(HANDLE token, DWORD *level, DWORD *elevated) {
  BYTE raw[sizeof(TOKEN_MANDATORY_LABEL)+SECURITY_MAX_SID_SIZE]={0};
  DWORD size=0;
  TOKEN_ELEVATION elevation={0};
  if(!GetTokenInformation(token,TokenIntegrityLevel,raw,sizeof(raw),&size) ||
     !GetTokenInformation(token,TokenElevation,&elevation,sizeof(elevation),&size))
    return FALSE;
  PSID sid=((TOKEN_MANDATORY_LABEL*)raw)->Label.Sid;
  if(!IsValidSid(sid))return FALSE;
  DWORD parts=*GetSidSubAuthorityCount(sid);
  if(!parts)return FALSE;
  *level=*GetSidSubAuthority(sid,parts-1);
  *elevated=elevation.TokenIsElevated;
  return TRUE;
}

static BOOL same_logon_session(HANDLE a, HANDLE b) {
  BYTE left[1024]={0},right[1024]={0};
  DWORD bytes=0;
  if(!GetTokenInformation(a,TokenUser,left,sizeof(left),&bytes) ||
     !GetTokenInformation(b,TokenUser,right,sizeof(right),&bytes))return FALSE;
  if(!EqualSid(((TOKEN_USER*)left)->User.Sid,((TOKEN_USER*)right)->User.Sid))
    return FALSE;
  TOKEN_STATISTICS high={0},medium={0};
  DWORD first=0,second=0;
  DWORD highSession=0,mediumSession=0;
  if(!GetTokenInformation(a,TokenStatistics,&high,sizeof(high),&first) ||
     !GetTokenInformation(b,TokenStatistics,&medium,sizeof(medium),&second) ||
     !GetTokenInformation(a,TokenSessionId,&highSession,sizeof(highSession),&first) ||
     !GetTokenInformation(b,TokenSessionId,&mediumSession,sizeof(mediumSession),&second))
    return FALSE;
  return high.AuthenticationId.HighPart==medium.AuthenticationId.HighPart &&
    high.AuthenticationId.LowPart==medium.AuthenticationId.LowPart &&
    highSession==mediumSession;
}

int wmain(int argc,wchar_t **argv) {
  if(argc!=3 || (wcscmp(argv[1],L"--probe") &&
                   wcscmp(argv[1],L"--child")))return 64;
  wchar_t *end=NULL;
  unsigned long guardian=wcstoul(argv[2],&end,10);
  if(!guardian || !end || *end)return 64;
  HANDLE current=NULL;
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&current))return 77;
  DWORD level=0,elevated=0;
  if(!token_identity(current,&level,&elevated)){CloseHandle(current);return 77;}
  if(!wcscmp(argv[1],L"--child")) {
    CloseHandle(current);
    // Not even a filtered HIGH token or a forged environment variable counts.
    if(level!=SECURITY_MANDATORY_MEDIUM_RID || elevated)return 78;
    HANDLE stolen=OpenProcess(PROCESS_DUP_HANDLE,FALSE,(DWORD)guardian);
    if(stolen){CloseHandle(stolen);return 3;}
    return GetLastError()==ERROR_ACCESS_DENIED?0:79;
  }
  if(level<SECURITY_MANDATORY_HIGH_RID || !elevated) {
    CloseHandle(current);return 77;
  }
  TOKEN_LINKED_TOKEN link={0};DWORD returned=0;
  if(!GetTokenInformation(current,TokenLinkedToken,&link,sizeof(link),&returned) ||
     !link.LinkedToken) {
    CloseHandle(current);
    wprintf(L"NX_MEDIUM_HIGH_PROOF_BLOCKED linked_token_unavailable\n");
    return 77;
  }
  DWORD medium=0,lowElevation=0;
  BOOL matched=same_logon_session(current,link.LinkedToken);
  BOOL realMedium=token_identity(link.LinkedToken,&medium,&lowElevation) &&
    medium==SECURITY_MANDATORY_MEDIUM_RID && !lowElevation && matched;
  CloseHandle(current);
  if(!realMedium) {
    CloseHandle(link.LinkedToken);
    wprintf(L"NX_MEDIUM_HIGH_PROOF_BLOCKED linked_token_not_medium_same_user\n");
    return 77;
  }
  wchar_t binary[MAX_PATH]={0};
  if(!GetModuleFileNameW(NULL,binary,MAX_PATH) ||
     wcslen(binary)>=MAX_PATH-1) {
    CloseHandle(link.LinkedToken);return 77;
  }
  wchar_t command[2*MAX_PATH]={0};
  if(swprintf(command,2*MAX_PATH,L"\"%ls\" --child %lu",binary,guardian)<0) {
    CloseHandle(link.LinkedToken);return 77;
  }
  STARTUPINFOW startup={0};startup.cb=sizeof(startup);
  PROCESS_INFORMATION process={0};
  BOOL spawned=CreateProcessWithTokenW(link.LinkedToken,0,binary,command,
    CREATE_NO_WINDOW,NULL,NULL,&startup,&process);
  DWORD error=spawned?ERROR_SUCCESS:GetLastError();
  CloseHandle(link.LinkedToken);
  if(!spawned) {
    wprintf(L"NX_MEDIUM_HIGH_PROOF_BLOCKED child_spawn_win32_%lu\n",error);
    return 77;
  }
  DWORD wait=WaitForSingleObject(process.hProcess,10000);
  DWORD status=79;
  if(wait==WAIT_OBJECT_0)GetExitCodeProcess(process.hProcess,&status);
  if(wait!=WAIT_OBJECT_0)TerminateProcess(process.hProcess,79);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if(status==0) {
    wprintf(L"NX_REAL_MEDIUM_TO_HIGH_DUP_HANDLE_DENIED same_user=1 elevated_guardian=1\n");
    return 0;
  }
  if(status==3) {
    wprintf(L"NX_REAL_MEDIUM_TO_HIGH_DUP_HANDLE_ALLOWED SECURITY_FAILURE\n");
    return 3;
  }
  wprintf(L"NX_MEDIUM_HIGH_PROOF_BLOCKED child_status_%lu\n",status);
  return 77;
}
