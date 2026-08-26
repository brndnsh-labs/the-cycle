# the-cycle

An installable, self-updating work pipeline for AI coding harnesses — Claude Code, Codex CLI,
Copilot CLI, OpenCode, and Pi.

`the-cycle` renders a set of skills — `/cycle`, `/implement`, `/review`, `/patch`, `/done`, and a
maintenance layer around them — into any repository, adapted to that repository's gates, tracker,
and risk surfaces. Improvements made here propagate outward with `cycle update`, and `cycle check`
reports when an installed copy has drifted.

## Why this exists

The same pipeline was copy-pasted into three repositories and diverged in all three. Hand-carried
fixes usually did not reach the other copies, so bugs and stale assumptions remained fixed in one
place and broken in another. The divergence was not the problem; **silent** divergence was.

The two features that matter most are therefore:

- `cycle update` propagates reviewed pipeline improvements.
- `cycle check` makes local and upstream drift visible.

## How it works

Every repository-specific value lives in a generated binding file, leaving the shared skill
templates portable:

- **Backends** bind tracker operations such as issue reads and PR creation. GitHub is the backend
  available today. See [Backends](docs/BACKENDS.md).
- **Harnesses** describe which coding tool runs the skills and where that tool discovers them. See
  [Harnesses](docs/HARNESSES.md).
- **Overlays** hold the irreducibly repository-specific guidance a template cannot generalize,
  such as reviewer routing and scout lenses. See [Authoring](docs/AUTHORING.md).
- **Drift detection** records provenance in every rendered file. `cycle check` distinguishes a
  locally edited render from a render whose source template has moved upstream.

## Quick start

Run the guided installer from the repository you want to configure:

```sh
npx --yes @brndnsh/the-cycle install
```

That command performs a one-off first render without requiring a clone. The rendered skills keep
working, but `cycle update`, `cycle check`, and the personal `/cycle-setup` skill require a durable
installation.

After a durable installation, the everyday commands are:

```sh
/cycle-setup                         # inspect this repository and guide its first setup
cycle check                          # report local or upstream drift
cycle update                         # re-render and show the resulting diff
```

See [Installing the-cycle](docs/INSTALLING.md) for the durable install, the manual setup path, and
a prompt you can hand to a coding agent.

## Profiles

Machinery is opt-in: a repository takes on a lane when it earns it.

| Profile | Skills |
| --- | --- |
| `lean` | cycle · implement · review · patch · done · next · intake · scout · burndown · dep-update · deploy-test · deploy-prod |
| `standard` | + unblock · wrap-up · pre-compact |
| `full` | + nightly · fan-out · cover · flake |

## Backends

The tracker sits behind a verb vocabulary (`issue view`, `pr create`, `merge guard`, and so on).
GitHub issues and labels are the only bound tracker today. Status is a `status:*` label on the
issue, so the open issue list is the board.

Adding another tracker means implementing the backend contract, not rewriting every skill. The
complete vocabulary and its required semantics are documented in [Backends](docs/BACKENDS.md).

## Harnesses

The configured harnesses each receive a complete, independent skill tree.

| | Claude Code | Codex CLI | Copilot CLI | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- |
| skills discovered at | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` | `.github/skills/<name>/SKILL.md` | `.opencode/skills/<name>/SKILL.md` | `.pi/skills/<name>/SKILL.md` |
| structured questions | `AskUserQuestion` | direct chat | `ask_user` | `question` | plain chat |
| parallel subagents | Agent tool | subagents | task tool | task tool | none by design |

See [Harnesses](docs/HARNESSES.md) for the capability contract and instructions for adding a
harness.

## Requirements

Node.js 20 or newer, git, and bash for the durable installer. The CLI has no runtime dependencies
and no build step. `gh` must be authenticated for tracker operations; rendering, linting, and
drift checks work offline.

## Documentation

- [Installing](docs/INSTALLING.md) — bootstrap, durable installation, agent-assisted setup, and
  existing-pipeline reconciliation.
- [Development](docs/DEVELOPMENT.md) — local gates, generated-source rules, and repository layout.
- [Behavioral evaluation](docs/EVALUATION.md) — compare model behavior against two pipeline
  revisions in isolated fixtures.
- [Authoring](docs/AUTHORING.md) — write templates and overlays and propagate their changes.
- [Backends](docs/BACKENDS.md) — tracker verbs and backend semantics.
- [Harnesses](docs/HARNESSES.md) — harness fields, capabilities, and discovery paths.
- [Patterns](docs/PATTERNS.md) — reviewer-agent, hook, and scoped-instruction patterns.
- [Releasing](docs/RELEASING.md) — package boundaries, preflight, and the explicit publish gate.
