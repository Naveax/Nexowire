# Owner-scoped device target resolution

This endpoint prepares a **device selection**, not a remote command or a permission grant.

## API

`POST /api/v1/me/devices/resolve-target`

Requires a real owner login, an `application/json` body and
`X-Nexowire-Confirm: device-target-v1`. The authenticated account's
devices and folders are loaded by the service, not accepted from request payloads.

Example requests:

```json
{"deviceName":"Naveax"}
```

```json
{"folderName":"Maxi"}
```

```json
{}
```

The response is one of:
- `selected`: exact device, a folder with exactly one device, or the sole device of the account.
- `selection_required`: multiple eligible devices; returns the account-owned devices and **all folders including empty folders**. A caller must ask the user to choose an exact device before attempting any mutation.
- `empty_folder`: the folder exists but has no device; never fall back to another folder.
- `no_devices`: no eligible devices.

Device and folder names are normalized with NFKC and case-insensitive exact matching; no fuzzy first-match routing. When supplied, both a device and folder must match the same assignment. The target response includes the device's online state, which must be checked again at dispatch time.

## Scope and limitations

This is a read-only, deterministic **Cloudflare control-plane resolution API**.
It does not execute work, grant access, bypass SAFE/FULL/ROOT, or cause remote
process changes. Folders are owner-scoped and include empty folders.

Integration into the separate ChatGPT-facing Nexowire MCP `devices_list`/router
is not implemented by this endpoint. That integration must bind the
authenticated owner to the correct control-plane account, validate the returned
device ID against the live Nexowire device registry and require an explicit
selection when the result is ambiguous. In particular, it must not use a
workspace-local folder name as proof of device ownership.

Prefer asking even for two ambiguous devices. If a folder contains exactly one
eligible device, no additional selection is needed. A named offline device
remains a resolved identity but must not be claimed connected.
