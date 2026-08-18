---
name: deploy-test
description: the-cycle has no separate test environment — a stub that redirects to /deploy-prod's gate rather than letting an ungated deploy reach production. Usage `/deploy-test`.
---
<!-- cycle:rendered template=skills/deploy-test.md.tmpl hash=8a0cf4447165 — managed by the-cycle; edit the template, not this file -->

# /deploy-test — not applicable here

**`deploy.test` is not set in `.cycle/config.jsonc`.** the-cycle has no lower-stakes target to
preview a branch or a dirty tree on, so there is nothing for this skill to deploy to.

**Do not substitute the production deploy.** The test flow is deliberately ungated — *no gate, no
explicit go* — because a test box is cheap to get wrong. Pointing that ceremony at the only
environment there is would turn a low-ceremony preview into an unreviewed production release.
That inversion is the exact mistake this stub exists to prevent.

## If you were asked to preview something

1. **Say plainly there is no test environment here** — don't improvise one, and don't reach for
   the production deploy command.
2. **If it genuinely needs to ship,** hand off to `/deploy-prod`, which carries the explicit-go
   gate a real deploy requires.
3. **If it only needs looking at,** run it locally instead.
