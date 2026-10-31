#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
#include <string.h>

/* Disposable Win32 FileId/rename-sharing diagnostic only.
 * No installed journals, tokens, services, ACLs or enrollment touched.
 * File identity probe is NOT an atomic SQLite checked-open attestation.
 */
typedef struct FILE_PIN {
    HANDLE handle;
    FILE_ID_INFO id;
} FILE_PIN;

static int close_pin(FILE_PIN *pin) {
    if (pin->handle != INVALID_HANDLE_VALUE) {
        CloseHandle(pin->handle);
        pin->handle = INVALID_HANDLE_VALUE;
    }
    return 1;
}

static int open_pin(const wchar_t *file, FILE_PIN *out) {
    FILE_ATTRIBUTE_TAG_INFO tag;
    BY_HANDLE_FILE_INFORMATION links;
    DWORD attrs = GetFileAttributesW(file);
    HANDLE h;
    out->handle = INVALID_HANDLE_VALUE;
    if (attrs == INVALID_FILE_ATTRIBUTES ||
        (attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        return 0;
    /* Attribute-only handles did not deny rename on the hosted Windows
     * runner. Acquire actual FILE_READ_DATA as well; omission of
     * FILE_SHARE_DELETE must be checked by the explicit rename negative.
     * This remains a disposable kernel diagnostic, NOT SQLite VFS handoff. */
    h = CreateFileW(file, FILE_READ_DATA | FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag)) ||
        (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
        !GetFileInformationByHandle(h, &links) || links.nNumberOfLinks != 1 ||
        !GetFileInformationByHandleEx(h, FileIdInfo, &out->id, sizeof(out->id))) {
        CloseHandle(h);
        return 0;
    }
    out->handle = h;
    return 1;
}

static int same_id(const FILE_PIN *a, const FILE_PIN *b) {
    return a->id.VolumeSerialNumber == b->id.VolumeSerialNumber &&
           memcmp(&a->id.FileId, &b->id.FileId, sizeof(a->id.FileId)) == 0;
}

static int mkfile(const wchar_t *path) {
    static const char data[] = "NEXOWIRE_DISPOSABLE_FILE_ID_ONLY";
    DWORD wrote = 0;
    HANDLE h = CreateFileW(path, GENERIC_WRITE,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    BOOL ok;
    if (h == INVALID_HANDLE_VALUE) return 0;
    ok = WriteFile(h, data, (DWORD)(sizeof(data) - 1), &wrote, NULL);
    CloseHandle(h);
    return ok && wrote == (DWORD)(sizeof(data) - 1);
}

static int join(wchar_t *out, size_t length, const wchar_t *dir, const wchar_t *name) {
    return swprintf_s(out, length, L"%ls\\%ls", dir, name) > 0;
}

static int selftest(void) {
    wchar_t tmp[MAX_PATH] = {0}, dir[MAX_PATH] = {0}, paths[3][MAX_PATH] = {{0}};
    wchar_t changed[MAX_PATH] = {0}, linked[MAX_PATH] = {0};
    const wchar_t *names[3] = {L"operations.sqlite", L"operations.sqlite-wal",
                               L"operations.sqlite-shm"};
    FILE_PIN pin[3] = {{INVALID_HANDLE_VALUE, {0}}, {INVALID_HANDLE_VALUE, {0}},
                       {INVALID_HANDLE_VALUE, {0}}};
    FILE_PIN reopened = {INVALID_HANDLE_VALUE, {0}};
    int pass = 0;
    const char *stage = "temp-directory";
    DWORD failed_win32 = 0;
    unsigned int i;
    DWORD n = GetTempPathW(MAX_PATH, tmp);
    if (n == 0 || n >= MAX_PATH) goto done;
    stage = "reserve-disposable-directory";
    if (!GetTempFileNameW(tmp, L"NXJ", 0, dir)) goto done;
    stage = "create-disposable-directory";
    if (!DeleteFileW(dir) || !CreateDirectoryW(dir, NULL)) goto done;
    if (!join(changed, MAX_PATH, dir, L"operations.renamed") ||
        !join(linked, MAX_PATH, dir, L"operations.hardlink")) goto done;
    for (i = 0; i < 3; i++) {
        stage = "create-db-wal-shm-test-file";
        if (!join(paths[i], MAX_PATH, dir, names[i]) || !mkfile(paths[i])) goto done;
        stage = "pin-native-file-id";
        if (!open_pin(paths[i], &pin[i])) goto done;
    }
    /* A second open must identify the same kernel-owned file object. */
    for (i = 0; i < 3; i++) {
        stage = "reopen-same-kernel-file-id";
        if (!open_pin(paths[i], &reopened) || !same_id(&pin[i], &reopened))
            goto done;
        close_pin(&reopened);
        /* No FILE_SHARE_DELETE on the pin: ordinary rename must fail. */
        stage = "deny-rename-while-file-pinned";
        if (MoveFileExW(paths[i], changed, MOVEFILE_REPLACE_EXISTING)) goto done;
        stage = "verify-original-path-after-denied-rename";
        if (GetFileAttributesW(paths[i]) == INVALID_FILE_ATTRIBUTES) goto done;
    }
    for (i = 0; i < 3; i++) close_pin(&pin[i]);
    /* Hardlink alias makes a path-only trust claim invalid. */
    stage = "create-hardlink-alias";
    if (!CreateHardLinkW(linked, paths[0], NULL)) goto done;
    stage = "deny-hardlink-alias";
    if (open_pin(paths[0], &reopened)) goto done;
    pass = 1;
done:
    /* Capture the error before cleanup calls overwrite GetLastError().
     * Stage values are fixed literals, never disk paths or identities. */
    failed_win32 = GetLastError();
    close_pin(&reopened);
    for (i = 0; i < 3; i++) close_pin(&pin[i]);
    DeleteFileW(linked);
    DeleteFileW(changed);
    for (i = 0; i < 3; i++) DeleteFileW(paths[i]);
    RemoveDirectoryW(dir);
    if (pass) {
        puts("NEXOWIRE_DISPOSABLE_KERNEL_FILE_ID_PROBE_PASS (NOT SQLITE/CORE AUTHORITY)");
        return 0;
    }
    fprintf(stderr,
        "NEXOWIRE_DISPOSABLE_KERNEL_FILE_ID_PROBE_BLOCKED stage=%s win32=%lu\n",
        stage, (unsigned long)failed_win32);
    return 2;
}

int wmain(int argc, wchar_t **argv) {
    if (argc != 2 || wcscmp(argv[1], L"--selftest") != 0) {
        fputs("Selftest-only. No arbitrary journal paths accepted.\n", stderr);
        return 2;
    }
    return selftest();
}
