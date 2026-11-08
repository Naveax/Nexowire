# #539 R18 — Turkish state vocabulary and empty-dashboard collision (T-375)

Source base: `Naveax/Nexowire main@4e7db16f4233048a956664bef6b607781eb63fb7`.
This is **source-only** read-only QA. `web/app.js` and `web/connect.js` are
owned by the UI integrator [#1068](https://github.com/Naveax/Nexowire/pull/1068)
and were **not** edited. The complete, machine-readable evidence levels and
suggested Turkish wording are in `issue539-status-vocabulary.json`.

## Reproduced UI-copy contradiction (no Hub or live device)

The actual `render(snapshot)` from `web/app.js`, executed in a tiny Node VM
DOM adapter with `devices: []`, sets the top `connection-pill` to **“Bağlı”**
while the card count is **0** and its empty-state says **“Henüz bağlı cihaz
yok. Yeni cihaz bağlayarak başlayabilirsin.”**. `render()` does this
unconditionally after receiving a dashboard payload; the top badge therefore
denotes dashboard/API availability but looks like device connection status.
This is a reproducible label collision, not proof that a device connection was
ever established or that the underlying dashboard API is faulty.

**Owner suggestion:** use “Kontrol paneli yüklendi” (or “Hesaba bağlı”) for
an authenticated dashboard response and reserve “Cihaz bağlı/çevrimiçi” for
fresh per-device evidence. A test-local replacement demonstrates the narrower
wording without changing protected upstream UI source. Confirm design with
the #1068 UI owner before applying it.

## Adjacent evidence-boundary review

| Source branch | Observed Turkish copy | Finding and proposed boundary |
| --- | --- | --- |
| `web/app.js`: dashboard render, zero devices | “Bağlı”; card says no linked devices | **Confirmed source-copy collision**; banner should identify dashboard/API response, not device enrollment |
| `web/app.js`: `accessMode === 'full'` | “Full Access açık” | **Potential ambiguity**: a stored mode/preference does not itself prove effective Windows/physical authorization; owner review for “Full Access tercihi seçili” |
| `web/connect.js`: authenticated pairing form before click | “Hazır” | **Context supplied**: neighboring text explicitly says device is added *after* BAĞLA; do not present this as confirmed enrollment bug |

The proposed dictionary separates `dashboard_loaded`, `device_registered`,
`device_online`, `request_queued`, `outcome_unknown`, `task_verified`; each needs
an explicit evidence source. In particular, UNKNOWN never authorizes a replay,
and a queue receipt never proves the requested business postcondition. These
are support-language recommendations, **not** runtime-state or permission changes.

## Local reproduction and remaining acceptance

```bash
node --test --test-reporter=spec test/delegated/k08/issue539-status-vocabulary.test.mjs
```

Negative fixture cases deliberately collide two distinct status labels, strip
an UNKNOWN warning, and compare the current source with a test-local copy
replacement. The test does not require `npm ci`, GitHub credentials, or a live
Agent. Actual browser visual layout, screen reader, Windows device,
authenticated Hub and #539 original-incident acceptance: **NOT_RUN**. Exact
HEAD CI and owner review remain separate gates; no issue closure is implied.
