---
name: deploy-prod
description: the-cycle has no configured production deploy — a gated stub that refuses to improvise a command. Usage `/deploy-prod`.
---
<!-- cycle:rendered template=skills/deploy-prod.md.tmpl hash=3b1ca02dbbf1 — managed by the-cycle; edit the template, not this file -->

# /deploy-prod — ship to production

Goal: make the safe path automatic — **not** the decision to ship.

**Shared rules in `.claude/skills/DOCTRINE.md` — read it if not already in context.** This is the
one skill with a hard human gate. `/burndown`, `/cycle` and every unattended path are forbidden
from invoking it.

## 1. Preflight (read-only)

- **Clean tree, on `main`, pushed.** A dirty or unpushed tree means the thing you're about to ship
  isn't the thing in the repo. Refuse.
- **Gates green** (§4).
- **Show exactly what's shipping.** Diff against what's *live*, not against the last tag or a
  stored ref — a stored deploy ref drifts silently and will happily lie to you. Read the live
  revision from the running origin and `git log <live>..HEAD`.
- **Any data migration in the pending set → surface it before the gate**, with what it does and
  whether it's reversible. A migration is a §5 always-brake surface in its own right.

## 2. THE GATE

Present the preflight and **stop.** Wait for one explicit "go" from Brandon in this turn.

Not a go: general enthusiasm, approval of the *code*, a merged PR, or an earlier "ship it" about
something else. Approval of the work is not approval of the deploy. If you're unsure whether you
have a go, you don't.

## 3. Deploy

**`deploy.prod` is not set in `.cycle/config.jsonc`** — stop and say so.
There is no deploy command to run, and prod is the last place to improvise one.

## Why this one is gated

Everything else in this pipeline is auto-merged on green because a wrong merge is cheap to walk
back. Prod is different: it's the one place where a mistake is visible to real users on someone
else's schedule. The gate isn't distrust of the pipeline — it's an acknowledgment that the *cost
function* changes here, and the person who owns the consequences should be the one who says go.

## Edge cases

- **Preflight fails:** stop, report which check. Never "deploy anyway."
- **Asked to deploy unattended** (from `/burndown`, an overnight lane, or a chained skill):
  **refuse.** Report that prod needs an explicit invocation.
