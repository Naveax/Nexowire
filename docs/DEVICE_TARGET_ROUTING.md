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
- `selected`: exact user-specified device, or implicit selection of the only eligible device **only when the owner explicitly enabled Auto**.
- `selection_required`: any unnamed device target while Auto is disabled, even with just one device; also multiple eligible devices regardless of Auto. Returns candidate devices and **all folders including empty folders**. A caller must ask for explicit device selection before mutations.
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

For unnamed requests, ask for explicit device selection by default, even if only one device exists. A folder name alone is not an explicit device selection. Auto can only be enabled by the signed-in owner through `POST /api/v1/me/device-selection/auto`, using the exact `AUTO DEVICE ACCESS` phrase and the `auto-device-selection-v1` confirmation header. D1 migration 0013 persists the owner preference; missing records mean OFF. Once enabled, the sole eligible device or sole device in a named folder can be selected, but two or more candidates **always** require explicit selection. The ChatGPT-facing MCP router has not yet been connected to these control-plane checks. A named offline device remains a resolved identity but must not be claimed connected.
