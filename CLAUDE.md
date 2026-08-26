# CLAUDE.md

This file provides repository guidance to AI coding agents. `AGENTS.md` is the Codex entry point;
this historical filename remains the detailed canonical guide.

## What this is

the-cycle renders a shared work-pipeline (`/cycle`, `/implement`, `/review`, `/patch`, `/done`, a
`DOCTRINE.md` rule spine, and more) into consuming repos, adapted to each repo's tracker, gates,
and risk surfaces. It replaces three hand-copied, silently-diverged pipelines with one templated
source; `cycle update` propagates improvements outward, `cycle check` makes drift visible. Full
rationale and diagram: `README.md`.

Zero dependencies, Node ESM, `>=20`. The CLI is `bin/cycle.mjs` plus one lazily-imported sibling
(`bin/lint.mjs`) — it's installed via symlink, and relative sibling imports resolve through that
with no module resolution games.

## This repo dogfoods itself

**`.claude/skills/**` and `.agents/skills/**` in this checkout are *rendered output*, not hand-written.** the-cycle installs
its own pipeline into itself (`.cycle/config.jsonc`, profile `lean`, backend `github`) to manage its
own backlog — issues in `brndnsh-labs/the-cycle`, routed by `status:*` labels, which also makes this repo
the live proof that the `github` backend works.
Every file under either harness skill tree carries a provenance comment and must never be hand-edited
— `cycle check` will flag it as drifted.

- To change pipeline **behavior/procedure**: edit `templates/DOCTRINE.md.tmpl` or
  `templates/skills/<name>.md.tmpl`, then `cycle update` to re-render this repo's own copy (and
  eventually every other consuming repo).
- To change **this repo's bindings** (gates, brakes, tracker fields): edit `.cycle/config.jsonc`,
  then `cycle update`.
- Read the `DOCTRINE.md` in your harness tree once per session — it's the shared rule spine every skill here
  cites as `§N` (tracker/labels/routing/gates/autonomy/merge/commit conventions). Don't restate its
  rules; skills and this file both just point at it.

## Commands

```sh
npm test                                    # node --test test/*.test.mjs
cycle check                                 # the other gate — this repo's own rendered
                                             #   copy must match the templates (dogfood)
node --test test/render.test.mjs            # a single test file
node --test --test-name-pattern="drift"     # a single test by name, across files
cycle lint                                  # internal consistency: §N citations, verb bindings,
                                             #   overlay docs, profile membership,
                                             #   cross-skill refs, inlined-fact detection
```

`cycle lint` and `npm test` catch different things — lint checks that the pieces still refer to each
other correctly (a renamed `§N`, a verb no backend binds, a template in no profile); the test suite
discovers every profile, backend, and harness registry entry and proves every template actually
*renders* across their exhaustive product. Specialized multi-harness-coexistence suites cover
frontmatter and idempotency. Run both before considering template work done.

Debug/inspection commands (not part of the normal edit loop, but useful when tracing a render):

```sh
cycle render [filter]                       # print rendered output to stdout, without writing
cycle update --dry-run                      # what would change without writing
```

## Architecture

Three axes of variation, each pulled out of the templates into its own binding layer:

- **`profiles/*.jsonc`** — which skills a repo installs (`lean` / `standard` / `full`).
- **`backends/*.jsonc`** — tracker verb → command bindings (GitHub today; the shape supports
  more). Skills call verbs like `{{@issue_view "$1"}}`, never a literal tracker command.
  Vocabulary: `docs/BACKENDS.md`.
- **`harnesses/*.jsonc`** — which AI coding tool runs each rendered skill tree,
  behind `{{harness.*}}` fields (discovery path, tool names, capability flags). A config's
  `harnesses: [...]` array renders one complete, independent skill tree per harness. Vocabulary:
  `docs/HARNESSES.md`.

A consuming repo's `.cycle/config.jsonc` supplies the scalar bindings (repo name, gate commands,
brake surfaces, tracker fields); `.cycle/overlays/*.md` supply the irreducibly repo-specific blocks
(reviewer routing tables, scout lens bodies) that inject into an otherwise-portable template at a
named point — every overlay point is registered in `templates/overlays.jsonc`, and a missing
required overlay fails the render loudly rather than emitting a skill with a hole in it.

**The rule that keeps templates portable** (`docs/AUTHORING.md`): a value that varies per repo goes
in config; a command that varies per tracker is a backend verb; a tool name that varies per harness
is a `harness.*` field; a table only one repo could write is an overlay. Typing a literal command,
name, or number into template prose is the exact failure mode that caused the original three-repo
divergence — `cycle lint`'s inlining check exists specifically to catch it.

**Drift detection**: every rendered file carries a provenance comment (template + hash of its own
body). `cycle check` reports *local drift* (hand-edited after rendering) and *upstream drift* (the
template moved on since this copy rendered) as independent axes.

The source-tree layout is in `docs/DEVELOPMENT.md` — not duplicated here since it goes stale
independently of this file.

## Adding or changing a template

Full procedure in `docs/AUTHORING.md`. Short version: edit the `.tmpl`, update `profiles/*.jsonc`
membership if it's a new skill, `cycle lint`, `npm test`, then **render it into a scratch repo and
read the output** — tests prove it renders, only reading proves it says something true. When
changing a template repos already consume: `cycle check` in each, then `cycle update --dry-run`,
then `cycle update`. If a repo has local drift, `update` refuses by design — fold the local edit
into the template or config, don't force over it.

## CI

`.github/workflows/ci.yml` — the required `gates` job runs `npm test` plus
`node bin/cycle.mjs check` first on Node 22 and then on the exact declared 20.0.0 floor, so branch
protection cannot pass before compatibility does. It uses `ubuntu-latest` with no install step
(zero dependencies). GitHub-hosted rather than ghrunner01 because this repo is public and the org's
runner group refuses public repos. `main` is branch-protected on the bare context name `gates` (not
a scoped `CI / gates (pull_request)` form); safe PRs queue server-side auto-merge, which waits for
that required context.
