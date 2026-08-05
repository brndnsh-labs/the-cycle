# Backends

The skills never name a tracker. They call **verbs**, and a backend file binds each verb to a
command — the design that turned this repo's own Forgejo→GitHub migration into a config edit and
a re-render, not a rewrite of every skill. `github` is the only backend bound today; see "Adding a
backend" below for what standing up a second one takes.

This isn't speculative generality — it's a mechanical port that has already been done by hand
(GitHub's own `backends/github.jsonc` replaced a since-retired Forgejo binding once every
consuming repo had migrated), and the hand-written cheat-sheet that guided that port is what this
file generalizes.

(There's a second, structurally identical abstraction for *which AI coding tool* runs the rendered
skills — `harnesses/*.jsonc` and `{{harness.*}}` fields, documented in `docs/HARNESSES.md`. Same
idea, different axis: this file is about the tracker, that one is about the harness.)

## The verb vocabulary

| Verb | Args | Purpose |
| --- | --- | --- |
| `issue_list` | — | open issues, as JSON |
| `issue_list_closed` | — | recently closed, for the `--board` view |
| `issue_list_label` | `$1` label | filtered open issues |
| `issue_list_milestone` | `$1` milestone | filtered open issues |
| `issue_view` | `$1` number | one issue incl. body |
| `issue_create` | `$1` title `$2` body `$3` label | file an issue |
| `issue_edit_label` / `issue_unlabel` | `$1` number `$2` label | add / remove a label |
| `issue_comment` | `$1` number `$2` text | comment |
| `issue_close` | `$1` number | close |
| `pr_create` | `$1` branch `$2` title `$3` body | open a PR against `main` |
| `pr_list` / `pr_view` / `pr_close` | `$1` number | PR surface |
| `merge_guard` | `$1` pr `$2` issue | **backgrounded** poll-then-merge on green |
| `set_status` | `$1` number `$2` status label | write the status value |
| `ci_runs` | — | list CI runs |
| `ci_log` / `ci_log_failed` | `$1` run | read one run's log / its failed steps |

There is no `board_list`: **the open issue list is the board**, so `issue_list` is the whole read
path. There is no `batch` either — the status write is a single REST call against the 5,000/hr
core pool, not GraphQL points, so an ordinary loop is correct and a batching verb would only be a
second way to do the same thing.

A verb's value is itself a template, so it can embed config:
`"set_status": "gh issue edit $1 --remove-label \"{{tracker.status_labels}}\" --add-label $2"`.
`tracker.status_labels` is derived at render time from `tracker.statuses`, so the clear-list can
never disagree with the table DOCTRINE §1 prints from the same source.

## Semantic flags

Everything else is a command swap. A few things are *semantic* enough that skills branch on them
via `{{#if backend.…}}`, declared in each backend's `semantics` block. `cycle lint` fails if a
declared flag is one no template reads, or a template branches on a flag a backend never declares
— so the flags and the branches that read them can never drift apart, even with only one backend
to check them against.

GitHub's block:

| Flag | Value | Why |
| --- | --- | --- |
| `auto_merge` | `false` | branch protection isn't guaranteed to exist — see below |

**On `auto_merge`:** a fire-and-forget auto-merge flag is only safe when the forge enforces
required checks. Without branch protection, `gh pr merge --auto` merges *immediately* — there is
nothing for it to wait on. The backend therefore defaults to the background poll-then-merge guard.
Set `auto_merge: true` only for a repo that actually has protection configured.

## Reading routing values

`issue_list` returns `labels` alongside `number`, `title`, `milestone` and `url`, so one call
returns the work *and* its routing. Because it queries issues directly it carries open/closed
state intrinsically: there is nothing to intersect and no way for a stale row to linger.

Status is exactly one `status:*` label. `set_status` clears the whole set and adds the target in a
single call — removing a label the issue doesn't carry is a no-op that still exits 0, and the add
is applied after the removes, so the call is idempotent and needs no read first.

The labels must **exist in the repo**. `gh` fails loudly on one that doesn't, which is the
intended behaviour — `cycle install` prints the `gh label create` lines for the configured
vocabulary.

## Required config

A backend declares what it can't render without, in `requires`. That's validated *before* any
template runs, so a missing value is one clear instruction rather than an "unresolved `{{…}}`"
from four levels inside a verb expansion.

GitHub declares **no** `requires`. Every verb is a plain `gh` call against the repo `gh` already
resolves from the checkout, so there is nothing a repo can bind wrong. (It used to require
`tracker.project` and `tracker.owner` for the Projects v2 board; both retired with it.)

## No installed executables

A render is **prose and nothing else**. Nothing is installed into a consuming repo, so a rendered
command can never point at a script the repo doesn't have.

This wasn't always true. Backends used to declare `shims`: a real file rendered into `scripts/`
that spawned a canonical script in the-cycle's `helpers/`, with the repo's bindings baked in as
env. That machinery — the shim template, the `helpers/` directory, the `CYCLE_HOME` resolution
chain, the real-file-not-a-symlink workaround for isolated CI checkouts — existed solely to carry
the Projects v2 board helper, because the Projects GraphQL surface was too awkward to drive from
verb strings. Labels need no helper, so all of it retired with the board.

What's left is the invariant: **a verb may not name a `scripts/` executable.** `cycle lint` and
`npm test` both enforce it. If a future backend genuinely needs an executable, reintroducing shims
is a deliberate change to those two checks first — not something that can happen by accident.

## Adding a backend

1. Copy `backends/github.jsonc` — it's the only implementation today, and the reference for the
   shape a new one has to fill in.
2. Bind every verb in the table above. A verb a skill calls but the backend doesn't define is a
   hard error at render time, so nothing is silently missing.
3. Set every semantic flag honestly. Getting `auto_merge` wrong is the one that can actually
   lose work.
4. **Check whether the new backend's tracker mechanics actually match GitHub's.** DOCTRINE's §1
   ("closed issue is done") and §7 (tracker-mechanics opening, "unreachable → stop") currently read
   as GitHub-specific prose, hardcoded directly into the template rather than spliced from a
   per-backend note — that's correct only because GitHub is the sole backend today. If the new
   backend's routing model, close-on-merge behavior, or unreachable condition genuinely differ,
   those sections need real `{{#if backend.…}}` branches again, the way `has_board` used to fork
   §1's board-vs-labels paragraph before the label-only Forgejo backend was retired (#5/#6). Don't
   silently reuse GitHub's prose for a backend it doesn't describe.
5. **Bind it to commands, not to an executable.** A verb may not name a `scripts/` path — nothing
   installs one. If the tracker's API is too awkward to drive from a verb string, that's a design
   conversation, not a helper you add quietly; see "No installed executables" above.
6. `npm test` renders every profile against every backend in `backends/` and checks that the render
   is prose only.

## Migrating off a backend (history)

the-cycle supported a Forgejo backend until every consuming repo had moved to GitHub, at which
point it was deleted outright rather than left with zero callers. This runbook is what that
migration actually took, kept here — not because Forgejo is coming back, but because the traps it
describes (stale routing values, shims a re-render never removes, a hand-written helper surviving
under a repo's own name) recur for *any* tracker migration, not just this one. Read Forgejo/GitHub
below as stand-ins for "the old backend" / "the new backend" if this ever needs doing again.

1. **Edit `.cycle/config.jsonc`.** Set `backend`, and add whatever the new backend `requires` —
   GitHub declares none today. Update `repo.slug` if the slug moved (an
   org rename counts). **Delete keys the old backend owned:** `tracker.api` was bound only by the
   Forgejo backend, so on GitHub it is inert while still reading like live config.
2. **Re-map the routing vocabulary — it is not portable.** This is the step that silently
   half-works. Values are compared as exact strings, so a leftover spelling in `status.pickable` /
   `status.active` reads as "nothing is active" rather than as an error. Re-spell every status
   entry, and check what each one *is* on the destination — Forgejo used `status/in-progress` label
   namespaces, GitHub used Projects v2 field values (`In progress`) until Aug 2026, and now uses
   `status:in-progress` labels again. Workflow labels (`bug`, `finding`, `scout`, `area:*`) stayed
   labels throughout.
3. **`cycle update`** to re-render the skills.
4. **Delete files the old backend rendered, by hand.** `cycle update` writes the current profile's
   files; it never removes ones that dropped out of it. `cycle check` lists them as
   `· N file(s) no longer in this profile` — *dim, informational, and not counted in the exit
   code*, so nothing fails and it's easy to miss. It doesn't stay harmless: a repo whose knip
   config sets `files: "error"` fails its own gate on a now-unreferenced `scripts/*.mjs`, and that
   failure surfaces far from its cause. (Retiring the board hit exactly this: `cycle check`
   reported the orphaned `scripts/gh-project.mjs` rather than deleting it.)
5. **Check for a hand-written helper left over from a previous life on the destination forge.**
   One repo carried its own `scripts/gh-project.mjs` from an earlier GitHub stint, hardcoded to a
   long-dead personal Project #4 with `Todo`/`In Progress`/`Done`. `cycle update` **refused to
   overwrite it** — "no provenance header, not managed by the-cycle" — which is the only reason it
   surfaced instead of silently routing every status write to a board nobody reads. Treat that
   refusal as a finding, not an obstacle: `git rm` the file and re-render.
6. **Fix the overlays that name the tracker in prose.** Verbs are abstracted; sentences aren't.
   Grep `.cycle/overlays/` for the old forge's name — and edit the overlay, not the rendered copy
   under `.claude/skills/`, or the next `cycle update` reverts you.
7. **Then re-run `cycle update` and actually confirm it ran.** Editing overlays during a migration
   and never re-rendering leaves the skills — the files the agent reads — stale against their own
   source. `cycle check` reports that drift; a repo with more than one harness renders a tree per
   harness (`.claude/skills/` *and* `.agents/skills/`), and both go stale together.
8. **Prefer a routing model where an open issue is routable by definition.** A separate board is a
   second artifact an issue can be missing from: it can be open but *not on the board*, carrying no
   routing at all — not broken, just invisible, and needing hand reconciliation after a bulk move.
   Labels have no such state, which is one of the reasons the board was retired. If a destination
   forces a separate board, budget for reconciling it.
9. **Check whether issue numbers survived.** If the destination repo already had history, the
   migration renumbers, and a `#N` baked into a doc, a test comment or a commit message now points
   somewhere else. Keep the old→new map as a committed artifact — it's the only thing that makes
   those references readable afterwards, and it has to outlive the migration runbook.

## Unreachable is a stop, not a fallback

Every backend must make this true: if the tracker can't be reached, the skill **stops and says
so**. It never falls back to a cached list, a stale read, or a frozen markdown tracker.
Guessing tracker state produces confidently wrong work, which is the most expensive failure this
pipeline can have.
