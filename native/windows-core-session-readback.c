/* Read-only kernel/session witness for a future protected CORE authority.
 * This is NOT an enrollment provider, human approval, signer or grant.
 * Never change a token, desktop, ACL, service, task, profile or input device.
 * Exit 0: observation only; 77: unavailable; 64: invalid invocation.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <wtsapi32.h>
#include <sddl.h>
#include <stdio.h>
#include <wchar.h>
#include <stdint.h>

static const char *json_bool(BOOL value) { return value ? "true" : "false"; }
static BOOL equal_luid(LUID a, LUID b) {
  return a.HighPart == b.HighPart && a.LowPart == b.LowPart;
}
static ULONGLONG filetime_value(FILETIME time) {
  ULARGE_INTEGER value;
  value.LowPart = time.dwLowDateTime;
  value.HighPart = time.dwHighDateTime;
  return value.QuadPart;
}
static ULONGLONG unix_ms(void) {
  FILETIME time;
  GetSystemTimeAsFileTime(&time);
  ULONGLONG ticks = filetime_value(time);
  return ticks > 116444736000000000ULL
    ? (ticks - 116444736000000000ULL) / 10000ULL : 0;
}
static int unavailable(const wchar_t *nonce, const char *reason, DWORD error) {
  printf("{\"version\":1,\"kind\":\"windows_core_session_readback_v1\","
    "\"nonce\":\"%ls\",\"state\":\"UNAVAILABLE\",\"humanApproval\":false,"
    "\"coreAuthority\":false,\"reason\":\"%s\",\"win32Error\":%lu}\n",
    nonce, reason, (unsigned long)error);
  return 77;
}
static BOOL session_info(DWORD session, USHORT *protocol, WTS_CONNECTSTATE_CLASS *state) {
  LPWSTR raw = NULL;
  DWORD bytes = 0;
  if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session,
      WTSClientProtocolType, &raw, &bytes)) return FALSE;
  if (!raw || bytes != sizeof(*protocol)) {
    if (raw) WTSFreeMemory(raw);
    SetLastError(ERROR_INVALID_DATA); return FALSE;
  }
  CopyMemory(protocol, raw, sizeof(*protocol));
  WTSFreeMemory(raw); raw = NULL; bytes = 0;
  if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session,
      WTSConnectState, &raw, &bytes)) return FALSE;
  if (!raw || bytes != sizeof(*state)) {
    if (raw) WTSFreeMemory(raw);
    SetLastError(ERROR_INVALID_DATA); return FALSE;
  }
  CopyMemory(state, raw, sizeof(*state));
  WTSFreeMemory(raw);
  return TRUE;
}
static BOOL object_named(HANDLE object, const wchar_t *expected, BOOL *matches) {
  WCHAR name[256] = {0};
  DWORD bytes = 0;
  if (!object || !GetUserObjectInformationW(object, UOI_NAME, name,
      sizeof(name), &bytes)) return FALSE;
  if (bytes < sizeof(WCHAR) || bytes > sizeof(name) ||
      bytes % sizeof(WCHAR) || name[bytes / sizeof(WCHAR) - 1] != L'\0') {
    SetLastError(ERROR_INVALID_DATA); return FALSE;
  }
  *matches = _wcsicmp(name, expected) == 0;
  return TRUE;
}
static BOOL desktop_state(BOOL *station, BOOL *thread, BOOL *input) {
  if (!object_named(GetProcessWindowStation(), L"WinSta0", station) ||
      !object_named(GetThreadDesktop(GetCurrentThreadId()), L"Default", thread))
    return FALSE;
  HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desktop) return FALSE;
  BOOL read = object_named(desktop, L"Default", input);
  DWORD error = GetLastError();
  CloseDesktop(desktop);
  if (!read) SetLastError(error);
  return read;
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 3 || wcscmp(argv[1], L"--readback") || wcslen(argv[2]) != 64)
    return 64;
  for (int i = 0; i < 64; ++i)
    if (!((argv[2][i] >= L'0' && argv[2][i] <= L'9') ||
          (argv[2][i] >= L'a' && argv[2][i] <= L'f'))) return 64;
  const wchar_t *nonce = argv[2];
  const ULONGLONG started = GetTickCount64();
  const ULONGLONG startedWall = unix_ms();
  HANDLE token = NULL, current = NULL;
  LPWSTR sid = NULL;
  const char *failure = "TOKEN_INFORMATION_UNAVAILABLE";
  DWORD failureCode = ERROR_INVALID_DATA, bytes = 0;
  DWORD processSession = 0, tokenSession = 0, refreshedSession = 0;
  DWORD integrity = 0, console = WTSGetActiveConsoleSessionId();
  TOKEN_STATISTICS before = {0}, after = {0};
  TOKEN_ELEVATION elevation = {0};
  union { TOKEN_USER alignment;
    BYTE bytes[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE]; } userRaw = {0};
  union { TOKEN_MANDATORY_LABEL alignment;
    BYTE bytes[sizeof(TOKEN_MANDATORY_LABEL) + SECURITY_MAX_SID_SIZE]; } labelRaw = {0};
  USHORT protocol = 0, refreshedProtocol = 0;
  WTS_CONNECTSTATE_CLASS state = WTSDown, refreshedState = WTSDown;
  BOOL station = FALSE, thread = FALSE, input = FALSE;
  BOOL stationAfter = FALSE, threadAfter = FALSE, inputAfter = FALSE;
  FILETIME created = {0}, exited = {0}, kernel = {0}, user = {0};

  if (console == 0xffffffffUL) {
    failure = "CONSOLE_UNAVAILABLE"; failureCode = ERROR_NOT_READY; goto done;
  }
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    failure = "PROCESS_TOKEN_UNAVAILABLE"; failureCode = GetLastError(); goto done;
  }
  if (!GetTokenInformation(token, TokenStatistics, &before, sizeof(before), &bytes) ||
      !GetTokenInformation(token, TokenUser, userRaw.bytes, sizeof(userRaw.bytes), &bytes) ||
      !IsValidSid(((TOKEN_USER *)userRaw.bytes)->User.Sid) ||
      !GetTokenInformation(token, TokenSessionId, &tokenSession, sizeof(tokenSession), &bytes) ||
      !GetTokenInformation(token, TokenIntegrityLevel, labelRaw.bytes, sizeof(labelRaw.bytes), &bytes) ||
      !GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &bytes) ||
      !ProcessIdToSessionId(GetCurrentProcessId(), &processSession) ||
      !GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) {
    failureCode = GetLastError(); goto done;
  }
  PSID label = ((TOKEN_MANDATORY_LABEL *)labelRaw.bytes)->Label.Sid;
  if (before.TokenType != TokenPrimary || processSession != tokenSession ||
      !IsValidSid(label) || !*GetSidSubAuthorityCount(label)) goto done;
  integrity = *GetSidSubAuthority(label, *GetSidSubAuthorityCount(label) - 1);
  if (!ConvertSidToStringSidW(((TOKEN_USER *)userRaw.bytes)->User.Sid, &sid)) {
    failureCode = GetLastError(); goto done;
  }
  if (!session_info(processSession, &protocol, &state)) {
    failure = "SESSION_INFORMATION_UNAVAILABLE"; failureCode = GetLastError(); goto done;
  }
  if (!desktop_state(&station, &thread, &input)) {
    failure = "INPUT_DESKTOP_UNAVAILABLE"; failureCode = GetLastError(); goto done;
  }
  /* Reopen the actual primary token: an old held token cannot hide replacement.
   * A repeated desktop/session observation is not atomic with a future effect.
   */
  failure = "SESSION_CHANGED_DURING_READBACK";
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &current) ||
      !GetTokenInformation(current, TokenStatistics, &after, sizeof(after), &bytes) ||
      !ProcessIdToSessionId(GetCurrentProcessId(), &refreshedSession) ||
      !session_info(processSession, &refreshedProtocol, &refreshedState) ||
      !desktop_state(&stationAfter, &threadAfter, &inputAfter)) {
    failureCode = GetLastError(); goto done;
  }
  if (!equal_luid(before.TokenId, after.TokenId) ||
      !equal_luid(before.ModifiedId, after.ModifiedId) ||
      !equal_luid(before.AuthenticationId, after.AuthenticationId) ||
      refreshedSession != processSession || console != WTSGetActiveConsoleSessionId() ||
      protocol != refreshedProtocol || state != refreshedState ||
      station != stationAfter || thread != threadAfter || input != inputAfter)
    goto done;
  ULONGLONG finished = GetTickCount64(), now = unix_ms();
  if (!startedWall || !now || now < startedWall || finished < started) {
    failure = "READBACK_CLOCK_INVALID"; goto done;
  }
  if (finished - started > 2000) {
    failure = "READBACK_TOO_SLOW"; failureCode = ERROR_TIMEOUT; goto done;
  }
  printf("{\"version\":1,\"kind\":\"windows_core_session_readback_v1\","
    "\"nonce\":\"%ls\",\"state\":\"OBSERVED\",\"humanApproval\":false,"
    "\"coreAuthority\":false,\"observedAtMs\":%llu,\"durationMs\":%llu,"
    "\"processId\":%lu,\"processCreationFileTime\":\"%016llx\","
    "\"tokenId\":\"%08lx%08lx\",\"tokenModifiedId\":\"%08lx%08lx\","
    "\"windowsUserSid\":\"%ls\",\"windowsSessionId\":%lu,"
    "\"windowsLogonLuid\":\"%08lx%08lx\",\"integrityRid\":%lu,"
    "\"elevated\":%s,\"activeConsoleSessionId\":%lu,\"localProtocol\":%s,"
    "\"sessionActive\":%s,\"windowStationInteractive\":%s,"
    "\"threadDesktopDefault\":%s,\"inputDesktopDefault\":%s}\n",
    nonce, now, finished - started, (unsigned long)GetCurrentProcessId(),
    filetime_value(created), (unsigned long)before.TokenId.HighPart,
    (unsigned long)before.TokenId.LowPart, (unsigned long)before.ModifiedId.HighPart,
    (unsigned long)before.ModifiedId.LowPart, sid, (unsigned long)tokenSession,
    (unsigned long)before.AuthenticationId.HighPart,
    (unsigned long)before.AuthenticationId.LowPart, (unsigned long)integrity,
    json_bool(elevation.TokenIsElevated != 0), (unsigned long)console,
    json_bool(protocol == 0), json_bool(state == WTSActive), json_bool(station),
    json_bool(thread), json_bool(input));
  if (sid) LocalFree(sid);
  if (current) CloseHandle(current);
  if (token) CloseHandle(token);
  return 0;
done:
  if (sid) LocalFree(sid);
  if (current) CloseHandle(current);
  if (token) CloseHandle(token);
  return unavailable(nonce, failure, failureCode);
}
