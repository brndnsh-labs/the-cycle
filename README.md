# the-cycle

An installable, self-updating work pipeline for AI coding harnesses — Claude Code and Codex CLI
today, with more on the way (`docs/HARNESSES.md`).

`the-cycle` renders a set of skills — `/cycle`, `/implement`, `/review`, `/patch`, `/done` and a
maintenance layer around them — into any repo, adapted to that repo's gates, tracker, and risk
surfaces. Improvements made here propagate outward with `cycle update`, and `cycle check` reports
when a copy has drifted.

## Why this exists

The same pipeline was copy-pasted into three repos and diverged in all three:

| | ensemble | songsiknow | mend |
| --- | --- | --- | --- |
| `DOCTRINE.md` | 392 L | 203 L | 197 L |
| `scout` | 193 L | 259 L | 193 L |
| `intake` | 142 L | 176 L | 143 L |

Every shared skill differs from every other copy — most by **more changed lines than the file
contains**. `scout` alone is 380 changed lines between two of them. An improvement made in one repo
reached the others only if hand-carried, and usually didn't. One symptom: a hardcoded
`Co-Authored-By: Claude Opus 4.8` trailer sat in `DOCTRINE §8` in multiple repos long after it went
stale.

The divergence wasn't the real problem. **Silent** divergence was. So the two features that matter
most here are `cycle update` (propagate) and `cycle check` (make drift visible).

## The design

Three observations made this tractable:

1. **The `§1–§9` doctrine spine is structurally identical across all three repos.** Same nine
   sections, same order, same meaning — only the contents vary. That spine is the portable
   contract.
2. **Skills already indirect through it.** They say "see DOCTRINE §5" rather than restating rules.
   The habit exists; it just *leaks* — skills also inline `npm run typecheck`, project numbers, and
   brake surfaces. That leak is exactly where they drifted.
3. **Executables were already single-sourced.** `dotfiles` held one canonical `forgejo.mjs` and
   each repo committed a thin real-file shim. This repo reuses that pattern rather than
   reinventing it — and then inverts it: the executables moved *here*, into `helpers/`, so
   installing the pipeline takes one clone instead of two. `dotfiles` keeps the PATH entry points
   and now shims in this direction.

So the core move is to **plug the leak**: every repo-specific value lives in one generated binding
file, and skill templates become fully portable.

```
the-cycle/                          a consuming repo/
  templates/                          .cycle/
    DOCTRINE.md.tmpl        ─────▶      config.jsonc      the bindings
    skills/*.md.tmpl                    overlays/         repo-specific inserts
    shim.mjs.tmpl                     .claude/skills/       one tree per
  backends/                             DOCTRINE.md         configured harness
    forgejo.jsonc                       <skill>/SKILL.md    — rendered + provenance
    github.jsonc                      .agents/skills/       (Codex, if configured)
  harnesses/                           DOCTRINE.md
    claude.jsonc                       <skill>/SKILL.md
    codex.jsonc                      scripts/
  helpers/                              forgejo.mjs       shim → helpers/, with
    forgejo*.mjs · gh-project.mjs       gh-project.mjs      this repo's bindings
```

Skill templates never name a tracker command; they call verbs the backend binds. The helpers those
verbs invoke live upstream in `helpers/` — a repo gets a generated shim, not a copy — so a fresh
machine needs one clone and nothing else.

### Overlays

Some skills are portable procedure wrapped around irreducibly local content — `/review`'s reviewer
routing table, `/scout`'s lens bodies. Those inject from `.cycle/overlays/` at named points, so the
procedure stays shared while the repo owns its table. A missing overlay fails the render loudly; it
never emits a skill with a hole in it.

### Drift detection

Every rendered file carries a provenance comment after its frontmatter, recording the upstream
commit it came from and a hash of its own body. `cycle check` reports two independent axes:

- **local drift** — the file was hand-edited after rendering
- **upstream drift** — the template has moved on since this copy was rendered

## Install

```sh
git clone https://git.brndn.zip/brandon/the-cycle ~/code/the-cycle
~/code/the-cycle/install.sh          # symlinks bin/cycle → ~/.local/bin
```

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

### Why setup is guided

`cycle install` can detect a repo's name, remote and gate commands. It cannot know what breaks
this codebase irreversibly, which directories deserve which reviewer, or what "ready" means here —
and those answers are what make the pipeline worth having. Accepting the generic defaults produces
a pipeline that renders cleanly and advises badly.

So the split is: `cycle install --plan` emits what must be decided — detected values, each open
question with *why it matters*, every overlay point with the shape its content should take —
and `/cycle-setup` reads the codebase to answer it, asking only what reading can't settle.

The renderer stays pure. A model fills in **data**; it never writes a skill, and `/cycle-setup` is
forbidden from touching `.claude/skills/` at all. That keeps the whole pipeline testable, and
keeps drift detection meaningful.

And when working on the-cycle itself:

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

`cycle adopt` reads a hand-written pipeline and drafts the config from it — gates out of DOCTRINE
§4, brake surfaces out of §5, the status table out of §1, the commit trailer out of §8 — then
reports what it *couldn't* decide.

It is read-only by default and never touches a skill file. Where a repo's doctrine and the shared
template disagree, that's a judgment call, so adopt surfaces the delta and stops rather than
quietly picking a winner.
