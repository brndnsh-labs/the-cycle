---
name: cycle-adopt
description: Reconcile a repo that already has hand-written pipeline skills onto the-cycle's shared templates. Reads the existing DOCTRINE and skills, extracts what's genuinely repo-specific into config and overlays, and reports — per section — where the local version and the shared template disagree. Surfaces every delta for a decision instead of picking a winner. Use before converting an established repo; never as a first install.
---

# /cycle-adopt

A repo with hand-written skills has years of accumulated judgment in it. Some of that is
repo-specific truth that must survive as config or an overlay. Some is a local improvement that
belongs upstream in the template, where every repo gets it. Some is drift — a stale copy of
something the template now says better.

**Telling those three apart is the whole job, and it is not mechanical.** `bin/adopt.mjs` drafts
what regexes can; you do the part that needs reading.

The one rule: **surface the delta, never auto-pick a winner.** Where the local doctrine and the
shared template disagree, that is a decision, not a merge conflict to resolve quietly.

## 0. Draft

```sh
cycle adopt                   # read-only; extracts what it can and reports what it can't
cycle install --plan          # the same question/overlay spec /cycle-setup uses
```

`cycle adopt` never touches a skill file and writes nothing without `--write`. Its output is a
starting point with known blind spots — it reads prose with regexes, and it has under-extracted
before.

**Read its loss report first — it is the most important thing on the screen.** adopt renders the
new skills in memory and compares them against what is on disk, then lists every section of the
existing files whose substance does not appear in the output, ranked by size, with the overlay
point that should carry it. That list *is* your extraction worklist.

Two things about reading it. The `% carried` column separates the two kinds of hit: near-zero means
the template never knew this content and it will genuinely vanish; a higher number usually means
the template rewrote the same procedure in its own words, which is fine and needs nothing from you.
And a section adopt could not route ("no overlay point covers this") is the interesting case — it
is either something to propose upstream, or a sign this repo does something the shared pipeline has
no concept of. Neither is solved by inventing an overlay for it.

If the report says nothing is left behind, the conversion is genuinely mechanical. That is the
uncommon case; treat it as a claim to spot-check, not a licence to skip §1.

## 1. Inventory before you reconcile

- List the repo's existing skills. Which have a template upstream, which don't.
- A local skill with no upstream template is a real finding: either it belongs upstream (propose
  it), it's genuinely local (it should be ejected and kept), or it was absorbed by a consolidation
  — `/pmlite` became `/next --board`, `/shakedown` became `/unblock`'s hands-on lane. Say which.
- Diff each local DOCTRINE section against the template's. Ensemble's DOCTRINE ran 190 lines longer
  than the template; that surplus is where the interesting decisions are.

## 2. Classify every difference

For each place the local version and the template disagree, assign exactly one verdict and give
your reason:

| Verdict | Means | Lands as |
| --- | --- | --- |
| **config** | a repo fact stated in prose | a value in `.cycle/config.jsonc` |
| **overlay** | content only this repo could write | `.cycle/overlays/<point>.md` |
| **upstream** | a genuine improvement every repo should get | a proposed template change |
| **drift** | a stale copy of something the template says better | dropped, and say what replaces it |
| **decide** | a real disagreement | **stop and ask** |

`upstream` and `decide` are the two that matter. A local rule that is simply *better* should be
proposed for the template rather than frozen into an overlay — overlaying it means the other repos
never get it, which is how this whole problem started.

Watch specifically for values that were hardcoded into prose and are now config: the commit
co-author trailer (stale in all three source repos), gate commands, project numbers, the person's
name, tracker slugs.

## 3. Report before writing

Present the classification as a table, grouped by verdict, `decide` first. For each `decide`, give
the local text, the template text, and a recommendation.

Get answers. Then write config and overlays, and render:

```sh
cycle update --dry-run        # read every diff
cycle update
cycle check                   # must be clean
```

## 4. The acceptance test is behavioural

A clean render proves nothing about whether the pipeline still works here.

Run a real `/cycle` on a live issue and confirm it behaves the way it did before. That is the only
evidence that matters. Until it passes, the adoption is unproven — say so rather than reporting
success.

Keep the old skills recoverable (a branch or a commit) until it does.

## Rules

- **Never resolve a `decide` yourself**, however obvious it looks. The local version usually
  encodes a reason that isn't written down.
- **Prefer upstream to overlay.** Every overlay is a thing the other repos won't get.
- **Don't drop anything silently.** A rule you classify as drift gets named in the report, with
  what replaces it.
- **Convert one repo at a time**, and verify each behaviourally before starting the next.
