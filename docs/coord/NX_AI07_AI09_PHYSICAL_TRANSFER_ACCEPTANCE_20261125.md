# AI-07 -> AI-09 physical 1–4 GiB transfer acceptance handoff

Status: NOT_RUN. AI-09 owns real device acceptance; no physical action is authorized by this document. Do not execute until the coordinator explicitly approves the exact integrated signed candidate, two enrolled test devices, a dedicated disposable owner/project grant, protected roots and a recovery/STOP plan. Never use the user's ordinary production files/grant or weaken ACLs, DPAPI, TLS, native owner consent, signer pins or observer requirements.

## Prerequisites (record evidence, not assertions)

- Exact integrated HEAD/release manifest, approved Authenticode signer and SHA-256 of the installed flush helper on the target; source/target identities and generation/epoch; actual protected publisher startup through the single AI-07 launcher and independently issued runtime selection lease. No pre-login owner capabilities.
- Strict Hub/AgentBroker and protected authority service listeners: verify real TLS peer pins and enrolled roles; independent CORE/native completion policy, helper selection RELEASE observer and real transfer readback. Keep private keys and bearer credentials out of screenshots, logs and receipts. A test certificate or synthetic observer is not physical acceptance.
- Both devices online, authorized full access for the disposable project only. Verify the approved canonical source and protected target/stage/receipt roots, correct device IDs and same-volume staging/publication. Refuse pre-existing destination, unexpected reparse points or insufficient disk capacity. Allocate at least 8 GiB free on each participating volume for the 4 GiB case plus actual DB/log overhead; recheck before each case. Do not touch physical state if any prerequisite is UNKNOWN.

## Non-sparse fixture (AI-09 only, approved disposable source root)

Create new files, not sparse/truncated or preallocated zero-range placeholders. The following is an inert fixture generation example for a specifically approved existing directory. Run with the authorized test identity only; never overwrite a path.

```powershell
param(
  [Parameter(Mandatory=$true)][string]$ApprovedSourceRoot,
  [Parameter(Mandatory=$true)][ValidateSet('1GiBPlusOne','4GiB')][string]$Case
)
$ErrorActionPreference = 'Stop'
$size = if ($Case -eq '1GiBPlusOne') { [long]1073741825 } else { [long]4294967296 }
$root = Get-Item -LiteralPath $ApprovedSourceRoot
if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Source root invalid' }
$file = Join-Path $root.FullName ("ai09-transfer-" + [guid]::NewGuid().ToString() + ".bin")
$buffer = New-Object byte[] (1MB)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$stream = [IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try {
  [long]$remaining = $size
  while ($remaining -gt 0) {
    $rng.GetBytes($buffer)
    $n = [int][Math]::Min([long]$buffer.Length,$remaining)
    $stream.Write($buffer,0,$n)
    $remaining -= $n
  }
  $stream.Flush($true)
} finally {
  $stream.Dispose()
  $rng.Dispose()
}
$item = Get-Item -LiteralPath $file
if ($item.Length -ne $size -or ($item.Attributes -band [IO.FileAttributes]::SparseFile)) { throw 'Fixture invalid' }
[pscustomobject]@{ Path=$item.FullName; Bytes=$item.Length; SHA256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
```

The script does not grant access, alter ACLs, start services, revoke anything, or send a transfer.

## Exact cases

1. 1 GiB + 1 byte (1073741825 bytes), full cross-device transfer; 4 GiB (4294967296 bytes), separate job/path. Use enrolled source and target IDs and source/target path in `large_file_transfer_start`. Record original transfer UUID, bytesTotal, SHA-256 and revision.
2. Call `large_file_transfer_advance` sequentially with the same source_device_id, target_device_id, transfer_id, max_chunks <= 256. Each call has bounded 15-second inter-step budget; 64 KiB chunks imply 16,385 and 65,536 writes respectively. No overlapping advance workers or blind retries. Record progress/offset, memory and timestamps (measure throughput, no invented SLA).
3. At an AI-09-approved controlled lost ACK after durable write, inspect `large_file_transfer_status`. UNKNOWN/PUBLISHING/WRITE_PENDING is never success. Stop advancing and use `large_file_transfer_recover` only against the original ID and fresh independent readback; verify original claim ID, prefix hash, epoch fence, and exact resumed offset. If recovery is not independently proven, stop; do not delete staging or replay write/publish.
4. Completion requires COMPLETE, exact bytesConfirmed=bytesTotal, source SHA before/after and independent target SHA equal, exactly one final publication, original request ID/epoch/commit ID, Ed25519 receipt checked against enrolled target key, no duplicate destination or abandoned unexpected staging, no overwrite. Capture durable claim/receipt history with secrets removed.
5. Separate disposable grant cases: clean graceful STOP -> process returns -> independently signed exact lease RELEASE -> durable RELEASED; unresolved ACTIVE/UNKNOWN (including uncertain callback) -> no automatic RELEASE, retain original lease and claim; controlled revoke -> durable REVOKING fence before new admissions, no new effects, bounded independent native drain and terminal completion proof; if uncertain preserve REVOKING and use only AI-03 protected reconcileRevoking with new owner approval. Never infer revoke from UI STOP or a closed socket.
6. Preserve logs, read-only DB evidence, exact installed helper hashes and signature status, independently observed native process/handle/job-object/effect evidence, final receipt, timestamps, both device identities. Record every fail/skip/unknown. Cleanup only specifically created disposable fixtures after coordinator approval and reconciliation, never cleanup uncertain staging or durable tombstones.

## Acceptance record

Exact integrated HEAD, signed release manifest hash; AI09 operator approval; device pair and scoped owner/project (redact personal data); test case and size; source/target hashes; original job/claim/request/epoch/commit; native observer key pin/receipt verification outcome; source and destination bytes; progress/time; final state; drain/RELEASE evidence and retained lease on failure; cleanup authorization. A hosted sparse hash, loopback WebSocket, actual disposable PostgreSQL, or synthetic signed observer alone is NOT physical 1–4 GiB acceptance.

AI03 must supply protected native incarnation/terminal-effect/drain observer and signing custody. AI05 owns installed helper selection/rollback guard. AI08 verifies exact fixture pins. AI00 owns promotion. AI07 does not perform physical changes.
