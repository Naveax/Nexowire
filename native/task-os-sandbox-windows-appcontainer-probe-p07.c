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

static BOOL token_is_contained(HANDLE process,PSID expected) {
  HANDLE token=NULL;DWORD returned=0,isApp=0;
  TOKEN_ELEVATION elevation={0};BOOL ok=FALSE;
  union {TOKEN_MANDATORY_LABEL alignment;BYTE bytes[sizeof(TOKEN_MANDATORY_LABEL)+SECURITY_MAX_SID_SIZE];} label={0};
  union {TOKEN_APPCONTAINER_INFORMATION alignment;BYTE bytes[sizeof(TOKEN_APPCONTAINER_INFORMATION)+SECURITY_MAX_SID_SIZE];} app={0};
  union {TOKEN_GROUPS alignment;BYTE bytes[4096];} capabilities={0};
  if(!OpenProcessToken(process,TOKEN_QUERY,&token))return FALSE;
  if(!GetTokenInformation(token,TokenIsAppContainer,&isApp,sizeof(isApp),&returned)||isApp!=1||
    !GetTokenInformation(token,TokenElevation,&elevation,sizeof(elevation),&returned)||elevation.TokenIsElevated||
    !GetTokenInformation(token,TokenIntegrityLevel,label.bytes,sizeof(label.bytes),&returned)||
    !GetTokenInformation(token,TokenAppContainerSid,app.bytes,sizeof(app.bytes),&returned)||
    !GetTokenInformation(token,TokenCapabilities,capabilities.bytes,sizeof(capabilities.bytes),&returned))goto done;
  PSID integrity=((TOKEN_MANDATORY_LABEL *)label.bytes)->Label.Sid;
  PSID package=((TOKEN_APPCONTAINER_INFORMATION *)app.bytes)->TokenAppContainer;
  if(!IsValidSid(integrity)||!*GetSidSubAuthorityCount(integrity)||!IsValidSid(package)||
    *GetSidSubAuthority(integrity,*GetSidSubAuthorityCount(integrity)-1)>SECURITY_MANDATORY_LOW_RID||
    ((TOKEN_GROUPS *)capabilities.bytes)->GroupCount!=0||(expected&&!EqualSid(package,expected)))goto done;
  ok=TRUE;
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
static int fixed_worker(int argc,wchar_t **argv) {
  if(argc!=7||!token_is_contained(GetCurrentProcess(),NULL))return 10;
  BOOL inJob=FALSE;if(!IsProcessInJob(GetCurrentProcess(),NULL,&inJob)||!inJob)return 11;
  wchar_t leak[8]={0};
  if(GetEnvironmentVariableW(L"NEXOWIRE_SANDBOX_PARENT_SECRET",leak,8)!=0)return 12;
  char contents[64]={0};DWORD read=0;
  if(!read_fixture(argv[2],contents,sizeof(contents),&read)||strcmp(contents,"allowed-fixture"))return 13;
  HANDLE denied=CreateFileW(argv[3],GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
  if(denied!=INVALID_HANDLE_VALUE){CloseHandle(denied);return 14;}
  if(GetLastError()!=ERROR_ACCESS_DENIED)return 15;
  DWORD parent=(DWORD)wcstoul(argv[4],NULL,10);
  HANDLE stolen=OpenProcess(PROCESS_DUP_HANDLE,FALSE,parent);
  if(stolen){CloseHandle(stolen);return 16;}
  if(GetLastError()!=ERROR_ACCESS_DENIED)return 17;
  WSADATA wsa={0};if(WSAStartup(MAKEWORD(2,2),&wsa))return 77;
  SOCKET socketHandle=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(socketHandle==INVALID_SOCKET){WSACleanup();return 77;}
  struct sockaddr_in address={0};address.sin_family=AF_INET;
  address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);address.sin_port=htons((u_short)wcstoul(argv[5],NULL,10));
  int connected=connect(socketHandle,(const struct sockaddr *)&address,sizeof(address));
  int networkError=WSAGetLastError();closesocket(socketHandle);WSACleanup();
  if(connected==0)return 18;
  if(networkError!=WSAEACCES)return 19;
  wchar_t exe[32768]={0},command[32768]={0};
  if(!GetModuleFileNameW(NULL,exe,32768)||
    _snwprintf_s(command,32768,_TRUNCATE,L"\"%ls\" --grandchild-fixed",exe)<=0)return 20;
  STARTUPINFOW si={0};si.cb=sizeof(si);PROCESS_INFORMATION child={0};
  if(CreateProcessW(exe,command,NULL,NULL,FALSE,CREATE_BREAKAWAY_FROM_JOB|CREATE_SUSPENDED|CREATE_NO_WINDOW,
    NULL,NULL,&si,&child)){
    TerminateProcess(child.hProcess,99);WaitForSingleObject(child.hProcess,3000);
    CloseHandle(child.hThread);CloseHandle(child.hProcess);return 21;
  }
  if(GetLastError()!=ERROR_ACCESS_DENIED)return 22;
  if(!CreateProcessW(exe,command,NULL,NULL,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,NULL,&si,&child))return 77;
  char pid[32]={0};
  int n=_snprintf_s(pid,sizeof(pid),_TRUNCATE,"%lu",(unsigned long)child.dwProcessId);
  if(n<=0||!write_fixture(argv[6],pid)||ResumeThread(child.hThread)==(DWORD)-1){
    TerminateProcess(child.hProcess,99);WaitForSingleObject(child.hProcess,3000);
    CloseHandle(child.hThread);CloseHandle(child.hProcess);return 23;
  }
  CloseHandle(child.hThread);CloseHandle(child.hProcess);return 0;
}
int wmain(int argc,wchar_t **argv) {
  if(argc>=2&&wcscmp(argv[1],L"--inside-fixed")==0)return fixed_worker(argc,argv);
  if(argc==2&&wcscmp(argv[1],L"--grandchild-fixed")==0){
    BOOL member=FALSE;
    if(!token_is_contained(GetCurrentProcess(),NULL)||!IsProcessInJob(GetCurrentProcess(),NULL,&member)||!member)return 24;
    Sleep(INFINITE);return 25;
  }
  if(argc!=3||wcscmp(argv[1],L"--selftest-only")||wcslen(argv[2])>1000||!empty_test_root(argv[2]))return 64;
  const char *stage="fixture_setup";DWORD error=0,childExit=STILL_ACTIVE;int result=77;
  wchar_t fixture[1200]={0},code[1200]={0},data[1200]={0},exe[1300]={0};
  wchar_t allowed[1300]={0},denied[1300]={0},pidFile[1300]={0},profile[100]={0};
  HANDLE token=NULL,job=NULL,descendant=NULL;PSID appSid=NULL;
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
    _snwprintf_s(pidFile,1300,_TRUNCATE,L"%ls\\child.pid",data)<=0)goto cleanup;
  union {TOKEN_USER alignment;BYTE bytes[sizeof(TOKEN_USER)+SECURITY_MAX_SID_SIZE];} user={0};DWORD returned=0;
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)||
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
  wchar_t self[32768]={0};
  if(!GetModuleFileNameW(NULL,self,32768)||!CopyFileW(self,exe,TRUE)||!set_test_acl(exe,ownerSid,appText,FALSE)||
    !write_fixture(allowed,"allowed-fixture")||!write_fixture(denied,"outside-canary")||
    !set_test_acl(denied,ownerSid,NULL,FALSE))goto cleanup;
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
  wchar_t command[8192]={0},windows[1024]={0},environment[4096]={0};
  if(!GetWindowsDirectoryW(windows,1024))goto cleanup;
  int length=_snwprintf_s(environment,4096,_TRUNCATE,L"PATH=%ls\\System32",windows);
  if(length<=0)goto cleanup;
  int second=_snwprintf_s(environment+length+1,4096-(size_t)length-1,_TRUNCATE,L"SystemRoot=%ls",windows);
  if(second<=0)goto cleanup;
  environment[length+1+second+1]=L'\0';
  if(!SetEnvironmentVariableW(L"NEXOWIRE_SANDBOX_PARENT_SECRET",L"ci-parent-only-not-a-real-secret")||
    _snwprintf_s(command,8192,_TRUNCATE,L"\"%ls\" --inside-fixed \"%ls\" \"%ls\" %lu %u \"%ls\"",
    exe,allowed,denied,(unsigned long)GetCurrentProcessId(),(unsigned)ntohs(address.sin_port),pidFile)<=0)goto cleanup;
  stage="suspended_appcontainer_create";
  if(!CreateProcessW(exe,command,NULL,NULL,FALSE,EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|
    CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,environment,data,&start.StartupInfo,&child))goto cleanup;
  stage="nested_job_assignment";
  if(!AssignProcessToJobObject(job,child.hProcess))goto cleanup;
  BOOL member=FALSE;
  stage="independent_suspended_token_readback";
  if(!token_is_contained(child.hProcess,appSid)||!IsProcessInJob(child.hProcess,job,&member)||!member){result=1;goto cleanup;}
  if(ResumeThread(child.hThread)==(DWORD)-1)goto cleanup;
  stage="fixed_worker_negatives";
  if(WaitForSingleObject(child.hProcess,20000)!=WAIT_OBJECT_0||!GetExitCodeProcess(child.hProcess,&childExit)){result=1;goto cleanup;}
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
  if(token)CloseHandle(token);if(ownerSid)LocalFree(ownerSid);if(appText)LocalFree(appText);
  if(appSid)FreeSid(appSid);
  if(profileCreated){HRESULT deleted=DeleteAppContainerProfile(profile);if(FAILED(deleted)){result=1;stage="profile_cleanup_failed";error=(DWORD)deleted;}}
  printf("{\"version\":1,\"kind\":\"windows_appcontainer_fixed_probe_v1\",\"state\":\"%s\","
    "\"stage\":\"%s\",\"win32Error\":%lu,\"workerExit\":%lu,"
    "\"coreAuthority\":false,\"productionWorkerInstalled\":false,\"physicalAcceptance\":\"NOT_PROVEN\"}\n",
    result==0?"OBSERVED":result==77?"UNAVAILABLE":"FAILED",stage,(unsigned long)error,(unsigned long)childExit);
  return result;
}
