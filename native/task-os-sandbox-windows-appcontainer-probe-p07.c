/* Disposable, fixed-payload Windows kernel diagnostic, NEVER a task launcher.
 * Only --selftest-only <new test directory> is a public entry point.
 * Creates/deletes ONLY its unique test AppContainer and fixture paths/processes.
 * No live Agent/Broker, arbitrary shell, service, UAC, VM or real grant.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <stdio.h>
#include <stdint.h>
#include <wchar.h>
#include <stdlib.h>
#include <string.h>

static const char *tokenFailure="not_observed";
static DWORD observedApp=0xffffffffUL,observedElevation=0xffffffffUL;
static DWORD observedIntegrity=0xffffffffUL,observedCapabilities=0xffffffffUL;
static BOOL observedPackageMatches=FALSE;
static DWORD observedUnexpectedPrivileges=0xffffffffUL,observedAdminMode=0xffffffffUL;
static DWORD observedUnexpectedEnabledPrivileges=0xffffffffUL;
#ifndef NEXOWIRE_FIXED_SANDBOX_CHILD
static BOOL initialDefaultUserAccess=FALSE,configuredDefaultUserAccess=FALSE;
static BOOL token_default_allows_user(HANDLE token,PSID userSid) {
  union {TOKEN_DEFAULT_DACL alignment;BYTE bytes[8192];} info={0};DWORD returned=0;
  if(!GetTokenInformation(token,TokenDefaultDacl,info.bytes,sizeof(info.bytes),&returned))return FALSE;
  PACL acl=((TOKEN_DEFAULT_DACL *)info.bytes)->DefaultDacl;
  if(!acl||!IsValidAcl(acl))return FALSE;
  for(DWORD i=0;i<acl->AceCount;i++){
    LPVOID raw=NULL;
    if(!GetAce(acl,i,&raw))return FALSE;
    ACE_HEADER *header=(ACE_HEADER *)raw;
    if(header->AceType==ACCESS_ALLOWED_ACE_TYPE){
      ACCESS_ALLOWED_ACE *ace=(ACCESS_ALLOWED_ACE *)raw;
      if(IsValidSid(&ace->SidStart)&&EqualSid(&ace->SidStart,userSid)&&(ace->Mask&GENERIC_ALL))return TRUE;
    }
  }
  return FALSE;
}
static BOOL set_worker_default_dacl(HANDLE token,const wchar_t *owner,const wchar_t *app,PSID userSid) {
  /* The parent token/default ACL is untouched. A deny-only Administrators SID
   * must not leave this NEW token dependent on an administrator-only default
   * DACL for the worker's own startup/synchronization objects. */
  initialDefaultUserAccess=token_default_allows_user(token,userSid);
  wchar_t sddl[1024]={0};PSECURITY_DESCRIPTOR sd=NULL;
  if(_snwprintf_s(sddl,1024,_TRUNCATE,L"D:P(A;;GA;;;SY)(A;;GA;;;%ls)(A;;GA;;;%ls)",owner,app)<=0||
    !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,SDDL_REVISION_1,&sd,NULL))return FALSE;
  PACL dacl=NULL;BOOL present=FALSE,defaulted=FALSE;
  TOKEN_DEFAULT_DACL value={0};
  BOOL ok=GetSecurityDescriptorDacl(sd,&present,&dacl,&defaulted)&&present&&dacl;
  if(ok){value.DefaultDacl=dacl;ok=SetTokenInformation(token,TokenDefaultDacl,&value,sizeof(value));}
  DWORD error=GetLastError();LocalFree(sd);
  if(ok){configuredDefaultUserAccess=token_default_allows_user(token,userSid);ok=configuredDefaultUserAccess;}
  if(!ok)SetLastError(error);return ok;
}
static HANDLE restricted_worker_token(HANDLE source,const char **stage) {
  union {SID alignment;BYTE bytes[SECURITY_MAX_SID_SIZE];} admin={0};DWORD bytes=sizeof(admin.bytes);
  if(!CreateWellKnownSid(WinBuiltinAdministratorsSid,NULL,admin.bytes,&bytes))return NULL;
  SID_AND_ATTRIBUTES disabled={admin.bytes,SE_GROUP_USE_FOR_DENY_ONLY};HANDLE token=NULL;
  *stage="restricted_worker_token_create";
  if(!CreateRestrictedToken(source,DISABLE_MAX_PRIVILEGE|LUA_TOKEN,1,&disabled,0,NULL,0,NULL,&token))return NULL;
  PSID low=NULL;
  if(!ConvertStringSidToSidW(L"S-1-16-4096",&low)){CloseHandle(token);return NULL;}
  TOKEN_MANDATORY_LABEL label={0};label.Label.Sid=low;label.Label.Attributes=SE_GROUP_INTEGRITY;
  *stage="restricted_worker_integrity_lower";
  BOOL lowered=SetTokenInformation(token,TokenIntegrityLevel,&label,(DWORD)(sizeof(label)+GetLengthSid(low)));
  DWORD error=GetLastError();LocalFree(low);
  if(!lowered){CloseHandle(token);SetLastError(error);return NULL;}
  return token;
}
#endif
static BOOL token_is_contained(HANDLE process,PSID expected) {
  HANDLE token=NULL;DWORD returned=0,isApp=0;
  TOKEN_ELEVATION elevation={0};BOOL ok=FALSE;
  union {TOKEN_MANDATORY_LABEL alignment;BYTE bytes[sizeof(TOKEN_MANDATORY_LABEL)+SECURITY_MAX_SID_SIZE];} label={0};
  union {TOKEN_APPCONTAINER_INFORMATION alignment;BYTE bytes[sizeof(TOKEN_APPCONTAINER_INFORMATION)+SECURITY_MAX_SID_SIZE];} app={0};
  union {TOKEN_GROUPS alignment;BYTE bytes[4096];} capabilities={0};
  union {TOKEN_PRIVILEGES alignment;BYTE bytes[4096];} privileges={0};
  union {TOKEN_GROUPS alignment;BYTE bytes[16384];} groups={0};
  tokenFailure="token_open";observedApp=observedElevation=observedIntegrity=observedCapabilities=0xffffffffUL;
  observedPackageMatches=FALSE;observedUnexpectedPrivileges=observedAdminMode=0xffffffffUL;
  observedUnexpectedEnabledPrivileges=0xffffffffUL;
  if(!OpenProcessToken(process,TOKEN_QUERY,&token))return FALSE;
  tokenFailure="token_information";
  if(!GetTokenInformation(token,TokenIsAppContainer,&isApp,sizeof(isApp),&returned)||
    !GetTokenInformation(token,TokenElevation,&elevation,sizeof(elevation),&returned)||
    !GetTokenInformation(token,TokenIntegrityLevel,label.bytes,sizeof(label.bytes),&returned)||
    !GetTokenInformation(token,TokenAppContainerSid,app.bytes,sizeof(app.bytes),&returned)||
    !GetTokenInformation(token,TokenCapabilities,capabilities.bytes,sizeof(capabilities.bytes),&returned)||
    !GetTokenInformation(token,TokenPrivileges,privileges.bytes,sizeof(privileges.bytes),&returned)||
    !GetTokenInformation(token,TokenGroups,groups.bytes,sizeof(groups.bytes),&returned))goto done;
  PSID integrity=((TOKEN_MANDATORY_LABEL *)label.bytes)->Label.Sid;
  PSID package=((TOKEN_APPCONTAINER_INFORMATION *)app.bytes)->TokenAppContainer;
  observedApp=isApp;observedElevation=elevation.TokenIsElevated;
  observedCapabilities=((TOKEN_GROUPS *)capabilities.bytes)->GroupCount;
  tokenFailure="token_sid_invalid";
  if(!IsValidSid(integrity)||!*GetSidSubAuthorityCount(integrity)||!IsValidSid(package))goto done;
  observedIntegrity=*GetSidSubAuthority(integrity,*GetSidSubAuthorityCount(integrity)-1);
  observedPackageMatches=!expected||EqualSid(package,expected);
  LUID notify={0};
  if(!LookupPrivilegeValueW(NULL,L"SeChangeNotifyPrivilege",&notify))goto done;
  observedUnexpectedPrivileges=observedUnexpectedEnabledPrivileges=0;
  TOKEN_PRIVILEGES *heldPrivileges=(TOKEN_PRIVILEGES *)privileges.bytes;
  for(DWORD i=0;i<heldPrivileges->PrivilegeCount;i++){
    LUID_AND_ATTRIBUTES p=heldPrivileges->Privileges[i];
    if(p.Luid.HighPart!=notify.HighPart||p.Luid.LowPart!=notify.LowPart){
      observedUnexpectedPrivileges++;
      if(p.Attributes&SE_PRIVILEGE_ENABLED)observedUnexpectedEnabledPrivileges++;
    }
  }
  union {SID alignment;BYTE bytes[SECURITY_MAX_SID_SIZE];} admin={0};DWORD adminBytes=sizeof(admin.bytes);
  if(!CreateWellKnownSid(WinBuiltinAdministratorsSid,NULL,admin.bytes,&adminBytes))goto done;
  observedAdminMode=0;
  TOKEN_GROUPS *heldGroups=(TOKEN_GROUPS *)groups.bytes;
  for(DWORD i=0;i<heldGroups->GroupCount;i++){
    if(EqualSid(heldGroups->Groups[i].Sid,admin.bytes)){
      DWORD attributes=heldGroups->Groups[i].Attributes;
      observedAdminMode=(attributes&SE_GROUP_ENABLED)?2:(attributes&SE_GROUP_USE_FOR_DENY_ONLY)?1:3;
    }
  }
  tokenFailure="not_appcontainer";if(isApp!=1)goto done;
  tokenFailure="elevated_token_inherited";if(elevation.TokenIsElevated)goto done;
  tokenFailure="integrity_above_low";if(observedIntegrity>SECURITY_MANDATORY_LOW_RID)goto done;
  tokenFailure="ambient_capabilities";if(observedCapabilities!=0)goto done;
  tokenFailure="package_sid_mismatch";if(!observedPackageMatches)goto done;
  tokenFailure="ambient_privileges";if(observedUnexpectedPrivileges!=0)goto done;
  tokenFailure="administrator_group_inherited";if(observedAdminMode>=2)goto done;
  ok=TRUE;tokenFailure="contained";
done:
  CloseHandle(token);return ok;
}
static BOOL write_fixture(const wchar_t *file,const char *contents) {
  HANDLE h=CreateFileW(file,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
  if(h==INVALID_HANDLE_VALUE)return FALSE;
  DWORD done=0;DWORD size=(DWORD)strlen(contents);
  BOOL ok=WriteFile(h,contents,size,&done,NULL)&&done==size;
  CloseHandle(h);return ok;
}
static BOOL read_fixture(const wchar_t *file,char *out,DWORD capacity,DWORD *read) {
  HANDLE h=CreateFileW(file,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
  if(h==INVALID_HANDLE_VALUE)return FALSE;
  BOOL ok=ReadFile(h,out,capacity-1,read,NULL);
  if(ok)out[*read]='\0';CloseHandle(h);return ok;
}
#ifndef NEXOWIRE_FIXED_SANDBOX_CHILD
static BOOL set_test_acl(const wchar_t *path,const wchar_t *owner,const wchar_t *app,BOOL writable) {
  wchar_t sddl[1024]={0};
  int n=app?_snwprintf_s(sddl,1024,_TRUNCATE,
    L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;%ls)(A;OICI;0x%08lx;;;%ls)",
    owner,(unsigned long)(writable?0x001301bf:0x001200a9),app):
    _snwprintf_s(sddl,1024,_TRUNCATE,L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;%ls)",owner);
  if(n<=0)return FALSE;
  PSECURITY_DESCRIPTOR sd=NULL;PACL dacl=NULL;BOOL present=FALSE,defaulted=FALSE;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,SDDL_REVISION_1,&sd,NULL))return FALSE;
  BOOL ok=GetSecurityDescriptorDacl(sd,&present,&dacl,&defaulted)&&present&&dacl&&
    SetNamedSecurityInfoW((LPWSTR)path,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,
      NULL,NULL,dacl,NULL)==ERROR_SUCCESS;
  LocalFree(sd);
  if(!ok||!writable)return ok;
  sd=NULL;PACL sacl=NULL;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)",SDDL_REVISION_1,&sd,NULL))return FALSE;
  ok=GetSecurityDescriptorSacl(sd,&present,&sacl,&defaulted)&&present&&sacl&&
    SetNamedSecurityInfoW((LPWSTR)path,SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION,NULL,NULL,NULL,sacl)==ERROR_SUCCESS;
  LocalFree(sd);return ok;
}
static BOOL empty_test_root(const wchar_t *path) {
  const wchar_t *name=wcsrchr(path,L'\\');
  const wchar_t *prefix=L"nw07-appcontainer-ci-";
  DWORD flags=GetFileAttributesW(path);
  if(!name||_wcsnicmp(name+1,prefix,wcslen(prefix))||flags==INVALID_FILE_ATTRIBUTES||
    !(flags&FILE_ATTRIBUTE_DIRECTORY)||(flags&FILE_ATTRIBUTE_REPARSE_POINT))return FALSE;
  wchar_t pattern[1200]={0};
  if(_snwprintf_s(pattern,1200,_TRUNCATE,L"%ls\\*",path)<=0)return FALSE;
  WIN32_FIND_DATAW found={0};HANDLE search=FindFirstFileW(pattern,&found);
  if(search==INVALID_HANDLE_VALUE)return GetLastError()==ERROR_FILE_NOT_FOUND;
  BOOL empty=TRUE;
  do{
    if(wcscmp(found.cFileName,L".")&&wcscmp(found.cFileName,L"..")){empty=FALSE;break;}
  }while(FindNextFileW(search,&found));
  FindClose(search);return empty;
}
static BOOL minimal_worker_environment(HANDLE token,wchar_t *out,size_t capacity) {
  /* AppContainer creation needs normal OS profile paths. Build them from the
   * token's OS environment, WITHOUT inheriting parent process variables, then
   * copy only this fixed path whitelist. Never pass the complete block. */
  LPVOID block=NULL;
  if(!CreateEnvironmentBlock(&block,token,FALSE))return FALSE;
  const wchar_t *names[]={L"APPDATA",L"LOCALAPPDATA",L"PATH",L"SystemDrive",L"SystemRoot",
    L"TEMP",L"TMP",L"USERPROFILE",L"windir"};
  size_t offset=0;BOOL ok=FALSE;wchar_t windows[1024]={0};
  if(!GetWindowsDirectoryW(windows,1024))goto done;
  for(size_t i=0;i<sizeof(names)/sizeof(names[0]);i++){
    const wchar_t *value=NULL;size_t nameLength=wcslen(names[i]);
    if(wcscmp(names[i],L"PATH")){
      for(const wchar_t *entry=(const wchar_t *)block;*entry;entry+=wcslen(entry)+1){
        if(_wcsnicmp(entry,names[i],nameLength)==0&&entry[nameLength]==L'='){
          value=entry+nameLength+1;break;
        }
      }
      if(!value||!*value){SetLastError(ERROR_ENVVAR_NOT_FOUND);goto done;}
    }
    int written=wcscmp(names[i],L"PATH")
      ?_snwprintf_s(out+offset,capacity-offset,_TRUNCATE,L"%ls=%ls",names[i],value)
      :_snwprintf_s(out+offset,capacity-offset,_TRUNCATE,L"PATH=%ls\\System32",windows);
    if(written<=0||offset+(size_t)written+2>capacity){SetLastError(ERROR_BUFFER_OVERFLOW);goto done;}
    offset+=(size_t)written+1;
  }
  out[offset]=L'\0';ok=TRUE;
done:
  {DWORD error=GetLastError();DestroyEnvironmentBlock(block);if(!ok)SetLastError(error);}
  return ok;
}
static BOOL create_private_test_desktop(const wchar_t *name,const wchar_t *owner,const wchar_t *app,
  HWINSTA *station,HDESK *desktop) {
  /* ONLY brand-new noninteractive test objects; never edit WinSta0/Default.
   * The process station is restored before launching the fixed worker. No
   * SwitchDesktop/input operation or inheritable handle is used. */
  HWINSTA original=GetProcessWindowStation();
  HDESK originalDesktop=GetThreadDesktop(GetCurrentThreadId());
  if(!original||!originalDesktop)return FALSE;
  wchar_t sddl[1024]={0};PSECURITY_DESCRIPTOR sd=NULL;
  if(_snwprintf_s(sddl,1024,_TRUNCATE,
    L"D:P(A;;GA;;;SY)(A;;GA;;;%ls)(A;;GA;;;%ls)S:(ML;;NW;;;LW)",owner,app)<=0||
    !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,SDDL_REVISION_1,&sd,NULL))return FALSE;
  SECURITY_ATTRIBUTES sa={sizeof(sa),sd,FALSE};
  *station=CreateWindowStationW(name,CWF_CREATE_ONLY,WINSTA_ALL_ACCESS,&sa);
  DWORD error=GetLastError();BOOL changed=FALSE,ok=FALSE;
  if(*station){
    if(SetProcessWindowStation(*station)){
      changed=TRUE;
      *desktop=CreateDesktopW(L"FixedWorker",NULL,NULL,0,GENERIC_ALL,&sa);
      error=GetLastError();ok=*desktop!=NULL;
    }else error=GetLastError();
  }
  if(changed&&!SetProcessWindowStation(original)){error=GetLastError();ok=FALSE;}
  if(GetThreadDesktop(GetCurrentThreadId())!=originalDesktop&&!SetThreadDesktop(originalDesktop)){
    error=GetLastError();ok=FALSE;
  }
  LocalFree(sd);if(!ok)SetLastError(error);return ok;
}
#endif
#ifdef NEXOWIRE_FIXED_SANDBOX_CHILD
static void worker_progress(const wchar_t *file,const char *step) {
  HANDLE h=CreateFileW(file,GENERIC_WRITE,FILE_SHARE_READ,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
  if(h==INVALID_HANDLE_VALUE)return;
  DWORD written=0;WriteFile(h,step,(DWORD)strlen(step),&written,NULL);CloseHandle(h);
}
static BOOL on_private_test_desktop(const wchar_t *station,const wchar_t *desktop) {
  wchar_t actualStation[256]={0},actualDesktop[256]={0};DWORD bytes=0;
  return GetUserObjectInformationW(GetProcessWindowStation(),UOI_NAME,actualStation,sizeof(actualStation),&bytes)&&
    GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()),UOI_NAME,actualDesktop,sizeof(actualDesktop),&bytes)&&
    _wcsicmp(actualStation,station)==0&&_wcsicmp(actualDesktop,desktop)==0&&_wcsicmp(actualStation,L"WinSta0")!=0;
}
static int fixed_worker(int argc,wchar_t **argv) {
  if(argc!=10||!token_is_contained(GetCurrentProcess(),NULL))return 10;
  worker_progress(argv[9],"token_verified");
  if(!on_private_test_desktop(argv[7],argv[8]))return 26;
  worker_progress(argv[9],"private_desktop_verified");
  BOOL inJob=FALSE;if(!IsProcessInJob(GetCurrentProcess(),NULL,&inJob)||!inJob)return 11;
  wchar_t leak[8]={0};
  SetLastError(ERROR_SUCCESS);
  if(GetEnvironmentVariableW(L"NEXOWIRE_SANDBOX_PARENT_SECRET",leak,8)!=0||GetLastError()!=ERROR_ENVVAR_NOT_FOUND)return 12;
  char contents[64]={0};DWORD read=0;
  if(!read_fixture(argv[2],contents,sizeof(contents),&read)||strcmp(contents,"allowed-fixture"))return 13;
  HANDLE denied=CreateFileW(argv[3],GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
  if(denied!=INVALID_HANDLE_VALUE){CloseHandle(denied);return 14;}
  if(GetLastError()!=ERROR_ACCESS_DENIED)return 15;
  worker_progress(argv[9],"file_scope_verified");
  DWORD parent=(DWORD)wcstoul(argv[4],NULL,10);
  HANDLE stolen=OpenProcess(PROCESS_DUP_HANDLE,FALSE,parent);
  if(stolen){CloseHandle(stolen);return 16;}
  if(GetLastError()!=ERROR_ACCESS_DENIED)return 17;
  worker_progress(argv[9],"parent_handle_denied");
  worker_progress(argv[9],"winsock_start");
  WSADATA wsa={0};if(WSAStartup(MAKEWORD(2,2),&wsa))return 77;
  worker_progress(argv[9],"winsock_ready");
  SOCKET socketHandle=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(socketHandle==INVALID_SOCKET){WSACleanup();return 77;}
  struct sockaddr_in address={0};address.sin_family=AF_INET;
  address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);address.sin_port=htons((u_short)wcstoul(argv[5],NULL,10));
  u_long nonblocking=1;
  if(ioctlsocket(socketHandle,FIONBIO,&nonblocking)){closesocket(socketHandle);WSACleanup();return 19;}
  worker_progress(argv[9],"network_connect");
  int connected=connect(socketHandle,(const struct sockaddr *)&address,sizeof(address));
  int networkError=connected==0?0:WSAGetLastError();
  if(connected==SOCKET_ERROR&&networkError==WSAEWOULDBLOCK){
    fd_set writeSet,errorSet;FD_ZERO(&writeSet);FD_ZERO(&errorSet);
    FD_SET(socketHandle,&writeSet);FD_SET(socketHandle,&errorSet);
    struct timeval deadline={1,0};int selected=select(0,NULL,&writeSet,&errorSet,&deadline);
    if(selected>0){int bytes=sizeof(networkError);
      if(getsockopt(socketHandle,SOL_SOCKET,SO_ERROR,(char *)&networkError,&bytes))networkError=WSAGetLastError();
      if(networkError==0)connected=0;
    }else networkError=selected==0?WSAETIMEDOUT:WSAGetLastError();
  }
  closesocket(socketHandle);WSACleanup();worker_progress(argv[9],"network_result");
  if(connected==0)return 18;
  if(networkError!=WSAEACCES)return 19;
  wchar_t exe[32768]={0},command[32768]={0};
  if(!GetModuleFileNameW(NULL,exe,32768)||
    _snwprintf_s(command,32768,_TRUNCATE,L"\"%ls\" --grandchild-fixed %ls %ls",exe,argv[7],argv[8])<=0)return 20;
  STARTUPINFOW si={0};si.cb=sizeof(si);PROCESS_INFORMATION child={0};
  worker_progress(argv[9],"breakaway_probe");
  if(CreateProcessW(exe,command,NULL,NULL,FALSE,CREATE_BREAKAWAY_FROM_JOB|CREATE_SUSPENDED|CREATE_NO_WINDOW,
    NULL,NULL,&si,&child)){
    TerminateProcess(child.hProcess,99);WaitForSingleObject(child.hProcess,3000);
    CloseHandle(child.hThread);CloseHandle(child.hProcess);return 21;
  }
  if(GetLastError()!=ERROR_ACCESS_DENIED)return 22;
  worker_progress(argv[9],"descendant_create");
  if(!CreateProcessW(exe,command,NULL,NULL,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,NULL,&si,&child))return 77;
  char pid[32]={0};
  int n=_snprintf_s(pid,sizeof(pid),_TRUNCATE,"%lu",(unsigned long)child.dwProcessId);
  if(n<=0||!write_fixture(argv[6],pid)||ResumeThread(child.hThread)==(DWORD)-1){
    TerminateProcess(child.hProcess,99);WaitForSingleObject(child.hProcess,3000);
    CloseHandle(child.hThread);CloseHandle(child.hProcess);return 23;
  }
  CloseHandle(child.hThread);CloseHandle(child.hProcess);worker_progress(argv[9],"descendant_ready");return 0;
}
#endif
int wmain(int argc,wchar_t **argv) {
#ifdef NEXOWIRE_FIXED_SANDBOX_CHILD
  if(argc>=2&&wcscmp(argv[1],L"--inside-fixed")==0){
    if(argc==10)worker_progress(argv[9],"entered_main");
    return fixed_worker(argc,argv);
  }
  if(argc==4&&wcscmp(argv[1],L"--grandchild-fixed")==0){
    BOOL member=FALSE;
    if(!token_is_contained(GetCurrentProcess(),NULL)||!IsProcessInJob(GetCurrentProcess(),NULL,&member)||!member||
      !on_private_test_desktop(argv[2],argv[3]))return 24;
    Sleep(INFINITE);return 25;
  }
  return 64;
#else
  if(argc!=3||wcscmp(argv[1],L"--selftest-only")||wcslen(argv[2])>1000||!empty_test_root(argv[2]))return 64;
  const char *stage="fixture_setup";DWORD error=0,childExit=STILL_ACTIVE,workerWait=0xffffffffUL;int result=77;
  wchar_t fixture[1200]={0},code[1200]={0},data[1200]={0},exe[1300]={0};
  wchar_t allowed[1300]={0},denied[1300]={0},pidFile[1300]={0},profile[100]={0};
  wchar_t desktopPath[160]={0};HWINSTA testStation=NULL;HDESK testDesktop=NULL;
  wchar_t progressFile[1300]={0};char workerStep[64]="not_observed";
  HANDLE token=NULL,workerToken=NULL,job=NULL,descendant=NULL;PSID appSid=NULL;
  LPWSTR ownerSid=NULL,appText=NULL;BOOL profileCreated=FALSE,descendantVerified=FALSE;
  PROCESS_INFORMATION child={0};
  LPPROC_THREAD_ATTRIBUTE_LIST attributes=NULL;BOOL attributesInitialized=FALSE;
  SOCKET listener=INVALID_SOCKET;BOOL socketsStarted=FALSE;WSADATA wsa={0};
  if(_snwprintf_s(fixture,1200,_TRUNCATE,L"%ls\\fixture",argv[2])<=0||!CreateDirectoryW(fixture,NULL))goto cleanup;
  if(_snwprintf_s(code,1200,_TRUNCATE,L"%ls\\code",fixture)<=0||
    _snwprintf_s(data,1200,_TRUNCATE,L"%ls\\data",fixture)<=0||
    !CreateDirectoryW(code,NULL)||!CreateDirectoryW(data,NULL)||
    _snwprintf_s(exe,1300,_TRUNCATE,L"%ls\\probe.exe",code)<=0||
    _snwprintf_s(allowed,1300,_TRUNCATE,L"%ls\\allowed.txt",data)<=0||
    _snwprintf_s(denied,1300,_TRUNCATE,L"%ls\\outside-canary.txt",fixture)<=0||
    _snwprintf_s(pidFile,1300,_TRUNCATE,L"%ls\\child.pid",data)<=0||
    _snwprintf_s(progressFile,1300,_TRUNCATE,L"%ls\\progress.txt",data)<=0)goto cleanup;
  union {TOKEN_USER alignment;BYTE bytes[sizeof(TOKEN_USER)+SECURITY_MAX_SID_SIZE];} user={0};DWORD returned=0;
  /* CreateRestrictedToken retains the source handle rights. ADJUST_DEFAULT is
   * needed only to lower the NEW token; ASSIGN_PRIMARY launches that new
   * token. The parent token is never adjusted. */
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY|TOKEN_DUPLICATE|TOKEN_ADJUST_DEFAULT|TOKEN_ASSIGN_PRIMARY,&token)||
    !GetTokenInformation(token,TokenUser,user.bytes,sizeof(user.bytes),&returned)||
    !ConvertSidToStringSidW(((TOKEN_USER *)user.bytes)->User.Sid,&ownerSid))goto cleanup;
  _snwprintf_s(profile,100,_TRUNCATE,L"Nexowire.Core.Probe.%lu.%llx",(unsigned long)GetCurrentProcessId(),GetTickCount64());
  stage="appcontainer_profile_create";
  HRESULT created=CreateAppContainerProfile(profile,L"Disposable CORE diagnostic",L"Fixed CI payload only",NULL,0,&appSid);
  if(FAILED(created)){error=(DWORD)created;goto cleanup;}
  profileCreated=TRUE;
  if(!ConvertSidToStringSidW(appSid,&appText))goto cleanup;
  stage="fixture_acl";
  if(!set_test_acl(argv[2],ownerSid,appText,FALSE)||!set_test_acl(fixture,ownerSid,appText,FALSE)||
    !set_test_acl(code,ownerSid,appText,FALSE)||!set_test_acl(data,ownerSid,appText,TRUE))goto cleanup;
  /* Fixed separately compiled payload: no AppContainer/profile-creation or
   * userenv initialization code is loaded inside the restricted process. */
  wchar_t self[32768]={0};
  if(!GetModuleFileNameW(NULL,self,32768))goto cleanup;
  wchar_t *separator=wcsrchr(self,L'\\');if(!separator)goto cleanup;separator[1]=L'\0';
  if(wcscat_s(self,32768,L"task-os-sandbox-windows-appcontainer-fixed-p07.exe")||
    !CopyFileW(self,exe,TRUE)||!set_test_acl(exe,ownerSid,appText,FALSE)||
    !write_fixture(allowed,"allowed-fixture")||!write_fixture(denied,"outside-canary")||
    !set_test_acl(denied,ownerSid,NULL,FALSE))goto cleanup;
  stage="private_test_desktop_create";
  if(!create_private_test_desktop(profile,ownerSid,appText,&testStation,&testDesktop)||
    _snwprintf_s(desktopPath,160,_TRUNCATE,L"%ls\\FixedWorker",profile)<=0)goto cleanup;
  stage="loopback_positive_control";
  if(WSAStartup(MAKEWORD(2,2),&wsa)){error=(DWORD)WSAGetLastError();goto cleanup;}
  socketsStarted=TRUE;listener=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  struct sockaddr_in address={0};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  if(listener==INVALID_SOCKET||bind(listener,(struct sockaddr *)&address,sizeof(address))||listen(listener,4))goto cleanup;
  int addressSize=sizeof(address);if(getsockname(listener,(struct sockaddr *)&address,&addressSize))goto cleanup;
  SOCKET control=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(control==INVALID_SOCKET)goto cleanup;
  int positive=connect(control,(struct sockaddr *)&address,sizeof(address));closesocket(control);
  if(positive!=0)goto cleanup;
  stage="job_setup";
  job=CreateJobObjectW(NULL,NULL);JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};
  limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit=4;
  if(!job||!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))goto cleanup;
  SIZE_T size=0;InitializeProcThreadAttributeList(NULL,1,0,&size);
  attributes=(LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,size);
  if(!attributes||!InitializeProcThreadAttributeList(attributes,1,0,&size))goto cleanup;
  attributesInitialized=TRUE;
  SECURITY_CAPABILITIES capabilities={0};capabilities.AppContainerSid=appSid;
  if(!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    &capabilities,sizeof(capabilities),NULL,NULL))goto cleanup;
  STARTUPINFOEXW start={0};start.StartupInfo.cb=sizeof(start);start.lpAttributeList=attributes;
  start.StartupInfo.lpDesktop=desktopPath;
  wchar_t command[8192]={0},environment[16384]={0};
  stage="minimal_os_profile_environment";
  if(!SetEnvironmentVariableW(L"NEXOWIRE_SANDBOX_PARENT_SECRET",L"ci-parent-only-not-a-real-secret"))goto cleanup;
  if(!minimal_worker_environment(token,environment,sizeof(environment)/sizeof(environment[0])))goto cleanup;
  if(_snwprintf_s(command,8192,_TRUNCATE,L"\"%ls\" --inside-fixed \"%ls\" \"%ls\" %lu %u \"%ls\" %ls FixedWorker \"%ls\"",
    exe,allowed,denied,(unsigned long)GetCurrentProcessId(),(unsigned)ntohs(address.sin_port),pidFile,profile,progressFile)<=0)goto cleanup;
  workerToken=restricted_worker_token(token,&stage);
  if(!workerToken)goto cleanup;
  stage="restricted_worker_default_dacl";
  if(!set_worker_default_dacl(workerToken,ownerSid,appText,((TOKEN_USER *)user.bytes)->User.Sid))goto cleanup;
  stage="suspended_appcontainer_create";
  if(!CreateProcessAsUserW(workerToken,exe,command,NULL,NULL,FALSE,EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|
    CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,environment,data,&start.StartupInfo,&child))goto cleanup;
  stage="nested_job_assignment";
  if(!AssignProcessToJobObject(job,child.hProcess))goto cleanup;
  BOOL member=FALSE;
  stage="independent_suspended_token_readback";
  if(!token_is_contained(child.hProcess,appSid)||!IsProcessInJob(child.hProcess,job,&member)||!member){result=1;goto cleanup;}
  if(ResumeThread(child.hThread)==(DWORD)-1)goto cleanup;
  stage="fixed_worker_negatives";
  workerWait=WaitForSingleObject(child.hProcess,20000);
  if(!GetExitCodeProcess(child.hProcess,&childExit)||workerWait!=WAIT_OBJECT_0){result=1;goto cleanup;}
  if(childExit!=0){result=childExit==77?77:1;goto cleanup;}
  char pid[32]={0};DWORD read=0;
  if(!read_fixture(pidFile,pid,sizeof(pid),&read)){result=1;goto cleanup;}
  DWORD childPid=(DWORD)strtoul(pid,NULL,10);
  if(!childPid){result=1;goto cleanup;}
  descendant=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE|PROCESS_TERMINATE,FALSE,childPid);
  stage="independent_descendant_readback";
  if(!descendant||!token_is_contained(descendant,appSid)||!IsProcessInJob(descendant,job,&member)||!member){result=1;goto cleanup;}
  union {JOBOBJECT_BASIC_PROCESS_ID_LIST alignment;BYTE bytes[sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST)+sizeof(ULONG_PTR)*4];} list={0};
  if(!QueryInformationJobObject(job,JobObjectBasicProcessIdList,list.bytes,sizeof(list.bytes),NULL)){result=1;goto cleanup;}
  JOBOBJECT_BASIC_PROCESS_ID_LIST *pids=(JOBOBJECT_BASIC_PROCESS_ID_LIST *)list.bytes;
  if(pids->NumberOfProcessIdsInList!=1||pids->ProcessIdList[0]!=(ULONG_PTR)childPid){result=1;goto cleanup;}
  descendantVerified=TRUE;
  stage="job_close_and_kernel_drain";
  CloseHandle(job);job=NULL;
  if(WaitForSingleObject(descendant,5000)!=WAIT_OBJECT_0){result=1;goto cleanup;}
  char canary[64]={0};
  if(!read_fixture(denied,canary,sizeof(canary),&read)||strcmp(canary,"outside-canary")){result=1;goto cleanup;}
  result=0;
cleanup:
  if(!error&&result!=0)error=GetLastError();
  if(job){TerminateJobObject(job,99);CloseHandle(job);}
  if(child.hProcess){
    if(WaitForSingleObject(child.hProcess,0)!=WAIT_OBJECT_0)TerminateProcess(child.hProcess,99);
    WaitForSingleObject(child.hProcess,5000);CloseHandle(child.hProcess);
  }
  if(child.hThread)CloseHandle(child.hThread);
  if(descendant){
    if(descendantVerified&&WaitForSingleObject(descendant,0)!=WAIT_OBJECT_0){
      TerminateProcess(descendant,99);WaitForSingleObject(descendant,5000);
    }
    CloseHandle(descendant);
  }
  if(attributesInitialized)DeleteProcThreadAttributeList(attributes);
  if(attributes)HeapFree(GetProcessHeap(),0,attributes);
  if(listener!=INVALID_SOCKET)closesocket(listener);if(socketsStarted)WSACleanup();
  if(workerToken)CloseHandle(workerToken);
  if(progressFile[0]){
    char observed[64]={0};DWORD count=0;
    if(read_fixture(progressFile,observed,sizeof(observed),&count)&&count>0&&count<sizeof(observed)){
      BOOL safe=TRUE;for(DWORD i=0;i<count;i++)if((observed[i]<'a'||observed[i]>'z')&&observed[i]!='_')safe=FALSE;
      if(safe)strcpy_s(workerStep,sizeof(workerStep),observed);
    }
  }
  if(testDesktop&&!CloseDesktop(testDesktop)){result=1;stage="private_desktop_cleanup_failed";error=GetLastError();}
  if(testStation&&!CloseWindowStation(testStation)){result=1;stage="private_station_cleanup_failed";error=GetLastError();}
  if(token)CloseHandle(token);if(ownerSid)LocalFree(ownerSid);if(appText)LocalFree(appText);
  if(appSid)FreeSid(appSid);
  if(profileCreated){HRESULT deleted=DeleteAppContainerProfile(profile);if(FAILED(deleted)){result=1;stage="profile_cleanup_failed";error=(DWORD)deleted;}}
  printf("{\"version\":1,\"kind\":\"windows_appcontainer_fixed_probe_v1\",\"state\":\"%s\","
    "\"stage\":\"%s\",\"win32Error\":%lu,\"workerExit\":%lu,"
    "\"tokenFailure\":\"%s\",\"tokenAppContainer\":%lu,\"tokenElevated\":%lu,"
    "\"integrityRid\":%lu,\"capabilityCount\":%lu,\"packageMatches\":%s,"
    "\"unexpectedPrivileges\":%lu,\"unexpectedEnabledPrivileges\":%lu,\"adminGroupMode\":%lu,"
    "\"privateDesktopObserved\":%s,"
    "\"initialDefaultUserAccess\":%s,\"configuredDefaultUserAccess\":%s,"
    "\"workerStep\":\"%s\",\"workerWait\":%lu,"
    "\"coreAuthority\":false,\"productionWorkerInstalled\":false,\"physicalAcceptance\":\"NOT_PROVEN\"}\n",
    result==0?"OBSERVED":result==77?"UNAVAILABLE":"FAILED",stage,(unsigned long)error,(unsigned long)childExit,
    tokenFailure,(unsigned long)observedApp,(unsigned long)observedElevation,
    (unsigned long)observedIntegrity,(unsigned long)observedCapabilities,observedPackageMatches?"true":"false",
    (unsigned long)observedUnexpectedPrivileges,(unsigned long)observedUnexpectedEnabledPrivileges,
    (unsigned long)observedAdminMode,result==0?"true":"false",
    initialDefaultUserAccess?"true":"false",configuredDefaultUserAccess?"true":"false",
    workerStep,(unsigned long)workerWait);
  return result;
#endif
}
