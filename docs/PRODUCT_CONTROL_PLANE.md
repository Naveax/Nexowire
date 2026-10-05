# Product control plane v0

Nexowire is moving from a single-owner self-hosted tool toward a multi-user product.

## Product rules

- Owner-paid infrastructure spend is not allowed by default.
- Providers must never auto-upgrade into a paid tier.
- Free capacity exhaustion must throttle or deny work, never create an owner bill.
- Metered/custom usage is prepaid. Postpaid balances are not allowed.
- Purchased prepaid credits belong to the quota subject, carry across month boundaries, and are changed only through idempotent credit/debit events.
- Full and partial prepaid refunds revoke credits from signed provider refund events. Already-spent refunded credits become refund debt; usage stays fail-closed until later top-ups repay that debt.
- Data-plane routing is direct-first. Relay is a fallback and may only consume free capacity or prepaid revenue-backed capacity.
- Free includes the core remote-control product but does not include the isolated private pointer/keyboard/screen family.
- Plus, Pro, and explicitly configured Custom plans include private-control features without a separate add-on price.
- Private-control operations consume more usage credits because they are materially heavier:
  - private virtual pointer: 2x
  - private keyboard: 3x
  - private screen/private desktop: 5x

## Initial plan envelope

| Plan | Monthly credits | Devices | Concurrency | Private controls |
| --- | ---: | ---: | ---: | --- |
| Free | 20,000 | 2 | 1 | No |
| Plus | 100,000 | 10 | 5 | Included |
| Pro | 500,000 | 50 | 20 | Included |
| Custom | Explicit | Explicit | Explicit | Explicit |

Prices are deliberately not embedded in the runtime. Subscription and prepaid-pack prices remain provider-side. The runtime maps approved provider variant IDs to technical entitlements or prepaid credit quantities only.

## Production billing provisioning status

Before running live Lemon Squeezy acceptance, an owner can run:

```powershell
npm run billing:status
```

The command is deliberately non-interactive and local-only. It does not contact Lemon Squeezy and does not decrypt or print the API key or webhook signing secret. It validates the non-secret provisioning config, checks the two expected protected-secret envelope files and their purpose metadata without decrypting ciphertext, reports the configured store/variant/webhook metadata, and returns stable blocker codes such as `PROVISIONING_CONFIG_MISSING`, `API_KEY_PROTECTED_FILE_MISSING`, or `API_KEY_PROTECTED_FILE_INVALID`.

`readyForProvisionedBootstrap: true` means only that the local Windows provisioning artifacts required by the protected bootstrap are present, their protected envelopes have the expected metadata/purpose, and the non-secret config parses successfully. It is not proof that the live provider catalog, checkout, webhook, refund, quota, or billing flows have passed production acceptance. That separate acceptance still requires the real live-mode provider configuration.

Custom prepaid plans are explicitly provisioned by an administrator. A signed one-time-payment webhook can increase an existing Custom prepaid balance, but it cannot silently convert a Free/Plus/Pro account into Custom or create postpaid debt.

## Scale target

The architecture should remain owner-zero-spend even at very large account counts by separating account count from centralized data-plane cost:

1. static web assets on a free static host;
2. tiny control-plane/signaling requests on hard-capped free/serverless resources;
3. direct device-to-device or device-to-Hub transport whenever possible;
4. relay only when direct transport is unavailable;
5. free relay capacity hard-stops instead of creating a bill;
6. paid relay capacity can only be enabled against already-collected prepaid/subscription revenue.

This is a financial safety invariant, not a claim that third-party free tiers provide unlimited capacity.
