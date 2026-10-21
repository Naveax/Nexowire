# Nexowire #12 CORE signed import DAG and offline re-pair source acceptance
2026-10-21 | own staged child of #672 | PRODUCTION NO-GO

## Independent QA reviewed
Worker #20 PR #655 HEAD e258e8eb8a8132f75d350a820da816dfd3f0fa07 exact CI #39630947296 FAILURE overall. Node22/24 tests including 12 new QA source tests PASS; browser-live Windows Job pipe/stdout regression FAILED, inherited from Windows Job owner. No cross-owner Job code modified or suppressed.
Worker #28 PR #658 HEAD c643222692e5f3130b0fc5f90886b1a2fa0dbff3 exact CI #39630933999 SUCCESS, four synthetic adverse cases: mid-copy signed installer, foreign-signed old Agent1.0.5 rollback, protected updater/parent ACL, offline stale DPAPI and UNKNOWN task.
Parent #672 exact HEAD 84714bb77ec00a8e79ebb732c1070dda1a331975 GitHub CI #39632489293 SUCCESS.

## Owner source implementation
scripts/s3-core-broker-install-gate.ts:
- Second independently Ed25519 signed Windows import DAG, with pinned out-of-band key and canonical graph SHA256 linked to the original independently signed protected stage manifest SHA256.
- Every staged executable is a graph node; DLLs and resources must be transitively reachable from one of installer/Broker/helper/updater/signed old rollback entrypoints. Extra, missing, duplicate, unknown or unreachable imported files fail closed.
- Native readback DAG is checked for exact edge equality and completion, no unverified Windows system dependencies or missing signed image-handle records. Even a fixture labelled trusted native provider is not independently authenticated OS evidence.
- Re-runs exact Publisher Subject, certificate DER SHA256 and file SHA256 Authenticode signature gate for all PE files, protected ACL/ancestors/import/update paths, reparse/hardlink/volume identity inventory.

scripts/s3-core-bootstrap-delegation-audit.ts:
- Offline re-pair requires separately authenticated monotonic owner epoch, old task disabled/deleted readback, inaccessible revoked old DPAPI key, old rollback signature, independent journal and no UNKNOWN mutation.
- New owner transaction/DPAPI blob must differ from old ones; approved new Windows owner UAC is required by the previous source enrollment contract, not manufactured by this module.
- Source-only full fixture acceptance ALWAYS returns canInstall:false, canExecuteElevated:false, productionAccepted:false.

Tests add signed DAG forgery/omission/extra edges, import closure, native graph readback mismatch, stale DPAPI key, still-running task, UNKNOWN recovery, stale external CAS/re-pair and reused old UAC transaction.

## Physical acceptance gaps
No actual first-party Nexowire native Authenticode signed installer/Broker/helper, complete signed Agent1.0.5 rollback, trusted native PE import resolver+process-handle attestation, real SYSTEM DPAPI owner-key protection, independently non-restorable CAS witness, protected atomic installer cutover or physical Windows UAC approval. No isolated Windows VM crash/reboot/rollback test.

CORE UX target: ONE genuine Windows owner-approved UAC enrollment of trusted protected elevated Broker, then authenticated CORE requests without per-command UAC using that verified Broker, not a generic privileged shell or Secure Desktop click.

P0 #271 live legacy ProgramData executable/import parent still inherits Authenticated Users Modify and remains production NO-GO. No live Agent, Broker, installer, service, ACL, UAC, DPAPI or VM mutation, no #596/#608 deployment.
