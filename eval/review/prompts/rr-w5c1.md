## Why

Sponsor memberships need realistic Stripe-hosted flows without handling card data. Resource
creation must be explicit and idempotent so retries do not create duplicate products, prices,
customers, or sessions.

## Touches

`packages/stripe-integration/**`, dependency manifests, injected-client tests, mock composition,
billing/security documentation, and reviewed oracle expectations.

## Requested change

Implement the sponsor-billing port for product/price synchronization, Checkout Session creation,
and customer portal session creation. Use explicit idempotency keys, immutable price handling,
fixed allowlisted return routes, safe result mapping, and SDK construction only in an explicit
live-billing composition root.

## Acceptance

- Product/price synchronization reuses matching resources and never silently mutates an active
  price into a different amount/currency.
- Checkout and portal operations use Stripe-hosted surfaces and return typed session references
  without treating redirects as membership truth.
- Reusing an operation ID cannot create a second intended resource.
- Tests cover duplicate retry, changed tier configuration, missing customer, provider refusal,
  rate limit, and ambiguous timeout through injected fakes.
- No card data, raw SDK error, secret, full URL with token, or request body reaches logs.
- Mock mode and tests perform no live call or DNS work.
- Oracle expectations cover product-shaped Stripe calls independently of detector output.
- All gates pass.

No live Stripe call or resource creation is authorized as part of this task.
