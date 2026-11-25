/* Fixed-purpose SYSTEM owner ceremony launcher. No shell, no arbitrary
 * executable, no UAC elevation. Only a preinstalled, pinned WebAuthn helper
 * is started under the existing non-elevated active console owner's token.
 * Its stdout assertion comes over a local, process-authenticated named pipe.
 * Job ownership covers this ceremony ONLY, not arbitrary CORE OS effects. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <wtsapi32.h>
#include <sddl.h>
#include <bcrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <wincrypt.h>
#include <stdio.h>
#include <stdint.h>
#include <wchar.h>
#include <string.h>

static int digit(wchar_t c){
  if(c>=L'0'&&c<=L'9')return (int)(c-L'0');
  if(c>=L'a'&&c<=L'f')return (int)(c-L'a'+10);
  return -1;
}
static BOOL hex(const wchar_t *s,BYTE *out,size_t n){
  if(wcslen(s)!=n*2)return FALSE;
  for(size_t i=0;i<n;i++){
    int a=digit(s[i*2]),b=digit(s[i*2+1]);if(a<0||b<0)return FALSE;
    out[i]=(BYTE)((a<<4)|b);
  }return TRUE;
}
static BOOL hex_credential(const wchar_t *s){
  size_t n=wcslen(s);if(n<2||n>2048||n%2)return FALSE;
  for(size_t i=0;i<n;i++)if(digit(s[i])<0)return FALSE;
  return TRUE;
}
static BOOL valid_rp(const wchar_t *s){
  size_t n=wcslen(s),label=0;BOOL dot=FALSE;
  if(n<3||n>253)return FALSE;
  for(size_t i=0;i<n;i++){
    wchar_t c=s[i];
    if(c==L'.'){if(!label||label>63||s[i-1]==L'-')return FALSE;label=0;dot=TRUE;}
    else{if(!((c>=L'a'&&c<=L'z')||(c>=L'0'&&c<=L'9')||c==L'-')||(!label&&c==L'-'))return FALSE;label++;}
  }return dot&&label>0&&label<=63&&s[n-1]!=L'-';
}
static BOOL session_id(const wchar_t *s,DWORD *out){
  size_t n=wcslen(s);uint64_t v=0;if(!n||n>10||s[0]==L'0')return FALSE;
  for(size_t i=0;i<n;i++){if(s[i]<L'0'||s[i]>L'9')return FALSE;v=v*10+(uint64_t)(s[i]-L'0');}
  if(!v||v>=0xffffffffULL)return FALSE;*out=(DWORD)v;return TRUE;
}
static BOOL equal_luid(LUID a,LUID b){return a.LowPart==b.LowPart&&a.HighPart==b.HighPart;}
static BOOL luid_arg(const wchar_t *s,LUID *out){
  BYTE raw[8];uint64_t v=0;if(!hex(s,raw,8))return FALSE;
  for(size_t i=0;i<8;i++)v=(v<<8)|raw[i];
  if(!v)return FALSE;out->LowPart=(DWORD)v;out->HighPart=(LONG)(DWORD)(v>>32);return TRUE;
}
static BOOL system_primary(void){
  HANDLE t=NULL,thread=NULL;DWORD n=0,session=1;TOKEN_STATISTICS stats={0};
  union {TOKEN_USER align;BYTE data[sizeof(TOKEN_USER)+SECURITY_MAX_SID_SIZE];} u={0};
  if(OpenThreadToken(GetCurrentThread(),TOKEN_QUERY,TRUE,&thread)){CloseHandle(thread);return FALSE;}
  if(GetLastError()!=ERROR_NO_TOKEN||!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&t))return FALSE;
  BOOL ok=GetTokenInformation(t,TokenUser,u.data,sizeof(u.data),&n)&&
    IsWellKnownSid(((TOKEN_USER *)u.data)->User.Sid,WinLocalSystemSid)&&
    GetTokenInformation(t,TokenSessionId,&session,sizeof(session),&n)&&session==0&&
    GetTokenInformation(t,TokenStatistics,&stats,sizeof(stats),&n)&&stats.TokenType==TokenPrimary;
  CloseHandle(t);return ok;
}
static BOOL local_console(DWORD session){
  LPWSTR raw=NULL;DWORD n=0;BOOL ok=FALSE;
  if(WTSGetActiveConsoleSessionId()!=session)return FALSE;
  if(!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,session,WTSConnectState,&raw,&n))return FALSE;
  ok=raw&&n==sizeof(WTS_CONNECTSTATE_CLASS)&&*(WTS_CONNECTSTATE_CLASS *)raw==WTSActive;
  if(raw)WTSFreeMemory(raw);raw=NULL;n=0;
  if(!ok||!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,session,WTSClientProtocolType,&raw,&n))return FALSE;
  ok=raw&&n==sizeof(USHORT)&&*(USHORT *)raw==0;
  if(raw)WTSFreeMemory(raw);return ok;
}
static BOOL owner_token(HANDLE t,PSID expected,DWORD session,LUID logon){
  DWORD n=0,tokenSession=0;TOKEN_STATISTICS s={0};TOKEN_ELEVATION elev={0};
  union {TOKEN_USER align;BYTE data[sizeof(TOKEN_USER)+SECURITY_MAX_SID_SIZE];} u={0};
  union {TOKEN_MANDATORY_LABEL align;BYTE data[sizeof(TOKEN_MANDATORY_LABEL)+SECURITY_MAX_SID_SIZE];} m={0};
  if(!GetTokenInformation(t,TokenStatistics,&s,sizeof(s),&n)||s.TokenType!=TokenPrimary||
    !equal_luid(s.AuthenticationId,logon)||
    !GetTokenInformation(t,TokenSessionId,&tokenSession,sizeof(tokenSession),&n)||tokenSession!=session||
    !GetTokenInformation(t,TokenUser,u.data,sizeof(u.data),&n)||
    !EqualSid(((TOKEN_USER *)u.data)->User.Sid,expected)||
    !GetTokenInformation(t,TokenElevation,&elev,sizeof(elev),&n)||elev.TokenIsElevated||
    !GetTokenInformation(t,TokenIntegrityLevel,m.data,sizeof(m.data),&n))return FALSE;
  PSID sid=((TOKEN_MANDATORY_LABEL *)m.data)->Label.Sid;
  if(!IsValidSid(sid)||!*GetSidSubAuthorityCount(sid))return FALSE;
  DWORD rid=*GetSidSubAuthority(sid,*GetSidSubAuthorityCount(sid)-1);
  return rid>=SECURITY_MANDATORY_MEDIUM_RID&&rid<SECURITY_MANDATORY_HIGH_RID;
}
/* Exact held file, not a string-only hash check. Refuse reparse points,
 * multiple links and write/delete sharing until child has exited. */
static BOOL sha256_file(HANDLE f,const BYTE expected[32]){
  BCRYPT_ALG_HANDLE alg=NULL;BCRYPT_HASH_HANDLE hash=NULL;BYTE digest[32],buf[16384];
  BYTE *object=NULL;DWORD len=0,cb=0,got=0;BOOL ok=FALSE;
  LARGE_INTEGER size={0},zero={0};
  if(!GetFileSizeEx(f,&size)||size.QuadPart<1||size.QuadPart>8*1024*1024||
    !SetFilePointerEx(f,zero,NULL,FILE_BEGIN))goto done;
  if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,NULL,0)!=0||
    BCryptGetProperty(alg,BCRYPT_OBJECT_LENGTH,(PUCHAR)&len,sizeof(len),&cb,0)!=0||!len)goto done;
  object=(BYTE *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,len);if(!object)goto done;
  if(BCryptCreateHash(alg,&hash,object,len,NULL,0,0)!=0)goto done;
  for(;;){
    if(!ReadFile(f,buf,sizeof(buf),&got,NULL))goto done;
    if(!got)break;if(BCryptHashData(hash,buf,got,0)!=0)goto done;
  }
  if(BCryptFinishHash(hash,digest,sizeof(digest),0)==0&&memcmp(digest,expected,32)==0)ok=TRUE;
done:
  if(hash)BCryptDestroyHash(hash);
  if(object)HeapFree(GetProcessHeap(),0,object);
  if(alg)BCryptCloseAlgorithmProvider(alg,0);
  return ok;
}
static BOOL signature(HANDLE f,const wchar_t *file,const BYTE expected[32]){
  GUID action=WINTRUST_ACTION_GENERIC_VERIFY_V2;
  WINTRUST_FILE_INFO info={0};info.cbStruct=sizeof(info);info.pcwszFilePath=file;info.hFile=f;
  WINTRUST_DATA data={0};data.cbStruct=sizeof(data);data.dwUIChoice=WTD_UI_NONE;
  data.fdwRevocationChecks=WTD_REVOKE_WHOLECHAIN;data.dwUnionChoice=WTD_CHOICE_FILE;
  data.pFile=&info;data.dwStateAction=WTD_STATEACTION_VERIFY;
  data.dwProvFlags=WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
  LONG result=WinVerifyTrust(NULL,&action,&data);BOOL ok=FALSE;
  if(result==ERROR_SUCCESS){
    CRYPT_PROVIDER_DATA *provider=WTHelperProvDataFromStateData(data.hWVTStateData);
    CRYPT_PROVIDER_SGNR *signer=provider?WTHelperGetProvSignerFromChain(provider,0,FALSE,0):NULL;
    PCCERT_CONTEXT cert=signer&&signer->csCertChain?signer->pasCertChain[0].pCert:NULL;
    BYTE digest[32];DWORD n=sizeof(digest);
    if(cert&&CryptHashCertificate2(BCRYPT_SHA256_ALGORITHM,0,NULL,cert->pbCertEncoded,
      cert->cbCertEncoded,digest,&n)&&n==sizeof(digest)&&memcmp(digest,expected,32)==0)ok=TRUE;
  }
  data.dwStateAction=WTD_STATEACTION_CLOSE;(void)WinVerifyTrust(NULL,&action,&data);return ok;
}
static BOOL job_empty(HANDLE job){
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a={0};
  return QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&a,sizeof(a),NULL)&&a.ActiveProcesses==0;
}
static BOOL wait_empty(HANDLE job,ULONGLONG until){
  do{if(job_empty(job))return TRUE;Sleep(20);}while(GetTickCount64()<until);return FALSE;
}
static int denied(const char *reason){fprintf(stderr,"CORE_OWNER_LAUNCH_DENIED:%s\n",reason);return 77;}
int wmain(int argc,wchar_t **argv){
  /* Args: RP, challenge, credential, SID, WTS session, logon LUID,
   * independently provisioned helper file and signer SHA-256. Never a path. */
  BYTE challenge[32],artifactHash[32],signerHash[32],nonce[32];
  DWORD session=0;LUID logon={0};PSID sid=NULL;
  if(argc!=10||wcscmp(argv[1],L"--ceremony")||!valid_rp(argv[2])||
    !hex(argv[3],challenge,32)||!hex_credential(argv[4])||wcslen(argv[5])>184||
    !session_id(argv[6],&session)||!luid_arg(argv[7],&logon)||
    !hex(argv[8],artifactHash,32)||!hex(argv[9],signerHash,32))return 64;
  if(!system_primary())return denied("SYSTEM_SESSION_ZERO_REQUIRED");
  if(!ConvertStringSidToSidW(argv[5],&sid))return 64;
  HANDLE owner=NULL,current=NULL,file=INVALID_HANDLE_VALUE,job=NULL,pipe=INVALID_HANDLE_VALUE,event=NULL,childToken=NULL;
  PSECURITY_DESCRIPTOR descriptor=NULL;PROCESS_INFORMATION child={0};BOOL drained=FALSE,success=FALSE;
  const char *reason="OWNER_BINDING_UNAVAILABLE";
  wchar_t helper[MAX_PATH]={0},pipeName[128]={0},sddl[400]={0},command[4096]={0};
  char output[8193]={0};DWORD used=0;
  if(!local_console(session)||!WTSQueryUserToken(session,&owner)||!owner_token(owner,sid,session,logon))goto done;
  reason="HELPER_ARTIFACT_UNVERIFIED";
  DWORD chars=GetModuleFileNameW(NULL,helper,MAX_PATH);
  if(!chars||chars>=MAX_PATH)goto done;
  wchar_t *leaf=wcsrchr(helper,L'\\');if(!leaf||_wcsicmp(leaf+1,L"windows-core-owner-launcher.exe"))goto done;
  if(wcscpy_s(leaf+1,(size_t)(MAX_PATH-(leaf+1-helper)),L"windows-core-webauthn-approval.exe"))goto done;
  file=CreateFileW(helper,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  BY_HANDLE_FILE_INFORMATION fi={0};
  if(file==INVALID_HANDLE_VALUE||!GetFileInformationByHandle(file,&fi)||
    fi.nNumberOfLinks!=1||(fi.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))||
    !sha256_file(file,artifactHash)||!signature(file,helper,signerHash))goto done;
  reason="PIPE_SETUP";
  if(BCryptGenRandom(NULL,nonce,sizeof(nonce),BCRYPT_USE_SYSTEM_PREFERRED_RNG)!=0)goto done;
  wchar_t nameHex[65]={0};const wchar_t alphabet[]=L"0123456789abcdef";
  for(size_t i=0;i<sizeof(nonce);i++){nameHex[i*2]=alphabet[nonce[i]>>4];nameHex[i*2+1]=alphabet[nonce[i]&15];}
  if(swprintf_s(pipeName,128,L"\\\\.\\pipe\\Nexowire.CoreOwnerAssertion.%ls",nameHex)<0||
    swprintf_s(sddl,400,L"D:P(A;;GA;;;SY)(A;;GW;;;%ls)",argv[5])<0||
    !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,SDDL_REVISION_1,&descriptor,NULL))goto done;
  SECURITY_ATTRIBUTES sa={sizeof(sa),descriptor,FALSE};
  pipe=CreateNamedPipeW(pipeName,PIPE_ACCESS_INBOUND|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,8192,8192,0,&sa);
  if(pipe==INVALID_HANDLE_VALUE)goto done;
  event=CreateEventW(NULL,TRUE,FALSE,NULL);if(!event)goto done;
  OVERLAPPED ov={0};ov.hEvent=event;
  BOOL connected=ConnectNamedPipe(pipe,&ov);DWORD err=connected?ERROR_SUCCESS:GetLastError();
  if(!connected&&err==ERROR_PIPE_CONNECTED){connected=TRUE;SetEvent(event);}
  else if(!connected&&err!=ERROR_IO_PENDING)goto done;
  reason="JOB_SETUP";
  job=CreateJobObjectW(NULL,NULL);if(!job)goto done;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};
  limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))goto done;
  if(swprintf_s(command,4096,L"\"%ls\" --assert-bound-pipe %ls %ls %ls %ls %ls %ls %ls",
    helper,argv[2],argv[3],argv[4],argv[5],argv[6],argv[7],pipeName)<0)goto done;
  reason="OWNER_CHANGED_BEFORE_LAUNCH";
  if(!local_console(session)||!WTSQueryUserToken(session,&current)||!owner_token(current,sid,session,logon))goto done;
  CloseHandle(current);current=NULL;
  STARTUPINFOW si={0};si.cb=sizeof(si);wchar_t desktop[]=L"winsta0\\default";si.lpDesktop=desktop;
  wchar_t environment[]=L"PATH=C:\\Windows\\System32;C:\\Windows\0SystemRoot=C:\\Windows\0windir=C:\\Windows\0";
  reason="CHILD_CREATE";
  /* bInheritHandles=FALSE is essential across Windows sessions. */
  if(!CreateProcessAsUserW(owner,helper,command,NULL,NULL,FALSE,
    CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,environment,L"C:\\Windows\\System32",&si,&child))goto done;
  reason="CHILD_BINDING";
  BOOL inside=FALSE;wchar_t image[MAX_PATH]={0};DWORD imageLength=MAX_PATH;
  if(!AssignProcessToJobObject(job,child.hProcess)||!IsProcessInJob(child.hProcess,job,&inside)||!inside||
    !QueryFullProcessImageNameW(child.hProcess,0,image,&imageLength)||_wcsicmp(image,helper)||
    !OpenProcessToken(child.hProcess,TOKEN_QUERY,&childToken)||!owner_token(childToken,sid,session,logon))goto done;
  if(ResumeThread(child.hThread)==(DWORD)-1)goto done;
  ULONGLONG until=GetTickCount64()+95000;
  reason="PIPE_CLIENT_UNVERIFIED";
  if(!connected){
    HANDLE waits[2]={event,child.hProcess};
    if(WaitForMultipleObjects(2,waits,FALSE,5000)!=WAIT_OBJECT_0)goto done;
    DWORD transferred=0;if(!GetOverlappedResult(pipe,&ov,&transferred,FALSE))goto done;
  }
  ULONG pid=0;if(!GetNamedPipeClientProcessId(pipe,&pid)||pid!=child.dwProcessId||
    WaitForSingleObject(child.hProcess,0)!=WAIT_TIMEOUT)goto done;
  reason="ASSERTION_OUTPUT_UNKNOWN";
  for(;;){
    DWORD got=0;ResetEvent(event);ZeroMemory(&ov,sizeof(ov));ov.hEvent=event;
    BOOL read=ReadFile(pipe,output+used,(DWORD)(sizeof(output)-1-used),&got,&ov);
    if(!read){
      err=GetLastError();
      if(err==ERROR_BROKEN_PIPE)break;
      if(err!=ERROR_IO_PENDING)goto done;
      ULONGLONG now=GetTickCount64();
      if(now>=until||WaitForSingleObject(event,(DWORD)(until-now))!=WAIT_OBJECT_0)goto done;
      if(!GetOverlappedResult(pipe,&ov,&got,FALSE)){
        if(GetLastError()==ERROR_BROKEN_PIPE)break;goto done;
      }
    }
    if(!got)break;used+=got;if(used>=sizeof(output)-1)goto done;
  }
  reason="CHILD_OR_JOB_NOT_DRAINED";
  ULONGLONG now=GetTickCount64();DWORD exitCode=1;
  if(now>=until||WaitForSingleObject(child.hProcess,(DWORD)(until-now))!=WAIT_OBJECT_0||
    !GetExitCodeProcess(child.hProcess,&exitCode)||!wait_empty(job,until))goto done;
  drained=TRUE;
  reason="OWNER_CHANGED_OR_ASSERTION_DENIED";
  if(exitCode!=0||!used||!local_console(session)||!WTSQueryUserToken(session,&current)||
    !owner_token(current,sid,session,logon))goto done;
  success=TRUE;
done:
  /* No caller-selected PID termination. Only our held child/job. A lost
   * outcome is never a proof of drain, even when kill-on-close is configured. */
  if(!drained&&child.hProcess){
    if(job)TerminateJobObject(job,77);
    if(WaitForSingleObject(child.hProcess,0)==WAIT_TIMEOUT)TerminateProcess(child.hProcess,77);
    if(job)(void)wait_empty(job,GetTickCount64()+2000);
  }
  if(pipe!=INVALID_HANDLE_VALUE){
    /* OVERLAPPED storage remains alive through cancellation completion. */
    if(!CancelIoEx(pipe,NULL)&&GetLastError()!=ERROR_NOT_FOUND)success=FALSE;
    CloseHandle(pipe);
  }
  if(event)CloseHandle(event);
  if(childToken)CloseHandle(childToken);
  if(child.hThread)CloseHandle(child.hThread);
  if(child.hProcess)CloseHandle(child.hProcess);
  if(job)CloseHandle(job);
  if(file!=INVALID_HANDLE_VALUE)CloseHandle(file);
  if(owner)CloseHandle(owner);
  if(current)CloseHandle(current);
  if(descriptor)LocalFree(descriptor);
  if(sid)LocalFree(sid);
  if(!success)return denied(reason);
  if(fwrite(output,1,used,stdout)!=(size_t)used||fflush(stdout)!=0)return 77;
  return 0;
}
