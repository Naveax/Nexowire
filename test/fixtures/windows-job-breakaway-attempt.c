// Source-built test fixture ONLY. It never targets an existing PID.
// If breakaway succeeds unexpectedly, the synthetic child remains suspended
// and is immediately terminated by its own PROCESS_INFORMATION handle.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

int main(void) {
  wchar_t cmd[MAX_PATH+1]={0};
  unsigned int length=GetSystemDirectoryW(cmd, MAX_PATH);
  if(!length || length>=MAX_PATH-16) return 80;
  wcscat_s(cmd, MAX_PATH+1, L"\\cmd.exe");
  STARTUPINFOW si={0};
  si.cb=sizeof(si);
  PROCESS_INFORMATION pi={0};
  wchar_t args[]=L"cmd.exe /D /S /C exit /b 0";
  BOOL launched=CreateProcessW(cmd,args,NULL,NULL,FALSE,
     CREATE_BREAKAWAY_FROM_JOB|CREATE_SUSPENDED|CREATE_NO_WINDOW,
     NULL,NULL,&si,&pi);
  if(launched){
    // Only terminate the newly CREATED SUSPENDED test child.
    TerminateProcess(pi.hProcess,42);
    WaitForSingleObject(pi.hProcess,2000);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    printf("NW_BREAKAWAY_UNEXPECTED_ALLOWED\n");
    return 42;
  }
  DWORD error=GetLastError();
  printf("NW_BREAKAWAY_DENIED %lu\n",error);
  return (error==ERROR_ACCESS_DENIED||error==ERROR_INVALID_PARAMETER)?0:41;
}
