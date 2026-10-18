// Nexowire Windows Job Object owner. Build as a console subsystem EXE.
// No native process is resumed unless its Job assignment is proven.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <wchar.h>

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
  if(!argv || argc<9 || wcscmp(argv[1],L"--status") ||
     wcscmp(argv[3],L"--cwd") || wcscmp(argv[5],L"--parent") ||
     wcscmp(argv[7],L"--")){
    fwprintf(stderr,L"NEXOWIRE_WINJOB_ERROR invalid_arguments\n");
    return 64;
  }
  const wchar_t *statusPath=argv[2];
  const wchar_t *cwd=wcscmp(argv[4],L"-")==0?NULL:argv[4];
  if(!statusPath[0]||!argv[8][0])return 64;
  wchar_t *parentEnd=NULL;
  unsigned long parentPid=wcstoul(argv[6],&parentEnd,10);
  if(!argv[6][0]||*parentEnd)return 64;
  // Guardian's handle to volatile parent prevents PID reuse while it lives.
  // Durable workers pass 0: their Job must survive Agent disconnection.
  HANDLE parent=parentPid?OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,
    FALSE,parentPid):NULL;
  if(parentPid&&!parent){diagnostic(L"parent_open");return 70;}
  size_t total=1;
  for(int i=8;i<argc;i++)total+=wcslen(argv[i])*2+4;
  if(total>32760){fwprintf(stderr,L"NEXOWIRE_WINJOB_ERROR command_too_long\n");return 64;}
  wchar_t *cmd=(wchar_t*)calloc(total,sizeof(wchar_t));
  if(!cmd)return 70;
  wchar_t *out=cmd; const wchar_t *end=cmd+total-1;
  for(int i=8;i<argc;i++){
    if(i>8){if(out>=end){free(cmd);return 64;}*out++=L' ';}
    if(!quote_arg(argv[i],&out,end)){free(cmd);return 64;}
  }
  *out=0;

  HANDLE job=CreateJobObjectW(NULL,NULL);
  if(!job){diagnostic(L"create_job");free(cmd);return 70;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit={0};
  limit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,
       &limit,sizeof(limit))){
    diagnostic(L"set_limit");CloseHandle(job);free(cmd);return 70;
  }
  STARTUPINFOW si={0};si.cb=sizeof(si);
  si.dwFlags=STARTF_USESTDHANDLES;
  si.hStdInput=GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError=GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION pi={0};
  // Inherited stdout/stderr/stdin are Node's pipes to this helper.
  BOOL created=CreateProcessW(NULL,cmd,NULL,NULL,TRUE,
    CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,cwd,&si,&pi);
  free(cmd);
  if(!created){diagnostic(L"create_process");CloseHandle(job);return 70;}
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
  int length=swprintf(message,128,L"NWJOB3 %lu %llu\n",pi.dwProcessId,ticks);
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
      // Parent crashed/disconnected permanently: close the sole Job handle.
      // Only the already assigned process set is terminated.
      CloseHandle(job);CloseHandle(pi.hProcess);CloseHandle(parent);return 78;
    }
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting={0};
    if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,
           &accounting,sizeof(accounting),NULL)){
      diagnostic(L"job_accounting");CloseHandle(job);return 77;
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
