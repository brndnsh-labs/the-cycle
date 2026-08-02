# the-cycle

An installable, self-updating work pipeline for AI coding harnesses — Claude Code and Codex CLI
today, with more on the way (`docs/HARNESSES.md`).

`the-cycle` renders a set of skills — `/cycle`, `/implement`, `/review`, `/patch`, `/done` and a
maintenance layer around them — into any repo, adapted to that repo's gates, tracker, and risk
surfaces. Improvements made here propagate outward with `cycle update`, and `cycle check` reports
when a copy has drifted.

## Why this exists

The same pipeline was copy-pasted into three repos and diverged in all three — hand-carried fixes
usually didn't make it to the other copies, so bugs (and a stale hardcoded model name) sat fixed in
one repo and broken in the others. The divergence wasn't the problem; **silent** divergence was. So
the two features that matter most here are `cycle update` (propagate) and `cycle check` (make drift
visible).

## The design

Every repo-specific value lives in one generated binding file, and skill templates become fully
portable:

- **Backends** (`backends/*.jsonc`) bind tracker verbs — skills call `{{@issue_view "$1"}}`, never a
  literal `gh` or Forgejo command. `docs/BACKENDS.md`.
- **Harnesses** (`harnesses/*.jsonc`) bind which AI tool runs the skills, behind `{{harness.*}}`
  fields. `docs/HARNESSES.md`.
- **Overlays** (`.cycle/overlays/*.md`) hold the irreducibly repo-specific blocks a template can't
  generalize away — a reviewer routing table, scout lens bodies — injected at named points. A
  missing required overlay fails the render loudly rather than shipping a skill with a hole in it.
- **Drift detection**: every rendered file carries a provenance comment. `cycle check` reports
  *local drift* (hand-edited since rendering) and *upstream drift* (the template moved on)
  independently.

Full rationale for all of the above: `docs/AUTHORING.md`.

## Install

Bootstrap, no clone required:

```sh
npx @brndnsh/the-cycle install       # runs the interview, renders into the current repo
```

npx is for a one-off first render — the fetched copy lives in npx's ephemeral cache, so `cycle
update` / `cycle check` and the personal `/cycle-setup` · `/cycle-adopt` skills need the durable
clone below. `cycle install`'s own output says as much when it ran this way.

For everyday use:

```sh
git clone https://git.brndn.zip/brandon/the-cycle ~/code/the-cycle
~/code/the-cycle/install.sh          # symlinks bin/cycle → ~/.local/bin
```

`git.brndn.zip/brandon/the-cycle` is canonical — PRs and CI happen there. `github.com/brndnsh/the-cycle`
is a read-only push mirror, kept in sync automatically, for machines that can't reach the personal
Forgejo host:

```sh
git clone https://github.com/brndnsh/the-cycle ~/code/the-cycle
~/code/the-cycle/install.sh
```

Don't push to the GitHub mirror directly — the next sync from Forgejo overwrites it.

`install.sh` also links `/cycle-setup` and `/cycle-adopt` into `~/.claude/skills` as personal
skills — they have to work in a repo that doesn't have the-cycle yet.

Then, in a repo:

```sh
/cycle-setup                         # guided: reads the repo, then writes config + overlays
```

or drive it by hand:

```sh
cycle install --profile lean         # interview → .cycle/config.jsonc → render
cycle check                          # drift report; non-zero exit on drift
cycle update                         # re-render, show the diff
cycle adopt                          # reverse-engineer an existing hand-written setup
```

`cycle install` can detect a repo's name, remote, and gate commands, but not what breaks it
irreversibly or what "ready" means there — so setup is guided rather than defaulted:
`cycle install --plan` emits every open question and overlay point, and `/cycle-setup` reads the
codebase to answer what it can, asking only the rest.

When working on the-cycle itself:

```sh
cycle lint                           # §N citations, verb bindings, shim coverage,
npm test                             # overlay docs, profiles, cross-skill refs
```

## Profiles

Machinery is opt-in — a repo takes on a lane when it earns it.

| Profile | Skills |
| --- | --- |
| `lean` | cycle · implement · review · patch · done · next · intake · scout · burndown · dep-update · deploy-test · deploy-prod |
| `standard` | + unblock · wrap-up · pre-compact |
| `full` | + nightly · fan-out · cover · flake |

## Backends

The tracker sits behind one verb vocabulary (`issue view`, `pr create`, `merge-guard`, …) with two
bindings. The backends differ in only four places:

| | Forgejo | GitHub |
| --- | --- | --- |
| fields | label namespaces (`status/*`, `size/*`) | Project fields |
| board | none — the issue existing is enough | `project item-add` required |
| job logs | no API → `ci-logs` wrapper | `gh run view --log` |
| merge | `forgejo-merge <pr>` guard | poll-then-merge; `--auto` needs branch protection |

## Harnesses

Which AI coding tool runs the rendered skills sits behind `{{harness.*}}` fields, the same way the
tracker sits behind backend verbs. `.cycle/config.jsonc`'s `harnesses` array (default `["claude"]`)
picks one or more; `cycle update` renders a complete, independent skill tree per harness.

| | Claude Code | Codex CLI |
| --- | --- | --- |
| skills discovered at | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| structured questions | `AskUserQuestion` | `ask_user_question` |
| parallel subagents | the Agent tool | subagents (GA 2026-03-14) |

Full vocabulary, the honesty rule around capability flags, and how to add a third harness:
`docs/HARNESSES.md`.

## Layout

```
.forgejo/workflows/ci.yml   `npm test` on PR + push to main
bin/
  cycle.mjs            the CLI — Node ESM, zero dependencies
  adopt.mjs            reverse-engineer an existing hand-written setup
install.sh             symlink bin/cycle onto PATH
skills/
  cycle-setup/         guided install — personal skill, linked by install.sh
  cycle-adopt/         guided reconciliation of an existing setup
templates/
  DOCTRINE.md.tmpl     the §1–§10 spine
  skills/*.md.tmpl     one per skill
  shim.mjs.tmpl        the helper shim rendered into scripts/
  overlays.jsonc       the overlay points, and what each is for
helpers/               the tracker executables, single-sourced
backends/*.jsonc       verb → command tables, shim declarations
harnesses/*.jsonc      discovery path, tool names, capability flags per AI harness
profiles/*.jsonc       which skills each profile installs
test/                  node --test; renders every profile × backend × harness
docs/
  AUTHORING.md         writing a template; the overlay points
  BACKENDS.md          the verb vocabulary; adding a backend
  HARNESSES.md         the harness.* vocabulary; adding a harness
  PATTERNS.md          reviewer-agent skeleton, hooks, permissions
```

## Requirements

Node ≥ 20, git, and bash for `install.sh`. No dependencies, no build step. Forgejo repos need a
token at `~/.config/forgejo/token`; GitHub repos need `gh` authed with the `project` scope.

## Adopting an existing repo

`cycle adopt` reads a hand-written pipeline and drafts the config from it — gates, brake surfaces,
status table, commit trailer — then reports what it *couldn't* decide. It's read-only by default and
never touches a skill file; where a repo's doctrine and the shared template disagree, `adopt`
surfaces the delta rather than quietly picking a winner.
