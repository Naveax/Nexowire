# QA19 / P0: independent Windows Job provider-truth negative acceptance

21 October 2026. Source-only review and disposable Windows TEMP fixtures.
Owner #19, separate from #03 implementation ownership. **DRAFT / NO MERGE / NO DEPLOY.**

## Exact source / CI baseline

| Source | Immutable head examined | What is actually proven |
| --- | --- | --- |
| #576 | \`a3946c1f25b8ba151baf945b5acacc7aafbd66c3\` | Existing Windows Job fast-exit suites pass; Job helper publisher and ACL fixture fail on hosted Windows |
| #638 | \`95304300649adfbcc0d7e58657fb5e17386f4959\` | Dedicated 100-cycle fast-exit/PID anti-spoof run [39625276215](https://github.com/Naveax/Nexowire/actions/runs/39625276215): 2 PASS, 0 FAIL, 0 SKIP. Inherited CI [39625275778](https://github.com/Naveax/Nexowire/actions/runs/39625275778): original Windows suite 36 PASS, 2 FAIL, 0 SKIP |
| #633 | \`c429ed9c7eb6de45c4c1ae8de67b528f940fe3ab\` | CI [39610643900](https://github.com/Naveax/Nexowire/actions/runs/39610643900) SUCCESS; **Hyper-V** helper trust uses native \`pwsh.exe\`, module-qualified Authenticode and .NET \`FileSystemAclExtensions\` ACL read |

Both original inherited red failures were in \`test/windows-job-helper-acl-publisher.test.ts\`, not stdout/stderr fast-exit:
* line 167: real signed Windows copy expected Authenticode \`Valid\`, observed \`UNAVAILABLE\`.
* line 216: synthetic parent Authenticated Users Modify expected \`true\`, observed \`null\`.

**Provider distinction:** \`UNAVAILABLE\` is lack of usable provider proof, NOT \`NotSigned\`, \`Valid\`, or production PASS; \`null\` parent grant is UNKNOWN, not a secure clean ACL.

## Source comparison / no unsafe cherry-pick

\`#633\`'s \`scripts/audit-hyperv-launcher-trust.ps1\` selects module-qualified Authenticode and \`[IO.FileSystemAclExtensions]::GetAccessControl\` for image and parent. \`#576\` / \`#638\`'s \`scripts/audit-windows-job-helper-trust.ps1\` uses module-qualified Windows PowerShell Security \`Get-AuthenticodeSignature\` and \`Get-Acl\`, with explicit fail-closed \`UNAVAILABLE\` / \`null\`. The scripts protect different surfaces. This QA does **not** cherry-pick a privilege-sensitive implementation or change either script; #03 owns that review and OS-provider remediation.

The Windows Job helper trust audit reports \`productionReady=false\` even for authentic OS-signed *unrelated* binaries, because no Nexowire publisher, signed installed/rollback manifest, protected running image or broker token is attested. The developer SHA-256 companion \`windows-job-owner.sha256\` is not a signed authority.

## New independent adversarial fixtures

Only added \`test/qa-19-windows-provider-truth.test.ts\` and an isolated CI workflow:

1. **Real provider vs unavailable provider**: copy the real Windows-signed \`powershell.exe\` into unique TEMP; a fresh \`pwsh.exe\` process obtains real Authenticode and .NET file/parent ACL observations, never caller-supplied JSON. Even with matching digest, an intentionally disabled WindowsPowerShell.Security module must yield \`UNAVAILABLE\`, unknown ACL, false \`publisherValid\` and never provisional/production trust. The test fails if independent OS validation unexpectedly cannot validate the signed copy; it does not synthesize success.
2. **Forged PASS**: a separate synthetic, deliberately unsigned TEMP \`.exe\` is never executed. Caller-defined fake \`Get-AuthenticodeSignature => Valid\` and \`Get-Acl => protected\` must not persuade the module-qualified audit to report a signed vendor or provisional approval.
3. **Protected DACL with unsafe parent**: only a freshly created TEMP tree receives \`Authenticated Users\` (\`S-1-5-11\`) inheritable Modify on its parent; its file DACL and parent are protected. Independent .NET native ACL inspection must observe the broad writable **parent** regardless of a protected leaf. The old Job helper audit may truthfully report \`true\` or \`null\`; it must never report \`false\` for that known unsafe parent, and can never accept the helper. This is not production ACL configuration.
4. **Stale manifest and attacker-paired digest**: edit test-created non-executable bytes after hashing; stale companion must not match. Then pair digest with altered bytes: companion may match again, but independently pinned original release digest remains false, unsigned image remains unsigned, and \`-Production\` must fail.

A whole-machine inherited AccessCheck, real installed Agent/Broker, publisher certificate provisioning, physical Windows Service ACL, UAC, signed rollback manifest, runtime FILEID/TOCTOU or external owner authority are **NOT** proven.

## Local reproducible command and acceptance

Only in an isolated source checkout on a Windows runner with Node 24 and \`pwsh.exe\`:

\`\`\`powershell
npm ci
npm run typecheck
node --test --test-concurrency=1 --import tsx test/qa-19-windows-provider-truth.test.ts
\`\`\`

Read actual stdout/stderr and run ID before marking PASS. Dedicated QA19 provider workflow is a separate signal; the inherited original full \`browser-live\` Windows suite must continue to run **without removal, skip, mock success, continue-on-error or rerun**. Never infer production readiness from QA PASS. Cross-PR integration owner #00 and Windows Job native owner #03 decide eventual integration.
