# Verified elevated Windows installer jobs

This is an **optional, pre-authorized** way for an authenticated Nexowire owner in FULL mode to run one specific installer with the existing elevated Windows Privileged Broker. It does **not** click `consent.exe`, bypass Secure Desktop, disable UAC, grant permanent arbitrary admin shell rights, or implicitly approve third-party installers.

## Trust boundaries

1. **Local administrator preapproval is mandatory.** The administrator places an approval file at `C:\ProgramData\Nexowire\installer-approvals.json`, owned by `SYSTEM` or `Administrators`, with non-inheriting ACL entries **only** for those two principals. The native user agent is not permitted to create or edit that file. Without it, every installer request fails closed.
2. An approval pins an exact **SHA-256**, exact ordered argument vector, whether an unsigned installer is allowed, and an optional expected Authenticode signer certificate thumbprint. Signatures are required unless `allow_unsigned: true` is explicitly approved by the administrator **and** requested by the owner.
3. The installer source must be a regular local file inside the current user's profile, at most 2 GiB, and with extension `.exe`, `.msi`, `.ps1` or `.cmd`. Symlinks, UNC paths, changed file bytes, or extra parameters fail validation.
4. The Broker hashes the original file, checks administrator policy, copies it to a SYSTEM/Administrators-only per-job directory under `C:\ProgramData\Nexowire\verified-installers\<job-id>`, then re-hashes the protected copy. The protected helper checks the staged hash and Authenticode again immediately before launching.
5. Only an owner-authorized **FULL** request may invoke `windows_installer_apply`. SAFE mode denies the operation, even with a reachable Broker. The MCP operation additionally requires the admin tool role when role-based authorization is enabled. `windows_installer_status` is read-only but still routed through the Broker.
6. The already elevated Broker launches the pinned helper in the background with a bounded timeout. No new UAC prompt is required **when the existing Broker is online and the installer is approved**. The API returns `queued` plus a job ID, **not** an installation success claim. The job records `running`, `succeeded` or `failed`, exit code and reboot-needed flag. Exit code 3010 marks reboot-needed; it does not initiate a reboot.

## Example administrator approval file

This is **illustrative**. Substitute hashes and arguments actually verified by the administrator and provision under a protected administrator-controlled path. Do not put arbitrary hashes in this file automatically from user requests.

```json
{
  "version": 1,
  "approvals": [
    {
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "arguments": ["/quiet", "/norestart"],
      "allow_unsigned": false,
      "publisher_thumbprint": null
    }
  ]
}
```

`publisher_thumbprint` may be a 40-character hex thumbprint where an exact signer is required. For MSI packages, the runner always uses `msiexec /i <staged-file> /qn /norestart`. Do not assume a silent mode exists for every third-party `.exe`.

## Nexowire MCP interface

- `windows_installer_apply`: `device_id`, `file_path`, `sha256`, optional `arguments`, `allow_unsigned`, `publisher_thumbprint`, `timeout_seconds`, and optional `idempotency_key`. Response: `scheduled`, `jobId`, `state: queued`, `expectedSha256`.
- `windows_installer_status`: `device_id`, `job_id`. Response: the status file for that job, no credentials or elevated console.

**Out of scope:** arbitrary unapproved executables; accepting unsigned installers by default; preventing the operating system from presenting UAC for *other* installers launched outside this specific Broker operation; observing a secure-desktop UAC dialog as though it were a normal window; unattended auto-reboot, blanket full-disk privileges, rollback of arbitrary third-party installers, or cross-user admin requests.

## Status and release gates

This source feature requires GitHub PR review, CI and Windows regression, official immutable release authorization, guarded Broker + native Agent deployment, and a live elevated/authorized canary test. A non-elevated temporary `.cmd` smoke test passing does **not** establish elevated install behavior. The current work-pc v1.0.4 and Naveax v1.0.3 do not contain this feature; an already-open `consent.exe` prompt on an unrelated installer is not retroactively dismissed.

Default behavior remains safe: no approval file means **no elevated third-party execution**.
