/*
 * Nexowire #07: Windows native readback DIAGNOSTIC, NOT A TASK WORKER.
 * No caller-supplied command, binary, path, token or process may be launched.
 * The in-process token/Job readback is not an independent production attester.
 * Build in a disposable Windows test VM:
 *   cl /nologo /W4 /WX /D_CRT_SECURE_NO_WARNINGS FILE.c /Fe:probe.exe
 * A successful diagnostic is NOT a task execution or CORE permit.
 */
#if !defined(_WIN32)
#error Windows-only readback diagnostic; cross-platform fallback forbidden.
#endif
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <stdio.h>
#include <string.h>

/* There is intentionally no CreateProcess, service, token mutation, or IPC. */
static int read_dword_token(HANDLE token, TOKEN_INFORMATION_CLASS type,
                            DWORD *result) {
  DWORD size = 0;
  *result = 0;
  return GetTokenInformation(token, type, result, sizeof(*result), &size) &&
         size == sizeof(*result);
}
static int read_integrity_rid(HANDLE token, DWORD *rid) {
  DWORD needed = 0;
  TOKEN_MANDATORY_LABEL *label;
  DWORD count;
  int valid = 0;
  (void)GetTokenInformation(token, TokenIntegrityLevel, NULL, 0, &needed);
  if (needed < sizeof(TOKEN_MANDATORY_LABEL) || needed > 65536U) return 0;
  label = (TOKEN_MANDATORY_LABEL *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                               (SIZE_T)needed);
  if (!label) return 0;
  if (GetTokenInformation(token, TokenIntegrityLevel, label, needed, &needed) &&
      IsValidSid(label->Label.Sid)) {
    count = *GetSidSubAuthorityCount(label->Label.Sid);
    if (count > 0) {
      *rid = *GetSidSubAuthority(label->Label.Sid, count - 1);
      valid = 1;
    }
  }
  (void)HeapFree(GetProcessHeap(), 0, label);
  return valid;
}
static int diagnostic_readback(void) {
  HANDLE token = NULL;
  DWORD elevated = 1, appcontainer = 0, integrity_rid = 0;
  BOOL in_job = FALSE;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION job;
  FILETIME created, exited, kernel, user;
  DWORD flags = 0;
  int token_ok = 0, job_ok = 0, clock_ok = 0;
  ZeroMemory(&job, sizeof(job));
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    fputs("NW07_WINDOWS_TOKEN_READBACK_UNAVAILABLE\n", stderr);
    return 77;
  }
  token_ok = read_dword_token(token, TokenElevation, &elevated) &&
    read_dword_token(token, TokenIsAppContainer, &appcontainer) &&
    read_integrity_rid(token, &integrity_rid);
  (void)CloseHandle(token);
  job_ok = IsProcessInJob(GetCurrentProcess(), NULL, &in_job) && in_job &&
    QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation,
                              &job, sizeof(job), NULL);
  if (job_ok) flags = job.BasicLimitInformation.LimitFlags;
  clock_ok = GetProcessTimes(GetCurrentProcess(), &created, &exited,
                             &kernel, &user) != 0;
  /* Job presence is NOT confinement. No independent descendant, file,
   * network, handle/ACL, WFP or revoke-and-drain proof exists here. */
  if (!token_ok || elevated != 0 || appcontainer != 1 ||
      integrity_rid > SECURITY_MANDATORY_LOW_RID ||
      !job_ok || !clock_ok ||
      (flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK |
                JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) != 0) {
    fputs("NW07_WINDOWS_BOUNDARY_NOT_PROVEN (NO_TASK_EXEC)\n", stderr);
    return 77;
  }
  /* This marker only reports local observations, never OS admission. */
  printf("NW07_WINDOWS_TOKEN_JOB_SELF_DIAGNOSTIC_ONLY "
         "pid=%lu created=%08lx%08lx (NOT_PRODUCTION_ACCEPTANCE)\n",
         (unsigned long)GetCurrentProcessId(),
         (unsigned long)created.dwHighDateTime,
         (unsigned long)created.dwLowDateTime);
  return 0;
}
int main(int argc, char **argv) {
  if (argc != 2 || strcmp(argv[1], "--selftest-only") != 0) {
    fputs("NW07_SOURCE_ONLY_NO_TASK_EXEC\n", stderr);
    return 64;
  }
  return diagnostic_readback();
}
