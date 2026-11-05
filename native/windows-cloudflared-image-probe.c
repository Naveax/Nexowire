/*
 * CLEAN-13 disposable Windows image identity PROBE, NOT A LAUNCH CUSTODIAN.
 * Builds on hosted Windows only. The created image is ALWAYS terminated
 * before its suspended primary thread is resumed. No production use.
 *
 * Properties actually measured:
 *   - no file/directory reparse points on the lexical drive-absolute path;
 *   - opened file has exactly one hard link;
 *   - native SHA256 is calculated on the held, non-write/non-delete-shared file;
 *   - FileIdInfo of held source matches a reopened process-image pathname
 *     while the process is suspended and ancestor handles remain held;
 *   - optional same-owner swap/write/delete attempts fail on a disposable copy.
 *
 * IMPORTANT: QueryFullProcessImageName returns a PATH, not an IMAGE_SECTION
 * HANDLE. This evidence deliberately MUST NOT enable Windows tunnel launch.
 */
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <stdio.h>
#include <wchar.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_PARENTS 80
#define MAX_FILE_SIZE (256ULL*1024*1024)
static HANDLE parents[MAX_PARENTS];
static int parent_count=0;
static HANDLE file_handle=INVALID_HANDLE_VALUE;
static PROCESS_INFORMATION child={0};
static int reason(const char *stage){
  fprintf(stderr,"NEXOWIRE_C13_NATIVE_REJECT stage=%s win32=%lu\n",stage,GetLastError());
  return 1;
}
static void cleanup(void){
  if(child.hProcess){
    TerminateProcess(child.hProcess,97);
    WaitForSingleObject(child.hProcess,3000);
    CloseHandle(child.hProcess);
  }
  if(child.hThread)CloseHandle(child.hThread);
  if(file_handle!=INVALID_HANDLE_VALUE)CloseHandle(file_handle);
  for(int i=parent_count-1;i>=0;i--)CloseHandle(parents[i]);
}
static int same_id(const FILE_ID_INFO *a,const FILE_ID_INFO *b){
  return a->VolumeSerialNumber==b->VolumeSerialNumber &&
    memcmp(a->FileId.Identifier,b->FileId.Identifier,16)==0;
}
static int file_id(HANDLE h,FILE_ID_INFO *out){
  ZeroMemory(out,sizeof(*out));
  return GetFileInformationByHandleEx(h,FileIdInfo,out,sizeof(*out));
}
static int no_reparse(HANDLE h){
  FILE_ATTRIBUTE_TAG_INFO tag={0};
  return GetFileInformationByHandleEx(h,FileAttributeTagInfo,&tag,sizeof(tag)) &&
    !(tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT);
}
static int sha256(HANDLE h,wchar_t out[65]){
  BCRYPT_ALG_HANDLE alg=NULL;
  BCRYPT_HASH_HANDLE hash=NULL;
  BYTE digest[32]={0};
  BYTE data[65536]={0};
  DWORD count=0;
  NTSTATUS status;
  int ok=0;
  status=BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,NULL,0);
  if(status<0)goto done;
  status=BCryptCreateHash(alg,&hash,NULL,0,NULL,0,0);
  if(status<0)goto done;
  LARGE_INTEGER zero={0};
  if(!SetFilePointerEx(h,zero,NULL,FILE_BEGIN))goto done;
  while(ReadFile(h,data,(DWORD)sizeof(data),&count,NULL)){
    if(!count)break;
    if(BCryptHashData(hash,data,count,0)<0)goto done;
  }
  if(GetLastError()!=ERROR_HANDLE_EOF && count!=0)goto done;
  if(BCryptFinishHash(hash,digest,32,0)<0)goto done;
  for(int i=0;i<32;i++)swprintf_s(out+i*2,3,L"%02x",(unsigned)digest[i]);
  out[64]=0;ok=1;
done:
  SecureZeroMemory(data,sizeof(data));
  if(hash)BCryptDestroyHash(hash);
  if(alg)BCryptCloseAlgorithmProvider(alg,0);
  return ok;
}
static int hold_ancestors(const wchar_t *input){
  size_t len=wcslen(input);
  if(len<4||len>=32000||input[1]!=L':'||input[2]!=L'\\')return 0;
  // Reject alternate Win32 device paths, UNC, ADS and dot traversal forms.
  if(wcsstr(input,L"..\\")||wcsstr(input,L"\\.\\")||
     wcschr(input,L'/')||wcschr(input+3,L':'))return 0;
  wchar_t *tmp=_wcsdup(input);
  if(!tmp)return 0;
  // Include drive root; then every lexical ancestor down to the file parent.
  for(size_t i=3;i<len;i++)if(input[i]==L'\\'){
    wchar_t save=tmp[i];tmp[i]=0;
    HANDLE h=CreateFileW(tmp,FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,NULL);
    tmp[i]=save;
    if(h==INVALID_HANDLE_VALUE||!no_reparse(h)||parent_count>=MAX_PARENTS){
      if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);
      free(tmp);return 0;
    }
    parents[parent_count++]=h;
  }
  free(tmp);
  return parent_count>0;
}
int wmain(int argc,wchar_t **argv){
  int rc=1;
  if(argc!=4 || (wcscmp(argv[1],L"--probe") && wcscmp(argv[1],L"--race")))
    return reason("ARGS");
  const int race=wcscmp(argv[1],L"--race")==0;
  const wchar_t *binary=argv[2], *expected=argv[3];
  if(wcslen(expected)!=64 || !hold_ancestors(binary)){
    rc=reason("ANCESTOR_OR_ARGUMENT");goto done;
  }
  file_handle=CreateFileW(binary,GENERIC_READ,FILE_SHARE_READ,NULL,
    OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,NULL);
  if(file_handle==INVALID_HANDLE_VALUE||!no_reparse(file_handle)){
    rc=reason("SOURCE_OPEN_REPARSE");goto done;
  }
  BY_HANDLE_FILE_INFORMATION basics={0};
  FILE_ID_INFO held_id={0};
  if(!GetFileInformationByHandle(file_handle,&basics)||
     (basics.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY) ||
     basics.nNumberOfLinks!=1 || !file_id(file_handle,&held_id)){
    rc=reason("SOURCE_LINK_OR_ID");goto done;
  }
  LARGE_INTEGER size={0};
  if(!GetFileSizeEx(file_handle,&size)||size.QuadPart<=0||
      (unsigned long long)size.QuadPart>MAX_FILE_SIZE){
    rc=reason("SOURCE_SIZE");goto done;
  }
  wchar_t observed[65]={0};
  if(!sha256(file_handle,observed) || _wcsicmp(observed,expected)!=0){
    rc=reason("SOURCE_SHA");goto done;
  }
  if(race){
    // RACE is legal ONLY for disposable copies, never the pinned download.
    // All attempts run in this process while source+ancestors are held open.
    HANDLE writing=CreateFileW(binary,GENERIC_WRITE,
      FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
      NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    if(writing!=INVALID_HANDLE_VALUE){
      CloseHandle(writing);rc=reason("WRITE_OPEN_ALLOWED");goto done;
    }
    wchar_t other[32768];
    if(swprintf_s(other,32768,L"%ls.c13-swap",binary)<0){
      rc=reason("RACE_PATH");goto done;
    }
    if(MoveFileExW(binary,other,MOVEFILE_REPLACE_EXISTING)){
      rc=reason("RENAME_ALLOWED");goto done;
    }
    if(DeleteFileW(binary)){
      rc=reason("DELETE_ALLOWED");goto done;
    }
  }
  wchar_t command[32768];
  if(swprintf_s(command,32768,L"\"%ls\" --version",binary)<0){
    rc=reason("PROCESS_COMMAND");goto done;
  }
  STARTUPINFOW si={0};si.cb=sizeof(si);
  // CreateProcessW has NO documented parameter accepting the held hFile
  // as the executable image-section trust root. The process is NEVER resumed.
  if(!CreateProcessW(binary,command,NULL,NULL,FALSE,
      CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,NULL,&si,&child)){
    rc=reason("CREATE_SUSPENDED");goto done;
  }
  DWORD chars=32768;
  wchar_t *process_path=(wchar_t*)calloc(chars,sizeof(wchar_t));
  if(!process_path){rc=reason("MEMORY");goto done;}
  if(!QueryFullProcessImageNameW(child.hProcess,0,process_path,&chars)){
    free(process_path);rc=reason("PROCESS_PATH");goto done;
  }
  HANDLE image_path=CreateFileW(process_path,FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  free(process_path);
  if(image_path==INVALID_HANDLE_VALUE){
    rc=reason("PROCESS_PATH_OPEN");goto done;
  }
  FILE_ID_INFO reported={0};
  int match=no_reparse(image_path)&&file_id(image_path,&reported)&&same_id(&held_id,&reported);
  CloseHandle(image_path);
  if(!match){rc=reason("PROCESS_PATH_FILE_ID");goto done;}
  FILETIME created={0},ended={0},kernel={0},user={0};
  if(!GetProcessTimes(child.hProcess,&created,&ended,&kernel,&user)){
    rc=reason("PROCESS_CREATION_TIME");goto done;
  }
  if(WaitForSingleObject(child.hProcess,0)!=WAIT_TIMEOUT){
    rc=reason("PREMATURE_CHILD_EXIT");goto done;
  }
  printf("NEXOWIRE_C13_NATIVE_PROBE=OK held_sha256=1 held_file_id=1 process_path_file_id=1 suspended=1 resumed=0 write_delete_lock=%d pid=%lu creation_ticks=%llu\n",
    race,child.dwProcessId,((unsigned long long)created.dwHighDateTime<<32)|created.dwLowDateTime);
  rc=0;
done:
  cleanup(); // ALWAYS TERMINATE PROCESS. Never ResumeThread.
  return rc;
}
