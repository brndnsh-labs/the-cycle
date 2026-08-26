# the-cycle

An installable, self-updating work pipeline for AI coding harnesses — Claude Code, Codex CLI, Copilot CLI, OpenCode and Pi (`docs/HARNESSES.md`).

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
  literal tracker command. `docs/BACKENDS.md`.
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
# runs the interview and renders into the current repo
npx --yes @brndnsh/the-cycle install
```

npx is for a one-off first render from npm — the fetched copy lives in npx's ephemeral cache, so
`cycle update` / `cycle check` and the personal `/cycle-setup` skill need the durable clone below.
`--yes` accepts npx's package-download prompt. `cycle install`'s own output says as much when it
ran this way.

For everyday use:

```sh
git clone https://github.com/brndnsh-labs/the-cycle ~/code/the-cycle
~/code/the-cycle/install.sh          # symlinks bin/cycle → ~/.local/bin
```

`github.com/brndnsh-labs/the-cycle` is canonical — issues, PRs and CI all happen there.
`git.brndn.zip/brandon/the-cycle` is a read-only pull mirror of it, kept in sync
automatically, for machines that would rather not reach GitHub.

Don't push to the Forgejo mirror directly — the next sync from GitHub overwrites it.

`install.sh` also links `/cycle-setup` into your personal skills directory (`~/.claude/skills`, `~/.agents/skills`, `~/.github/skills`, `~/.opencode/skills`, or `~/.pi/skills`) as a personal
skill — it has to work in a repo that doesn't have the-cycle yet.

### Ask a coding agent to install it

Give an agent this prompt when you want it to bootstrap the durable install and set up the
repository it is already working in:

> Install the-cycle for durable use, then set it up in this repository. Verify Node ≥20, git, and
> bash first; `gh` must be authenticated before tracker operations. Before cloning or changing
> anything under my home directory, show me the paths and ask for approval. Once approved, clone
> `https://github.com/brndnsh-labs/the-cycle` to `~/code/the-cycle` (or inspect the existing clone),
> run `~/code/the-cycle/install.sh`, make sure `~/.local/bin` is on `PATH` as the installer directs,
> and verify `cycle --version`. Restart or reload the coding harness if it does not discover the
> newly linked personal skill. Then run `/cycle-setup` in this repository and follow it; do not
> hand-edit generated harness skill trees.

Then, in a repo:

```sh
/cycle-setup                         # guided: reads the repo, then writes config + overlays
```

or drive it by hand:

```sh
cycle install --profile lean         # interview → .cycle/config.jsonc → render
cycle check                          # drift report; non-zero exit on drift
cycle update                         # re-render, show the diff
```

`cycle install` can detect a repo's name, remote, and gate commands, but not what breaks it
irreversibly or what "ready" means there — so setup is guided rather than defaulted:
`cycle install --plan` emits every open question and overlay point, and `/cycle-setup` reads the
codebase to answer what it can, asking only the rest.

When working on the-cycle itself:

```sh
cycle lint                           # §N citations, verb bindings, overlay docs,
npm test                             # profiles, cross-skill refs
```

## Behavioral evaluation

From a clone of this repository, the deterministic gates prove that skills render and remain
internally consistent; they cannot prove that a workflow instruction changes agent behavior. The
on-demand evaluator compares a baseline the-cycle snapshot with a candidate while holding the
fixture, task, model, permissions,
gates and assertions constant:

```sh
node eval/run.mjs \
  --baseline HEAD \
  --candidate . \
  --model MODEL_ID \
  --output /tmp/cycle-eval-run
```

`HEAD` is a git ref in this repository; `.` may include uncommitted template work. Each arm is
rendered into its own physical repository and uses a local `gh` double, so the scenarios do not
write to GitHub. Codex itself must already be authenticated through its `CODEX_HOME` login;
ambient credential variables are not forwarded. The runner uses
[`codex exec --json`](https://developers.openai.com/codex/noninteractive) and records the event
stream (including tracker and gate commands), token usage when Codex reports it, final diff,
source/skill/fixture hashes, and deterministic assertions in the requested output directory. It
does not copy authentication into the fixtures: the Codex launcher retains its existing auth,
while model-generated commands receive a core-only environment, an empty evaluation home, no
network access, and no approval path out of the workspace sandbox.

Start with the default single matched run. If the arms differ, or the result will justify a
meaningful instruction change, add `--repeat 3` to repeat both arms. `--scenario <id>` narrows the
run to one targeted behavior.

Model-backed runs are externally metered and intentionally absent from `npm test` and CI. Ordinary
tests exercise fixture isolation, the tracker double, JSONL parsing, assertions, and result
formatting with a fake Codex executable. A behavioral FAIL is evidence in `results.jsonl`, not a
merge-gate exit code; invalid runner or harness execution exits 2.

## Profiles

Machinery is opt-in — a repo takes on a lane when it earns it.

| Profile | Skills |
| --- | --- |
| `lean` | cycle · implement · review · patch · done · next · intake · scout · burndown · dep-update · deploy-test · deploy-prod |
| `standard` | + unblock · wrap-up · pre-compact |
| `full` | + nightly · fan-out · cover · flake |

## Backends

The tracker sits behind one verb vocabulary (`issue view`, `pr create`, `merge-guard`, …), bound
today by `backends/github.jsonc` — GitHub issues and labels, nothing else. Status is a `status:*`
label on the issue, so "the board" is just the open issue list. Swapping (or adding) a tracker is
authoring one more `backends/*.jsonc` file, not touching a skill: `docs/BACKENDS.md` has the verb
table, the semantic flags a backend must set honestly (`auto_merge`, …), and the contract a new
one has to satisfy — including that a render is prose only, with no executable installed into the
consuming repo.

## Harnesses

Which AI coding tool runs the rendered skills sits behind `{{harness.*}}` fields, the same way the
tracker sits behind backend verbs. `.cycle/config.jsonc`'s `harnesses` array (default `["claude"]`)
picks one or more; `cycle update` renders a complete, independent skill tree per harness.

| | Claude Code | Codex CLI | Copilot CLI | OpenCode | Pi |
| --- | --- | --- | --- | --- |
| skills discovered at | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` | `.github/skills/<name>/SKILL.md` | `.opencode/skills/<name>/SKILL.md` | `.pi/skills/<name>/SKILL.md` |
| structured questions | `AskUserQuestion` | direct chat | `ask_user` | `question` | plain chat |
| parallel subagents | the Agent tool | subagents | task tool | task tool | none by design |

Full vocabulary, the honesty rule around capability flags, and how to add a harness:
`docs/HARNESSES.md`.

## Layout

```
.github/workflows/ci.yml    `npm test` + `cycle check` on PR + push to main
AGENTS.md               cross-harness repository entry point
bin/
  cycle.mjs            the CLI — Node ESM, zero dependencies (plus lazily-imported lint.mjs)
install.sh             symlink bin/cycle onto PATH
skills/
  cycle-setup/         guided install — personal skill, linked by install.sh
templates/
  DOCTRINE.md.tmpl     the §1–§10 spine
  skills/*.md.tmpl     one per skill
  overlays.jsonc       the overlay points, and what each is for
backends/*.jsonc       verb → command tables
harnesses/*.jsonc      discovery path, tool names, capability flags per AI harness
profiles/*.jsonc       which skills each profile installs
test/                  node --test; registry-driven profile × backend × harness matrix + coexistence
docs/
  AUTHORING.md         writing a template; the overlay points
  BACKENDS.md          the verb vocabulary; adding a backend
  HARNESSES.md         the harness.* vocabulary; adding a harness
  PATTERNS.md          reviewer-agent skeleton, hooks, permissions
  RELEASING.md         package boundary, preflight, and explicit publish gate
```

## Requirements

Node ≥ 20, git, and bash for `install.sh`. No dependencies, no build step. `gh` must be
authenticated for tracker operations; rendering, linting, and drift checks work offline.

## Adopting an existing repo

There used to be a `cycle adopt` command (and a `/cycle-adopt` skill) that reverse-engineered a
hand-written pipeline into config + overlays. It did its job: every legacy repo has converged onto
the shared templates, so the command was retired rather than maintained against a queue of zero.
If a hand-rolled pipeline ever needs converting again, resurrect it from git history
(`git log --diff-filter=D -- bin/adopt.mjs`) — or do it by hand: extract the repo facts into
`.cycle/config.jsonc`, move the irreducibly repo-specific prose into overlays, and diff each
skill against its rendered replacement before letting `cycle update` overwrite it.
