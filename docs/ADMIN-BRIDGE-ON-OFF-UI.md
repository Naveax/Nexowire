# Admin Bridge ON/OFF control – owner dashboard

The existing three small AUTO / AÇ / KAPAT controls were hard to notice and did not match ROOT/CORE interaction patterns. This change adds a **visible ON/OFF control** without weakening privilege boundaries.

## Updated interface
- Each device card header has a clearly labeled `BRIDGE ON/OFF/AUTO` quick button alongside CORE. Clicking it switches **ON ↔ OFF desired preference** with one click. Clicking from AUTO chooses ON.
- `PC Settings → ADMIN BRIDGE` includes a large, keyboard-accessible switch with a visible thumb and explicit ON/OFF/AUTO text, and a separate AUTO MOD button. Both controls act on the **same owner/device record**, not browser local storage.
- The selected saved preference is hydrated from the dashboard response after every write. In-flight controls are disabled and server errors are displayed without pretending success. Keyboard focus is restored to the chosen control after refresh.
- The live Broker readiness indicator is deliberately separate from the chosen owner preference. Status text states that the **actual Windows Broker service is NOT being toggled yet** by the UI, regardless of ON/OFF selection.
- Choosing OFF revokes any saved CORE preference. This is existing server-side safety behavior, now explained beside the switch. A quick button is not a way around ROOT/CORE grants, OAuth, Windows UAC or the Agent's privilege policies.

## Security boundary and rollout

The buttons call the *existing* owner-authenticated `POST /api/v1/me/devices/bridge-preference` endpoint with `X-Nexowire-Confirm: bridge-preference-v1`; the API has always returned `applied:false`. This is **not a real Windows task start/stop** operation. No attempt is made to call the default-disabled `bridge-command` endpoint, replay a previously selected preference, or route privileged commands through a generic Windows capability.

Live ON/OFF actuation requires the independently installed, protected Guardian available when Broker OFF, secure enrollment and attested Guardian receipts, durable replay protection, and verified local permission boundaries. P0 #271's existing elevated user-writable Stack is still a production blocker. Do not claim this UI deploy enables Windows administrator rights.

This PR modifies only dashboard assets and UI tests. No live Agent, OS task, Cloudflare secrets or D1 migration changes are required by the source change.
