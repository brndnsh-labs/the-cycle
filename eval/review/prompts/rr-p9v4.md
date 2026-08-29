## Why

Stripe behavior needs provider-independent sponsor truth before SDK objects or webhook payloads
enter the domain. Money and membership state are too costly to infer from loose primitives.

## Touches

`packages/core/**`, pure domain tests, mock runtime billing responses, and sponsor sections of the
specification and security documentation.

## Requested change

Add strict values and transitions for sponsor tiers, integer minor-unit money with currency,
customer references, membership identity, and `pending | active | past_due | canceled | unknown`
projection. Distinguish configured tiers from synchronized provider resources and browser-session
results from verified membership state.

## Acceptance

- Amounts reject floats, negative values, unsupported/invalid currency shapes, and accidental unit
  conversion.
- A Checkout or portal URL cannot transition membership to active.
- Membership transitions preserve provider event identity and ordering metadata.
- Unknown or incomplete input yields `unknown`, not optimistic active or canceled state.
- Tests cover duplicate, stale, and out-of-order transition inputs.
- Core imports no Stripe SDK types, environment access, network, or web framework.
- All gates pass.

Stripe SDK usage, persistence, and real money are out of scope.
