# Installing the-cycle

The quick bootstrap renders the pipeline once without requiring a clone. A durable installation
adds the `cycle` command and the personal `/cycle-setup` skill so the installed pipeline can be
checked and updated later.

## Requirements

- Node.js 20 or newer
- git
- bash for the durable installer
- an authenticated `gh` CLI before tracker operations

Rendering, linting, and drift checks work without network access.

## Bootstrap a first render

Run this from the repository you want to configure:

```sh
npx --yes @brndnsh/the-cycle install
```

`npx` downloads the published package into its ephemeral cache and runs the guided installer.
`--yes` accepts npm's package-download prompt. The rendered skills stand alone after that first
run, but later `cycle update` and `cycle check` commands need the durable clone below.

## Install for everyday use

Clone the canonical GitHub repository into a durable location and run its installer. These
examples use `~/code/the-cycle`; another stable path works equally well.

```sh
git clone https://github.com/brndnsh-labs/the-cycle ~/code/the-cycle
~/code/the-cycle/install.sh
```

`install.sh` links `bin/cycle` into `~/.local/bin` and links `/cycle-setup` into the personal skills
directories used by Claude Code, Codex CLI, Copilot CLI, OpenCode, and Pi. Follow the installer's
instruction if `~/.local/bin` is not already on `PATH`, then restart or reload a running harness if
it does not discover the newly linked skill.

Verify the command before setting up a repository:

```sh
cycle --version
```

## Set up a repository

The personal skill is the preferred path because it reads the repository before answering setup
questions:

```sh
/cycle-setup
```

To drive the same process by hand:

```sh
cycle install --plan                 # show detected values and every open question
cycle install --profile lean         # interview, write config, and render
cycle check                          # report drift; non-zero exit when drift exists
cycle update                         # re-render and show the resulting diff
```

`cycle install` can detect a repository's name, remote, and likely gate commands. It cannot infer
what would break that repository irreversibly or what “ready” means there. Setup is guided so
those risk and workflow decisions remain explicit.

## Ask a coding agent to install it

Give an agent this prompt when you want it to bootstrap the durable install and set up the
repository it is already working in:

> Install the-cycle for durable use, then set it up in this repository. Verify Node.js 20 or
> newer, git, and bash first; `gh` must be authenticated before tracker operations. Before cloning
> or changing anything under my home directory, show me the paths and ask for approval. Once
> approved, clone `https://github.com/brndnsh-labs/the-cycle` to `~/code/the-cycle` (or inspect the
> existing clone), run `~/code/the-cycle/install.sh`, make sure `~/.local/bin` is on `PATH` as the
> installer directs, and verify `cycle --version`. Restart or reload the coding harness if it does
> not discover the newly linked personal skill. Then run `/cycle-setup` in this repository and
> follow it; do not hand-edit generated harness skill trees.

## Reconcile an existing hand-written pipeline

There used to be a `cycle adopt` command and a `/cycle-adopt` skill that reverse-engineered a
hand-written pipeline into config and overlays. They were retired after the legacy repositories
had converged rather than maintained against an empty queue.

If another hand-written pipeline needs converting, recover the old implementation from git
history (`git log --diff-filter=D -- bin/adopt.mjs`) or reconcile it deliberately:

1. Extract repository facts into `.cycle/config.jsonc`.
2. Move irreducibly repository-specific guidance into `.cycle/overlays/*.md`.
3. Diff each existing skill against its rendered replacement.
4. Only then let `cycle update` replace the hand-written skill tree.

Never render over hand-written agent guidance without comparing it first.
