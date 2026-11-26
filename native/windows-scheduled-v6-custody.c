/* Read-only native building blocks for a future protected scheduled supervisor.
 * Not an executable, signer, boot-epoch authority, or release provider.
 * No CreateProcess/ResumeThread, no named or file-based release gate.
 * Callers must retain this context through independent verification/abort.
 * A held source file is NOT proof of a mapped image section. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <bcrypt.h>
#include <wchar.h>
#include <string.h>

#define NX_MAX_ANCESTORS 80
#define NX_MAX_FILE_BYTES (256ULL*1024*1024)
#define NX_NATIVE_GATE_MS 10000ULL

typedef struct NX_HELD_FILE {
  HANDLE file;
  HANDLE ancestors[NX_MAX_ANCESTORS];
  DWORD ancestor_count;
  FILE_ID_INFO id;
  BYTE sha256[32];
} NX_HELD_FILE;

typedef struct NX_PRIVATE_CHANNEL {
  HANDLE read_end;
  HANDLE write_end;
} NX_PRIVATE_CHANNEL;

typedef struct NX_BOOT_OBSERVATION {
  GUID boot_entry; /* BCD loader entry identifier; NOT a unique boot epoch. */
  ULONGLONG interrupt_100ns;
  ULONGLONG tick_ms;
} NX_BOOT_OBSERVATION;

typedef LONG (NTAPI *NX_QUERY_SYSTEM)(ULONG,PVOID,ULONG,PULONG);

/* Native boot supporting readback only. SystemBootEnvironmentInformation
 * (0x5a) is an undocumented ABI. Reject unsupported length or zero GUID.
 * Never turn the BCD entry or uptime alone into a persistent boot grant. */
BOOL nx_v6_observe_boot(NX_BOOT_OBSERVATION *out){
  HMODULE ntdll=GetModuleHandleW(L"ntdll.dll");
  if(!out||!ntdll)return FALSE;
  FARPROC raw=GetProcAddress(ntdll,"NtQuerySystemInformation");
  NX_QUERY_SYSTEM query=NULL;
  if(!raw||sizeof(raw)!=sizeof(query))return FALSE;
  memcpy(&query,&raw,sizeof(query));
  union { ULONGLONG alignment; BYTE bytes[32]; } data={0};
  ULONG used=0;
  if(query(0x5a,data.bytes,(ULONG)sizeof(data.bytes),&used)!=0||used!=32)return FALSE;
  NX_BOOT_OBSERVATION next={0};
  GUID zero={0};
  memcpy(&next.boot_entry,data.bytes,sizeof(GUID));
  if(!memcmp(&next.boot_entry,&zero,sizeof(GUID))||
     !QueryUnbiasedInterruptTime(&next.interrupt_100ns))return FALSE;
  next.tick_ms=GetTickCount64();
  *out=next;return TRUE;
}

static BOOL nx_no_reparse(HANDLE h){
  FILE_ATTRIBUTE_TAG_INFO tag={0};
  return GetFileInformationByHandleEx(h,FileAttributeTagInfo,&tag,sizeof(tag))&&
    !(tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT);
}
static BOOL nx_noninheritable(HANDLE h){
  DWORD flags=0;
  return GetHandleInformation(h,&flags)&&!(flags&HANDLE_FLAG_INHERIT);
}

void nx_v6_close_file(NX_HELD_FILE *f){
  if(!f)return;
  if(f->file&&f->file!=INVALID_HANDLE_VALUE)CloseHandle(f->file);
  while(f->ancestor_count)CloseHandle(f->ancestors[--f->ancestor_count]);
  SecureZeroMemory(f,sizeof(*f));
}
static BOOL nx_hash_file(HANDLE h,BYTE out[32]){
  BCRYPT_ALG_HANDLE alg=NULL;
  BCRYPT_HASH_HANDLE hash=NULL;
  LARGE_INTEGER size={0},zero={0};
  BYTE data[65536];DWORD read=0;
  ULONGLONG total=0;
  BOOL ok=FALSE;
  if(!GetFileSizeEx(h,&size)||size.QuadPart<=0||
     (ULONGLONG)size.QuadPart>NX_MAX_FILE_BYTES||
     !SetFilePointerEx(h,zero,NULL,FILE_BEGIN))goto done;
  if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,NULL,0)<0||
     BCryptCreateHash(alg,&hash,NULL,0,NULL,0,0)<0)goto done;
  for(;;){
    if(!ReadFile(h,data,(DWORD)sizeof(data),&read,NULL))goto done;
    if(!read)break;
    total+=read;
    if(total>(ULONGLONG)size.QuadPart||BCryptHashData(hash,data,read,0)<0)goto done;
  }
  if(total!=(ULONGLONG)size.QuadPart||BCryptFinishHash(hash,out,32,0)<0)goto done;
  ok=TRUE;
done:
  SecureZeroMemory(data,sizeof(data));
  if(hash)BCryptDestroyHash(hash);
  if(alg)BCryptCloseAlgorithmProvider(alg,0);
  return ok;
}
static BOOL nx_canonical_path(const wchar_t *p){
  if(!p)return FALSE;
  size_t n=wcslen(p);
  if(n<4||n>=32760||!((p[0]>=L'A'&&p[0]<=L'Z')||(p[0]>=L'a'&&p[0]<=L'z'))||
     p[1]!=L':'||p[2]!=L'\\')return FALSE;
  if(wcschr(p+3,L':')||wcschr(p,L'/')||wcschr(p,L'*')||wcschr(p,L'?'))return FALSE;
  const wchar_t *start=p+3;
  for(const wchar_t *c=start;;++c){
    if(*c==L'\\'||!*c){
      if(c==start||c[-1]==L'.'||c[-1]==L' ')return FALSE;
      if(!*c)break;
      start=c+1;
    }else if(*c<32||*c==L'"'||*c==L'<'||*c==L'>'||*c==L'|')return FALSE;
  }
  return TRUE;
}
static BOOL nx_hold_ancestor(NX_HELD_FILE *f,const wchar_t *p){
  if(f->ancestor_count>=NX_MAX_ANCESTORS)return FALSE;
  /* FILE_READ_ATTRIBUTES alone is a metadata-only open: Windows share
   * checks need a read/write/delete access bit. FILE_LIST_DIRECTORY is
   * directory data read access and makes omission of FILE_SHARE_DELETE
   * effective. Never fall back to an attributes-only open if denied. */
  HANDLE h=CreateFileW(p,FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,
    NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  if(h==INVALID_HANDLE_VALUE)return FALSE;
  FILE_ATTRIBUTE_TAG_INFO tag={0};
  if(!nx_noninheritable(h)||!GetFileInformationByHandleEx(h,FileAttributeTagInfo,&tag,sizeof(tag))||
     !(tag.FileAttributes&FILE_ATTRIBUTE_DIRECTORY)||(tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){
    CloseHandle(h);return FALSE;
  }
  f->ancestors[f->ancestor_count++]=h;return TRUE;
}

/* Exact read-only held source; denies concurrent new write/delete opens.
 * Reject aliases/reparse/links; retained ancestor handles block rename/delete.
 * Caller must pass protected canonical manifest path and independent digest.
 * No ACL or executed-image section attestation is implied. */
BOOL nx_v6_hold_file(const wchar_t *p,const BYTE expected[32],NX_HELD_FILE *out){
  if(!out||!expected||!nx_canonical_path(p))return FALSE;
  NX_HELD_FILE f={0};
  wchar_t *copy=HeapAlloc(GetProcessHeap(),0,(wcslen(p)+1)*sizeof(wchar_t));
  if(!copy)return FALSE;
  memcpy(copy,p,(wcslen(p)+1)*sizeof(wchar_t));
  BOOL ok=FALSE;
  wchar_t saved=copy[3];copy[3]=0;
  if(!nx_hold_ancestor(&f,copy))goto done;
  copy[3]=saved;
  for(wchar_t *c=copy+3;*c;++c)if(*c==L'\\'){
    *c=0;
    if(!nx_hold_ancestor(&f,copy))goto done;
    *c=L'\\';
  }
  f.file=CreateFileW(p,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,NULL);
  if(f.file==INVALID_HANDLE_VALUE||!nx_noninheritable(f.file)||!nx_no_reparse(f.file))goto done;
  BY_HANDLE_FILE_INFORMATION info={0};
  if(!GetFileInformationByHandle(f.file,&info)||info.nNumberOfLinks!=1||
     (info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)||
     !GetFileInformationByHandleEx(f.file,FileIdInfo,&f.id,sizeof(f.id)))goto done;
  // Require the final normalized DOS path to be the exact requested path.
  wchar_t actual[32768];
  DWORD count=GetFinalPathNameByHandleW(f.file,actual,32768,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if(count<5||count>=32768||wcsncmp(actual,L"\\\\?\\",4)||_wcsicmp(actual+4,p))goto done;
  if(!nx_hash_file(f.file,f.sha256)||memcmp(expected,f.sha256,32))goto done;
  *out=f;ok=TRUE;
done:
  HeapFree(GetProcessHeap(),0,copy);
  if(!ok)nx_v6_close_file(&f);
  return ok;
}
BOOL nx_v6_recheck_file(const NX_HELD_FILE *f){
  if(!f||!f->file||f->file==INVALID_HANDLE_VALUE||!nx_noninheritable(f->file)||!nx_no_reparse(f->file))
    return FALSE;
  FILE_ID_INFO id={0};BYTE hash[32];BY_HANDLE_FILE_INFORMATION info={0};
  if(!GetFileInformationByHandle(f->file,&info)||info.nNumberOfLinks!=1||
     !GetFileInformationByHandleEx(f->file,FileIdInfo,&id,sizeof(id))||
     id.VolumeSerialNumber!=f->id.VolumeSerialNumber||
     memcmp(id.FileId.Identifier,f->id.FileId.Identifier,16)||
     !nx_hash_file(f->file,hash)||memcmp(hash,f->sha256,32))return FALSE;
  for(DWORD i=0;i<f->ancestor_count;++i)
    if(!nx_noninheritable(f->ancestors[i])||!nx_no_reparse(f->ancestors[i]))return FALSE;
  return TRUE;
}

void nx_v6_close_channel(NX_PRIVATE_CHANNEL *c){
  if(!c)return;
  if(c->read_end)CloseHandle(c->read_end);
  if(c->write_end)CloseHandle(c->write_end);
  ZeroMemory(c,sizeof(*c));
}
/* Anonymous noninherited endpoints, no caller-controlled object name.
 * Peer transfer must later use an exact protected process handle and explicit
 * handle allowlist, not inherit-all. This alone is NOT equal-HIGH isolation. */
BOOL nx_v6_open_channel(NX_PRIVATE_CHANNEL *out){
  if(!out)return FALSE;
  NX_PRIVATE_CHANNEL c={0};
  if(!CreatePipe(&c.read_end,&c.write_end,NULL,4096)||
     !nx_noninheritable(c.read_end)||!nx_noninheritable(c.write_end)||
     GetFileType(c.read_end)!=FILE_TYPE_PIPE||GetFileType(c.write_end)!=FILE_TYPE_PIPE){
    nx_v6_close_channel(&c);return FALSE;
  }
  *out=c;return TRUE;
}
/* Only an additional local check. Signed expiry and trusted provider clock
 * checks are also required; native assignment deadline is never renewed. */
BOOL nx_v6_native_gate_live(ULONGLONG assignment_tick){
  ULONGLONG now=GetTickCount64();
  return assignment_tick>0&&now>=assignment_tick&&now-assignment_tick<NX_NATIVE_GATE_MS;
}
