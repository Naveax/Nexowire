# Signed CORE runtime candidate manifest

The supplied `Nexowire-v1.0.7-Broker-Yerel-Kurulum.zip` was statically inspected,
not executed. Its SHA-256 remains
`9eedebb0993ecee591fa664ce9c74850d19ed09853ffe2f4a52fb5367cb61fab`.
Its Authenticode check verifies the OpenJS Node runtime, not a Nexowire publisher
signature over the application/import tree. The original uploaded helper and
all installed files are unchanged. It is not an officially signed installer.

`verifyCoreRuntimePackageCandidate` adds the missing source component for an
exact Nexowire-owned signed payload manifest. A separately pinned Ed25519 key
signs domain-separated canonical bytes containing repository/source SHA,
release version/sequence, parent manifest hash, required source entrypoint and
the exact sorted file-size/SHA-256 inventory. A Node-only signature/hash cannot
stand in for this manifest. A signature fixture does not provision a publisher.

The verifier rejects absent/unavailable independent release anchor, unknown
publisher, wrong source/entrypoint, downgrade, sequence jump, parent mismatch,
case/ADS/Windows reserved-name/traversal aliases, symlinks, hardlinks, changed or
missing code, unlisted files, noncanonical JSON and identity changes during
verification. Files are hashed through held descriptors with bounded buffers
and size/count limits. The original trust pins are captured before awaiting;
the anchor and file/directory identities are rechecked after asynchronous work.

This is candidate inspection, not an atomic executable loader. Namespace and
write races require native held-image/file identity and a protected installed
ACL chain at the real execution boundary. No inspection over mutable paths can
replace that. Nor can a naked supplied anchor object authenticate itself: the
callback must be a protected, authenticated, rollback-independent readback.
No production callback, service, signing key or credential is created here.

The function never advances an anchor, installs/executes code or grants CORE.
Results explicitly say Authenticode publisher NOT verified, protected ACL NOT
verified, runtime NOT installed, physical acceptance NOT_PROVEN and CORE NO_GO.
The existing installer/update paths are not rewired or silently approved.

Still required: actual Nexowire publication identity/certificate and protected
signing custody; independent anti-rollback anchor and atomic release acceptance;
signed official installer/manifest/artifact provenance; native exact image and
ACL/token readback; staged release and interrupted-update/rollback acceptance
on both actual PCs. Existing physical and UNKNOWN/replay gates stay closed.
