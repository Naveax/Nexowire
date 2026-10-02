# Product control plane v0

Nexowire is moving from a single-owner self-hosted tool toward a multi-user product.

## Product rules

- Owner-paid infrastructure spend is not allowed by default.
- Providers must never auto-upgrade into a paid tier.
- Free capacity exhaustion must throttle or deny work, never create an owner bill.
- Metered/custom usage is prepaid. Postpaid balances are not allowed.
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

Prices are deliberately not embedded in the runtime yet. Billing policy and technical entitlements should not be coupled to a temporary price experiment.

## Scale target

The architecture should remain owner-zero-spend even at very large account counts by separating account count from centralized data-plane cost:

1. static web assets on a free static host;
2. tiny control-plane/signaling requests on hard-capped free/serverless resources;
3. direct device-to-device or device-to-Hub transport whenever possible;
4. relay only when direct transport is unavailable;
5. free relay capacity hard-stops instead of creating a bill;
6. paid relay capacity can only be enabled against already-collected prepaid/subscription revenue.

This is a financial safety invariant, not a claim that third-party free tiers provide unlimited capacity.
