# AI Screen P0 #402: independent Windows security-boundary acceptance

**Stack:** source PR #579 `39d0d7bcf614194ec10a76d849a89e1066a3c52f` (exact-head GitHub CI run #39283586127 **7/7 SUCCESS**); this independent test-only branch is based on that exact head. #570 is already MERGED. Original #480 stays OPEN/DRAFT but its broker-deny patch `f9c37df006c1b068b63b79983e4f2129f6a8dce4` reports **patch-equivalent already in main** using read-only `git cherry -v origin/main origin/fix/ai-screen-direct-bridge-broker-guard-20261014`. Do not blindly merge #480 or reimplement #570.

## Test boundary matrix

| Gate | Grounded evidence | Status |
| --- | --- | --- |
| Generated private helper SHA-256 | Disposable Work PC private desktop. Same-byte-count replacement of `input-helper.ps1` refuses with `PRIVATE_DESKTOP_INTERNAL_HELPER_INTEGRITY`, absent `helper.ps1` refuses window/status operations | Physical PASS for pre-dispatch byte check |
| Authenticode / trusted native publisher / immutable handle | No signed immutable native binary, protected code signing chain, non-writable ACL and atomic file handle identity demonstrated | BLOCKED |
| Current foreground vs private desktop | WPF shell PID/HWND observed on `NexowirePrivate`, not in `windows.window.list` for owner Default; private window HWND differs from observed Default foreground. InputDesktop returned Default | Physical PASS at observed instants; no owner-active long soak |
| Windows modern Common Item Dialog | Prior independent private WinForms OpenFileDialog `AutoUpgradeEnabled=true` test: 52 semantic Edit and 4 Button nodes, same private PID and Windows session, no click or input | Read-only physical PASS; native semantic control identity/positive file acceptance BLOCKED |
| Cross-PID Explorer/COM picker | Adapter insists on tracked PID, unchanged HWND/session and unambiguous class/AutomationId; cross-process mutations are unsupported | Synthetic negative PASS; general Explorer/COM integration BLOCKED |
| CMD /C, PowerShell -Command, WSL/WSLg/Windows Terminal | #570 deny guards, #579 7/7 CI and Work PC direct isolated regression. Ordinary script wrappers cannot borrow untrusted GUI path | Known named vectors PASS; arbitrary compiled/native/COM children BLOCKED |
| Grant/HWND/PID/session | Adversarial adapter tests: foreign-node PID, duplicate button, HWND recycled, PID changed, session changed, desktop generation changed must refuse before UIA mutation | 6 independent negative cases PASS |
| UAC / secure desktop | Inject Winlogon/SecureDesktop/UAC/empty/non-Default into status, and transition after edit; no native Invoke after transition, grant invalidated | Synthetic negative PASS; **actual secure desktop not triggered** |
| Cancel and emergency stop | Explicit cancel invalidates grant; existing #579 tests confirm emergency stop prevents further UIA, races do not replay mutation | Negative PASS; real owner-active races require soak |
| Helper process and file handle ownership | Hash checks generated script before dispatch; #579 Edge cleanup enforces process/profile ownership | Source/isolated PASS; script substitution TOCTOU/native signed Job identity BLOCKED |
| Big-file selection and streaming | `windows.private_desktop.file_picker.select` passes **authorized local file path** only; it does not upload bytes to clipboard/DOM/one browser input. #08 ingest `artifact_bridge_ingest_device_file` sends bounded 65536-byte chunks, at most 32 chunks per call; current code rejects source files over **268435456 bytes (256 MiB)** | Integration contract observed in source; end-to-end UI-to-chunk API not yet physical-tested; no infinity claim |

## Independent physical test scope

The new test `test/private-desktop-helper-trust-physical.test.ts` runs only on real Windows inside a temporary `NEXOWIRE_PRIVATE_DESKTOP_DIR`, with shortcut disabled. It creates/stops only its own WinSta0\\NexowirePrivate process and temporary files. No interactive switching, UAC prompting, Default foreground clicks or user mouse/keyboard actions. `test/private-desktop-adversarial-acceptance.test.ts` injects fail-closed state changes and asserts that no private edit or invoke reaches the dispatch after invalidation. The second file runs in Windows `browser-live` CI.

**Meaning of PASS:** no unobserved action is claimed completed. Physical observations apply only to the time measured. No real UAC secure-desktop switch was initiated; no Explorer cross-process file dialog was clicked. The private WPF test's positive selection is a disposable fixture, not broad Windows File Open compatibility. The user's live v1.0.5 Agent/Hub and main are unchanged.

**Acceptance blockers:** non-exportable signed helper trust, protected ACL plus Windows handle/file-ID binding through script execution, kernel Job/session provenance including COM children, atomic HWND and focus checks, genuine UAC/secure-desktop negative acceptance in a separate VM/session, real 2nd display/user-active soak and #08 chunk UI consumer end-to-end test. Fail closed where unsupported. This is a **DRAFT test acceptance PR**, not permission to merge production.
