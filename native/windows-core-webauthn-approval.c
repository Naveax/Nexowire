/* Native owner-verification component. No service/install/elevation/grant.
 * --probe never displays UI. --assert explicitly invokes Windows WebAuthn
 * with REQUIRED user verification for one independently issued challenge and
 * pre-provisioned credential. Raw output is NOT a trusted Windows receipt.
 * CI must NEVER invoke --assert with a valid challenge/credential.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <webauthn.h>
#include <wtsapi32.h>
#include <stdio.h>
#include <stdint.h>
#include <wchar.h>
#include <string.h>

typedef DWORD (WINAPI *VersionFn)(void);
typedef HRESULT (WINAPI *GetFn)(HWND,LPCWSTR,PCWEBAUTHN_CLIENT_DATA,
  PCWEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,PWEBAUTHN_ASSERTION *);
typedef void (WINAPI *FreeFn)(PWEBAUTHN_ASSERTION);
typedef HRESULT (WINAPI *CancelIdFn)(GUID *);
typedef HRESULT (WINAPI *CancelFn)(const GUID *);
typedef struct { HANDLE done; GUID id; CancelFn cancel; } CancelContext;

static DWORD WINAPI cancel_after_deadline(LPVOID raw) {
  CancelContext *context=(CancelContext *)raw;
  if(WaitForSingleObject(context->done,90000)==WAIT_TIMEOUT)
    (void)context->cancel(&context->id);
  return 0;
}
static int unavailable(const char *reason,HRESULT error) {
  printf("{\"version\":1,\"kind\":\"core_webauthn_unavailable_v1\","
    "\"reason\":\"%s\",\"hresult\":%lu,\"coreAuthority\":false}\n",
    reason,(unsigned long)error);
  return 77;
}
static int hex_digit(wchar_t c) {
  if(c>=L'0'&&c<=L'9')return (int)(c-L'0');
  if(c>=L'a'&&c<=L'f')return (int)(c-L'a'+10);
  return -1;
}
static BOOL from_hex(const wchar_t *text,BYTE *out,size_t min,size_t max,size_t *length) {
  size_t n=wcslen(text);
  if(n%2||n/2<min||n/2>max)return FALSE;
  for(size_t i=0;i<n/2;i++){
    int a=hex_digit(text[i*2]),b=hex_digit(text[i*2+1]);
    if(a<0||b<0)return FALSE;
    out[i]=(BYTE)((a<<4)|b);
  }
  *length=n/2;return TRUE;
}
static BOOL base64url(const BYTE *bytes,size_t size,char *out,size_t capacity) {
  static const char alphabet[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  size_t needed=(size/3)*4+(size%3?size%3+1:0),j=0;
  if(needed>=capacity)return FALSE;
  for(size_t i=0;i<size;i+=3){
    size_t remaining=size-i;
    uint32_t value=(uint32_t)bytes[i]<<16;
    if(remaining>1)value|=(uint32_t)bytes[i+1]<<8;
    if(remaining>2)value|=bytes[i+2];
    out[j++]=alphabet[(value>>18)&63];out[j++]=alphabet[(value>>12)&63];
    if(remaining>1)out[j++]=alphabet[(value>>6)&63];
    if(remaining>2)out[j++]=alphabet[value&63];
  }
  out[j]='\0';return TRUE;
}
static BOOL valid_rp(const wchar_t *rpId,char *ascii,size_t capacity) {
  size_t n=wcslen(rpId),label=0;BOOL dot=FALSE,letter=FALSE;
  if(n<3||n>253||n>=capacity)return FALSE;
  for(size_t i=0;i<n;i++){
    wchar_t c=rpId[i];
    if(c==L'.'){
      if(!label||label>63||rpId[i-1]==L'-')return FALSE;
      dot=TRUE;label=0;
    }else{
      if(!((c>=L'a'&&c<=L'z')||(c>=L'0'&&c<=L'9')||c==L'-')||
        (!label&&c==L'-'))return FALSE;
      if(c>=L'a'&&c<=L'z')letter=TRUE;
      label++;
    }
    ascii[i]=(char)c;
  }
  ascii[n]='\0';
  return dot&&letter&&label>0&&label<=63&&rpId[n-1]!=L'-';
}
static BOOL named(HANDLE object,const wchar_t *expected) {
  WCHAR name[256]={0};DWORD bytes=0;
  if(!object||!GetUserObjectInformationW(object,UOI_NAME,name,sizeof(name),&bytes)||
    bytes<sizeof(WCHAR)||bytes>sizeof(name)||bytes%sizeof(WCHAR)||
    name[bytes/sizeof(WCHAR)-1]!=L'\0')return FALSE;
  return _wcsicmp(name,expected)==0;
}
static BOOL active_local_desktop(void) {
  DWORD session=0,bytes=0;LPWSTR raw=NULL;
  if(!ProcessIdToSessionId(GetCurrentProcessId(),&session)||!session||
    WTSGetActiveConsoleSessionId()!=session||
    !named(GetProcessWindowStation(),L"WinSta0")||
    !named(GetThreadDesktop(GetCurrentThreadId()),L"Default"))return FALSE;
  if(!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,session,WTSConnectState,&raw,&bytes))return FALSE;
  BOOL active=raw&&bytes==sizeof(WTS_CONNECTSTATE_CLASS)&&*(WTS_CONNECTSTATE_CLASS *)raw==WTSActive;
  if(raw)WTSFreeMemory(raw);raw=NULL;bytes=0;
  if(!active||!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,session,WTSClientProtocolType,&raw,&bytes))return FALSE;
  BOOL local=raw&&bytes==sizeof(USHORT)&&*(USHORT *)raw==0;
  if(raw)WTSFreeMemory(raw);
  HDESK input=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
  BOOL normal=input&&named(input,L"Default");
  if(input)CloseDesktop(input);
  return local&&normal;
}
int wmain(int argc,wchar_t **argv) {
  BOOL probe=argc==2&&wcscmp(argv[1],L"--probe")==0;
  BYTE challenge[32]={0},credentialBytes[1024]={0};size_t challengeSize=0,credentialSize=0;
  char rpAscii[254]={0},challenge64[44]={0},client[1024]={0};
  if(!probe){
    if(argc!=5||wcscmp(argv[1],L"--assert")||
      !valid_rp(argv[2],rpAscii,sizeof(rpAscii))||
      !from_hex(argv[3],challenge,32,32,&challengeSize)||
      !from_hex(argv[4],credentialBytes,1,1024,&credentialSize)||
      !base64url(challenge,challengeSize,challenge64,sizeof(challenge64)))return 64;
  }
  HMODULE api=LoadLibraryExW(L"webauthn.dll",NULL,LOAD_LIBRARY_SEARCH_SYSTEM32);
  if(!api)return unavailable("WEBAUTHN_SYSTEM_API_UNAVAILABLE",HRESULT_FROM_WIN32(GetLastError()));
  VersionFn version=NULL;GetFn get=NULL;FreeFn freeAssertion=NULL;CancelIdFn cancelId=NULL;CancelFn cancel=NULL;
  FARPROC proc=GetProcAddress(api,"WebAuthNGetApiVersionNumber");memcpy(&version,&proc,sizeof(version));
  proc=GetProcAddress(api,"WebAuthNAuthenticatorGetAssertion");memcpy(&get,&proc,sizeof(get));
  proc=GetProcAddress(api,"WebAuthNFreeAssertion");memcpy(&freeAssertion,&proc,sizeof(freeAssertion));
  proc=GetProcAddress(api,"WebAuthNGetCancellationId");memcpy(&cancelId,&proc,sizeof(cancelId));
  proc=GetProcAddress(api,"WebAuthNCancelCurrentOperation");memcpy(&cancel,&proc,sizeof(cancel));
  if(!version||!get||!freeAssertion||!cancelId||!cancel||!version()){
    FreeLibrary(api);return unavailable("WEBAUTHN_REQUIRED_API_UNAVAILABLE",E_NOTIMPL);
  }
  if(probe){
    printf("{\"version\":1,\"kind\":\"core_webauthn_api_probe_v1\",\"apiVersion\":%lu,"
      "\"coreAuthority\":false,\"physicalAcceptance\":\"NOT_PROVEN\"}\n",(unsigned long)version());
    FreeLibrary(api);return 0;
  }
  if(!active_local_desktop()){
    FreeLibrary(api);return unavailable("ACTIVE_LOCAL_OWNER_DESKTOP_REQUIRED",E_ACCESSDENIED);
  }
  int clientLength=_snprintf_s(client,sizeof(client),_TRUNCATE,
    "{\"type\":\"webauthn.get\",\"challenge\":\"%s\",\"origin\":\"https://%s\",\"crossOrigin\":false}",
    challenge64,rpAscii);
  if(clientLength<=0){FreeLibrary(api);return 64;}
  HWND window=CreateWindowExW(0,L"STATIC",
    L"Nexowire CORE owner verification - confirm only the enrollment you requested. Close to cancel.",
    WS_OVERLAPPEDWINDOW|WS_VISIBLE,CW_USEDEFAULT,CW_USEDEFAULT,700,150,NULL,NULL,GetModuleHandleW(NULL),NULL);
  if(!window){FreeLibrary(api);return unavailable("OWNER_WINDOW_UNAVAILABLE",HRESULT_FROM_WIN32(GetLastError()));}
  WEBAUTHN_CREDENTIAL credential={0};credential.dwVersion=WEBAUTHN_CREDENTIAL_CURRENT_VERSION;
  credential.cbId=(DWORD)credentialSize;credential.pbId=credentialBytes;credential.pwszCredentialType=WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY;
  WEBAUTHN_CLIENT_DATA data={0};data.dwVersion=WEBAUTHN_CLIENT_DATA_CURRENT_VERSION;
  data.cbClientDataJSON=(DWORD)clientLength;data.pbClientDataJSON=(PBYTE)client;data.pwszHashAlgId=WEBAUTHN_HASH_ALGORITHM_SHA_256;
  WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS options={0};
  options.dwVersion=WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_3;
  options.dwTimeoutMilliseconds=90000;options.CredentialList.cCredentials=1;
  options.CredentialList.pCredentials=&credential;
  options.dwAuthenticatorAttachment=WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY;
  options.dwUserVerificationRequirement=WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
  CancelContext context={0};context.cancel=cancel;
  HRESULT status=cancelId(&context.id);
  context.done=CreateEventW(NULL,TRUE,FALSE,NULL);options.pCancellationId=&context.id;
  HANDLE timer=NULL;PWEBAUTHN_ASSERTION assertion=NULL;
  if(FAILED(status))goto cleanup;
  if(!context.done){status=HRESULT_FROM_WIN32(GetLastError());goto cleanup;}
  timer=CreateThread(NULL,0,cancel_after_deadline,&context,0,NULL);
  if(!timer){status=HRESULT_FROM_WIN32(GetLastError());goto cleanup;}
  ULONGLONG started=GetTickCount64();
  status=get(window,argv[2],&data,&options,&assertion);
  if(FAILED(status))goto cleanup;
  if(GetTickCount64()-started>90000||!active_local_desktop()||!assertion||
    assertion->cbAuthenticatorData!=37||!assertion->pbAuthenticatorData||
    assertion->pbAuthenticatorData[32]!=0x05||assertion->cbSignature<8||assertion->cbSignature>80||
    !assertion->pbSignature||assertion->Credential.cbId!=credentialSize||!assertion->Credential.pbId||
    memcmp(assertion->Credential.pbId,credentialBytes,credentialSize)||assertion->cbUserId>64||
    (assertion->cbUserId&&!assertion->pbUserId)){
    status=E_ACCESSDENIED;goto cleanup;
  }
  char credential64[1367]={0},client64[1367]={0},auth64[52]={0},sig64[108]={0},user64[87]={0};
  if(!base64url(credentialBytes,credentialSize,credential64,sizeof(credential64))||
    !base64url((BYTE *)client,(size_t)clientLength,client64,sizeof(client64))||
    !base64url(assertion->pbAuthenticatorData,assertion->cbAuthenticatorData,auth64,sizeof(auth64))||
    !base64url(assertion->pbSignature,assertion->cbSignature,sig64,sizeof(sig64))||
    !base64url(assertion->pbUserId,assertion->cbUserId,user64,sizeof(user64))){
    status=E_INVALIDARG;goto cleanup;
  }
  printf("{\"version\":1,\"kind\":\"core_webauthn_assertion_v1\",\"credentialId\":\"%s\","
    "\"clientDataJSON\":\"%s\",\"authenticatorData\":\"%s\",\"signature\":\"%s\",\"userHandle\":",
    credential64,client64,auth64,sig64);
  if(assertion->cbUserId)printf("\"%s\"",user64);else printf("null");
  printf(",\"coreAuthority\":false}\n");
cleanup:
  if(context.done)SetEvent(context.done);
  if(timer){
    if(WaitForSingleObject(timer,2000)!=WAIT_OBJECT_0)ExitProcess(77);
    CloseHandle(timer);
  }
  if(context.done)CloseHandle(context.done);
  if(assertion)freeAssertion(assertion);
  DestroyWindow(window);FreeLibrary(api);
  return FAILED(status)?unavailable("OWNER_VERIFICATION_CANCELLED_OR_UNAVAILABLE",status):0;
}
