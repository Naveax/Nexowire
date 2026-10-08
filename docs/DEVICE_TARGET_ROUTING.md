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

The hosted MCP router now consumes the **same OAuth account-bound authorization**
from `/api/v1/internal/mcp/authenticate`. The service-authenticated endpoint
supplies the current owner AUTO preference, account device IDs/names and folder
memberships; the MCP hub validates returned names and ownership against the
live provider registry. The OAuth authorization is checked on **every POST /mcp**,
so disabling AUTO affects the next request without restarting the Hub.

MCP behavior:
- AUTO **off**: a task without a specific device is denied, even if exactly one device is registered. Exact owner device IDs or unique owner device names can be used explicitly.
- AUTO **on**: an unnamed task is allowed only when exactly one device belongs to that OAuth account and that device is online. Two provisioned devices still require a choice even if one is offline.
- A named folder is routed with the existing `device_id` argument using `folder:Maxi`, **only with AUTO on** and only when that folder has exactly one authorized online device. Empty folders, duplicate names, unknown folders and cross-account names fail closed.
- Local static, stored-credential, and external OIDC grants **do not inherit** the owner's website AUTO preference. A non-hosted identity still requires an explicit device target.
- A service token authenticates the private Worker-to-Hub lookup only; it does not itself enable routing or grant Windows admin privileges.

**Deployment note:** This behavior requires BOTH the updated Cloudflare Worker and a newly released/restarted MCP Hub with this routing code. Merging source or deploying Worker assets alone does not update an already running v1.0.0/v1.0.5 Hub. The current live Hub must be verified independently before describing AUTO as active for ChatGPT.

For unnamed requests, ask for explicit device selection by default, even if only one device exists. A folder name alone is not an explicit device selection. Auto can only be enabled by the signed-in owner through `POST /api/v1/me/device-selection/auto`, using the exact `AUTO DEVICE ACCESS` phrase and the `auto-device-selection-v1` confirmation header. D1 migration 0013 persists the owner preference; missing records mean OFF. Once enabled, the sole eligible device or sole device in a named folder can be selected, but two or more candidates **always** require explicit selection. The updated MCP router consumes these owner-scoped checks **after the new Hub release is deployed**. A named offline device remains a resolved identity but must not be claimed connected.
