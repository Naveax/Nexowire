# Connection Core v2 — Cloudflare + owner PC + ChatGPT

## Topology and actual scope

No VPS, Tailscale, inbound router port, custom relay server or Durable Object
is required by this route. The owner PC runs the existing authenticated Hub
and Agent, a loopback MCP-only origin, and the official cloudflared connector.
ChatGPT HTTPS reaches a stable Cloudflare named-tunnel hostname. cloudflared
initiates the connection from the PC. Cloudflare account/DNS ownership and
the tunnel credentials must be genuinely provisioned; a source change cannot
create that evidence. This is not WebRTC P2P and does not claim zero provider
cost or unlimited traffic. Local Hub/Agent must already be running.

`nexowire local-first cloudflare-run <absolute-profile.json>` now starts the
origin and the hash-pinned connector together. QUIC/HTTP2 negotiation and
network reconnect belong to official cloudflared (`--protocol auto`). If its
process exits, the supervisor stops only its own origin and reports failure;
it never blindly retries mutations or silently switches to Tailscale.

## Local profile

Example only; none of these values provision an account or tunnel:

```json
{
  "version": 1,
  "hostname": "mcp.your-owned-domain.example",
  "tunnelId": "11111111-1111-4111-8111-111111111111",
  "credentialsFile": "C:\\Users\\OWNER\\.cloudflared\\TUNNEL-ID.json",
  "binary": "C:\\Users\\OWNER\\Nexowire-tools\\cloudflared.exe",
  "binarySha256": "4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6",
  "listenPort": 43111
}
```

The example Windows hash is the official cloudflared 2026.10.1 amd64 digest,
independently read from the Cloudflare release API. Update the binary and pin
together after review. Keep the existing locally-managed tunnel credential
JSON private to the owner, outside the repository. Do not paste it into chat,
logs or command-line arguments. The supervisor reads it only to validate the
selected tunnel, and passes its filename to cloudflared through a temporary
config. It does not duplicate the secret.

Use the existing Hub configuration with matching `NEXOWIRE_MCP_RESOURCE_URL`
(`https://<hostname>/mcp`), `NEXOWIRE_CONTROL_PLANE_URL` and protected service
token source. Verify the existing Hub's actual OAuth/resource health before
the connector starts. The hosted control plane must also advertise the new
MCP resource in its real OAuth configuration. No example is a live endpoint.

The generated local cloudflared configuration has exactly one hostname and
only `/mcp` plus the two protected-resource metadata paths, targeting
`http://127.0.0.1:43111`; a final 404 rule rejects everything else. The existing
origin independently blocks `/agent`, admin, arbitrary paths, WebSocket
upgrades, unauthenticated MCP POSTs, inappropriate Host/Origin and excessive
bodies. It forwards only to the fixed local Hub, which retains OAuth,
owner/device authorization and metering. The tunnel grants no CORE authority.

## Active Agent authorization

The Hub now revalidates already-open Agent WebSocket sessions every 60s by
default, with a 5s verification deadline. A rejected, remapped, inaccessible
or timed-out remote credential terminates the socket. Dynamic local stored
credentials are also rechecked. Original local/remote/anonymous trust mode
cannot change during revalidation. Static configured tokens require a config
change/restart to rotate as before. This is bounded revocation (default at
most approximately 65s plus event-loop scheduling), not instantaneous revoke
or cancellation of native work already dispatched. Existing journal/UNKNOWN
reconciliation remains authoritative. At scale, periodic verification adds
control-plane requests and must be included in capacity measurements.

Initial remote authorization is bounded too, even if a custom verifier
ignores AbortSignal. Socket close cancels the real control-plane fetch.
Late success cannot revive a timed-out handshake or a replacement session.

## #402 direct launch review

One new direct `spawn` sink: `src/mcp/local-first-cloudflare.ts`.
Only explicitly selected absolute, bounded regular binary files whose SHA256
matches the owner profile may run. Arguments are fixed except for validated
UUID and generated config pathname. No shell, inherited proxy/loader/TUNNEL
environment, stdin, raw command-line secret, GUI or unbounded subprocess log.
Child environment is allowlisted; self-update is disabled. Shutdown signals
only the child created by this supervisor, with bounded forced termination.
This is an owner-launched headless process, not an OS sandbox or a Broker
privileged install. `windowsHide` is not an isolation claim. The reviewed
single sink was added to the existing launch audit baseline; the audit is
not disabled, and other unchanged sinks are not thereby proved isolated.

## Evidence and remaining live gates

Local targeted group: 49/49 passed, including a real official Linux
cloudflared 2026.10.1 binary (SHA256
`3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586`).
Its actual parser accepts generated JSON/YAML configuration and matches
`/mcp` to rule 0 and `/agent` / wrong hostname to the deny rule. No account,
public tunnel or DNS route was created for these tests. Windows CI downloads
and pins the official Windows executable and must run the same parser proof.
Other tests exercise real local HTTP/WebSocket sockets, persisted credential
revocation, timeout/late response, fault/reconnect isolation, failed connector
cleanup and continued availability of the original Hub. These are not live
ChatGPT OAuth or off-network proofs.

Before switching the current connector: provision/recover the owner's real
Cloudflare named tunnel + hostname + credential, configure matching OAuth
resource, verify the deployed build and user-logon startup on the PC, then
prove off-network ChatGPT tools, actual disconnect/reconnect and reboot,
two-PC routing, revocation and no duplicate mutation. Retain the current
route for controlled recovery until acceptance succeeds. Never rewrite a
working Agent identity, journal, Broker credential or Tailscale route merely
to run this command. P2P remains a separate optional future transport; this
Cloudflare-only ingress requires none.

Official references:
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/
- https://github.com/cloudflare/cloudflared/releases/tag/2026.10.1
