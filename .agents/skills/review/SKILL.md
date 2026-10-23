---
name: review
description: Independently review the current uncommitted the-cycle diff (or a named branch/PR) — correctness, plus whether it does what the issue asked — adding `/security-review` when it touches an always-brake surface (auth / tokens / secrets, schema / data migration, anything destructive or irreversible). Reports findings with evidence; fixing them is the caller's job. Used by /cycle, or on its own for any diff.
---
<!-- cycle:rendered template=skills/review.md.tmpl hash=0e15ab6221da — managed by the-cycle; edit the template, not this file -->

# /review — fresh eyes on a diff

**Shared rules in `.agents/skills/DOCTRINE.md` — read it if not already in context** (§3 says how
much review a change deserves; §5 says when to stop).

**Run it in a fresh-context subagent** when the caller built the diff: hand it the issue number
and the diff, not your reasoning. The value is a reviewer who doesn't share the builder's
assumptions. If a subagent can't be launched at all, don't stall: review in-thread, re-reading
the issue and the diff from scratch, and say that's what happened.

## What to check

- **Correctness — the inline correctness pass.** Logic, edge cases, error paths, contracts,
  invariants. Depth matches risk. Tests beside production code are supporting cast; the behavior
  change is the subject.
- **Spec — kept separate.** Read the issue's Acceptance and its comments, and report against them:
  a criterion missing or half-met, behavior nobody asked for, or a criterion addressed in a way that
  won't actually satisfy it. Quote the acceptance line, and tag these `[spec]`. No issue in context
  → say "no spec available"; never reconstruct one from the diff.
- **Tests that are the deliverable — the test-quality lens.** Do they assert the contract or just
  restate the implementation? Can each assertion actually fail? A test that enshrines a bug is a
  finding, however green.
- **Brake surfaces** (auth / tokens / secrets, schema / data migration, anything destructive or irreversible): also run `/security-review`, reasoning about this flow's
  threat model, not generic categories.
- **A big or subtle diff:** a second reviewer on a different model catches same-prior blind spots.
  The heavyweight `/code-review` is human-triggered — if a diff deserves it, say so and leave the
  call to Brandon.

## Reporting

- Each finding: an ID (`F1`, `F2`, …), severity (P0 / P1 / P2), `file:line`, a verbatim quote of the
  line, and what's wrong. **Read the cited line before reporting it** — a confidently wrong finding
  costs more than a missed one.
- End with one verdict: **clean**, **fixable** (mechanical findings — fix and re-check), or
  **needs Brandon** (a design call, a P0 on a brake surface, or a contradiction with a project
  memory note — which wins by default, but surface it).
- No findings is a valid result. A reviewer that errored or timed out is a *missing* result — say
  so; never report it as clean.
- **Re-check mode:** when called again after fixes, confirm each original ID against the current
  tree (fixed / still open) and look at the fix itself for new problems. If the fix grew into new
  behavior, do a full review instead.
