// Hostile nested-Job fixture: all child PIDs are created HERE, never found
// or terminated by process name. The outer Job owns only its synthetic helper.
// ActiveProcessLimit=1 forces fail-closed when the nested helper tries to
// create a root while the outer Job already contains the helper itself.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

int main(void) {
  HANDLE outer=CreateJobObjectW(NULL,NULL);
  if(!outer){puts("NX_TEST_OUTER_CREATE_FAILED");return 80;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};
  limits.BasicLimitInformation.LimitFlags =
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  limits.BasicLimitInformation.ActiveProcessLimit=1;
  if(!SetInformationJobObject(outer,JobObjectExtendedLimitInformation,
      &limits,sizeof(limits))){
    puts("NX_TEST_OUTER_LIMIT_DENIED");CloseHandle(outer);return 81;
  }
  wchar_t cwd[MAX_PATH+1]={0},sys[MAX_PATH+1]={0},tmp[MAX_PATH+1]={0};
  DWORD n=GetCurrentDirectoryW(MAX_PATH,cwd);
  DWORD sn=GetSystemDirectoryW(sys,MAX_PATH);
  DWORD tn=GetTempPathW(MAX_PATH,tmp);
  if(!n||n>=MAX_PATH-70||!sn||sn>=MAX_PATH-12||!tn||tn>=MAX_PATH-110){
    CloseHandle(outer);return 82;
  }
  wchar_t helper[MAX_PATH+1]={0},cmd[MAX_PATH+1]={0};
  swprintf(helper,MAX_PATH+1,L"%ls\\native\\windows-job-owner.exe",cwd);
  swprintf(cmd,MAX_PATH+1,L"%ls\\cmd.exe",sys);
  wchar_t marker[MAX_PATH+1]={0},release[MAX_PATH+1]={0};
  swprintf(marker,MAX_PATH+1,L"%lsnxhostile-%lu-%llu.status",tmp,
    GetCurrentProcessId(),(unsigned long long)GetTickCount64());
  swprintf(release,MAX_PATH+1,L"%lsnxhostile-%lu-%llu.gate",tmp,
    GetCurrentProcessId(),(unsigned long long)GetTickCount64());
  wchar_t command[32760]={0};
  swprintf(command,32760,L"\"%ls\" --status \"%ls\" --cwd - --parent 0"
    L" --release \"%ls\" -- \"%ls\" /D /S /C \"exit /b 0\"",
    helper,marker,release,cmd);
  STARTUPINFOW si={0};si.cb=sizeof(si);
  PROCESS_INFORMATION pi={0};
  if(!CreateProcessW(helper,command,NULL,NULL,FALSE,
    CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,cwd,&si,&pi)){
    CloseHandle(outer);puts("NX_TEST_GUARD_SPAWN_FAILED");return 83;
  }
  if(!AssignProcessToJobObject(outer,pi.hProcess)){
    // The helper is still suspended; terminate only this newly created PID.
    TerminateProcess(pi.hProcess,84);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);
    CloseHandle(outer);
    puts("NX_TEST_NESTED_HOST_UNSUPPORTED");return 84;
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  DWORD waited=WaitForSingleObject(pi.hProcess,10000),ec=0;
  if(waited==WAIT_TIMEOUT){
    TerminateJobObject(outer,85); // only this synthetic outer Job
    CloseHandle(pi.hProcess);CloseHandle(outer);
    puts("NX_TEST_NESTED_GUARD_TIMEOUT");return 85;
  }
  if(waited!=WAIT_OBJECT_0||!GetExitCodeProcess(pi.hProcess,&ec)){
    TerminateJobObject(outer,86);
    CloseHandle(pi.hProcess);CloseHandle(outer);return 86;
  }
  CloseHandle(pi.hProcess);
  DWORD attribute=GetFileAttributesW(marker);
  BOOL markerExists=attribute!=INVALID_FILE_ATTRIBUTES;
  TerminateJobObject(outer,87); // only synthetic own-job members
  CloseHandle(outer);
  // Status file would mean the root was published despite parent quota.
  if(markerExists){DeleteFileW(marker);puts("NX_HOSTILE_NESTED_UNEXPECTED_ROOT");return 42;}
  if(ec==0){puts("NX_HOSTILE_NESTED_HELPER_FALSE_SUCCESS");return 43;}
  puts("NX_HOSTILE_NESTED_FAIL_CLOSED");
  return 0;
}
