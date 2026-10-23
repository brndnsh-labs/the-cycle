---
name: dep-update
description: Routine dependency hygiene for the-cycle — survey what's outdated, bump it in risk-sized steps, run the gates, and land one dependency commit. Tells a stale test expectation from a real regression. Never force-fixes advisories; never auto-pushes. Usage `/dep-update` (or `/dep-update <package>`).
---
<!-- cycle:rendered template=skills/dep-update.md.tmpl hash=c73cbe9b9348 — managed by the-cycle; edit the template, not this file -->

# /dep-update — dependency hygiene

**Shared rules in `.agents/skills/DOCTRINE.md` — read it if not already in context** (§4 gates, §6
branch and commit policy).

1. **Survey:** `npm outdated`. Patch/minor bumps of leaf packages are routine; a
   major, a framework, or anything with a native build step is not — take those **one at a time**,
   so a failure can be attributed.
2. **Branch** (§6), then update: `npm update --package-lock=false` for the routine set; name packages for the rest.
   Read the install output, not just the exit code — a silently skipped patch or a native rebuild
   against the wrong ABI exits 0 and breaks at runtime.
3. **Advisories:** fix each on its own terms. An advisory only a major bump clears is a separate change —
   surface the tradeoff.
4. **Gates (§4).** A red gate is one of two opposite things: a **stale expectation** (the dependency
   legitimately changed its output — update the test and say so in the commit) or a **real
   regression** (pin back and file it; don't bless it). Can't tell which → surface it.
5. **Commit once** (§6) with explicit paths: `package.json`, plus any test a stale
   expectation required. A formatter bump that reformats untouched files gets its own commit.
6. **Report** what moved, what's held back and why, and gate status. **Don't push** — a dependency
   bump lands on Brandon's schedule.

This repo has no configured
lockfile: work from `package.json` and don't create one as a side effect. Nothing outdated → say so and stop.
