# Installing the-cycle

The recommended setup is agent-assisted and durable: keep one source clone on the computer, let
its installer link the command and personal setup skill, then let `/cycle-setup` adapt and verify
each consuming repository. The clone is what makes later checks and updates predictable.

## Requirements

- Node.js 20 or newer
- git
- bash for the durable installer
- an authenticated `gh` CLI before tracker operations

Rendering, linting, and drift checks work without network access.

## Recommended: ask your coding agent

Give this prompt to the agent already working in the repository you want to set up:

> Install the-cycle for durable use, then set it up in this repository. Verify Node.js 20 or
> newer, git, and bash first; `gh` must be authenticated before tracker operations. Before cloning
> or changing anything under my home directory, show me the exact paths and ask for approval. Once
> approved, use a clean clone of `https://github.com/brndnsh-labs/the-cycle` at
> `~/code/the-cycle` (update an existing clean clone on `main` with `git pull --ff-only`), run
> `~/code/the-cycle/install.sh`, confirm `~/.local/bin` is on `PATH`, and verify
> `cycle --version`. Restart or reload the coding harness if it does not discover the newly linked
> personal skill. Then run `/cycle-setup` in this repository through its operational readiness
> receipt. Pause for any approval the skill requires, and never hand-edit a rendered harness tree.

The agent should show the home-directory changes before making them, then finish repository setup
with evidence rather than a generic success message.

### The success boundary

Setup is complete when all four statements are true:

1. `cycle --version` works from an ordinary shell.
2. `/cycle-setup` reports **READY**: configured gates pass, tracker access and required labels are
   verified, rendered content was read, and `cycle check` is clean.
3. The receipt's exact `.cycle/` and configured harness paths are reviewed and committed together.
4. `/next` is available as the first-use handoff.

If the receipt says **NOT READY**, setup is not complete. Clear its named FAIL or UNVERIFIED rows
and rerun the affected checks.

## What the durable installer changes

`install.sh` creates symlinks, not copies:

- `~/.local/bin/cycle` points into the source clone.
- `/cycle-setup` is linked under `~/.claude/skills` and `~/.agents/skills`. Together those two
  personal roots cover every supported harness.

Because the links point into the clone, an ordinary pull updates the command and personal setup
skill immediately. The installer deliberately does not edit your shell profile; if
`~/.local/bin` is missing from `PATH`, it prints the exact line to add.

## Manual durable installation

If you prefer to do the durable step yourself, these examples use `~/code/the-cycle`; another
stable path works equally well.

```sh
git clone https://github.com/brndnsh-labs/the-cycle ~/code/the-cycle
~/code/the-cycle/install.sh
cycle --version
```

If the clone already exists, use the source-clone update procedure below instead of cloning over
it. Follow the PATH instruction if one appears, restart or reload a running harness, open the
consuming repository, and run:

```sh
/cycle-setup
```

## One-off or manual use

`npx` is useful for inspecting or rendering once without keeping a source clone:

```sh
npx --yes @brndnsh/the-cycle install --plan
npx --yes @brndnsh/the-cycle install
```

`npx` fetches the package into npm's cache and exposes it only for that execution; `--yes` accepts
the package-download prompt. The rendered repository skills stand alone, but the one-off path does
not provide the durable clone or personal `/cycle-setup` skill used for later maintenance. Use it
for deliberate one-off/manual work, not as the recommended everyday installation.

To drive a durable setup by hand after installing:

```sh
cycle install --plan                 # detected facts, open questions, and overlay points
cycle install --profile lean         # interview, write config, and render
cycle check                          # non-zero when setup is incomplete or drift exists
```

This route exposes the mechanism but does not replace `/cycle-setup`'s repository reading or
operational readiness checks.

## Updating

There are two repositories in the update story: the local **the-cycle source clone**, which owns
the renderer, and each **consuming repository**, which commits the generated pipeline.

### 1. Update the source clone

The source clone should be clean. Review anything printed by the first command before continuing:

```sh
git -C ~/code/the-cycle status --short
git -C ~/code/the-cycle switch main
git -C ~/code/the-cycle pull --ff-only
cycle --version
```

`--ff-only` refuses to invent a merge when local history has diverged. A normal pull does **not**
require another `install.sh` run: the existing symlinks already point into this clone.

**One-time 0.1.x upgrade note:** after the first pull to 0.2.0 or newer, rerun
`~/code/the-cycle/install.sh` once because the personal skill destinations were corrected. Later
ordinary pulls use the normal no-rerun rule.

### 2. Update one consuming repository

Start from its clean, current default branch:

```sh
cd /path/to/consuming-repo
git status --short
git switch main
git pull --ff-only
cycle check
cycle update --dry-run
cycle update
```

Review a non-zero pre-update `cycle check` or `cycle update --dry-run` as an expected indication
that reviewed upstream changes are pending, not permission to skip the diff. `cycle update` must
stop rather than use `--force` if it finds a hand-edited render.

Next, run every non-empty gate configured in `.cycle/config.jsonc`, then finish with:

```sh
cycle check
git status --short -- .cycle .claude/skills .agents/skills .github/skills .opencode/skills .pi/skills
git diff -- .cycle .claude/skills .agents/skills .github/skills .opencode/skills .pi/skills
```

Review the exact changed setup paths, stage only those paths, and commit config, state, overlays,
and every configured harness tree together. Run `git add -- path/one path/two ...`, replacing the
example paths with the exact reviewed paths from status, then finish with:

```sh
git commit -m "chore(cycle): update rendered pipeline"
git push
```

Do not stage unrelated work. If the repository has its own review or pull-request policy, follow
that policy for this commit.

### More than one computer

- The source clone is local installation state. Pull `~/code/the-cycle` on each computer that
  should run the latest `cycle` command.
- The consuming repository's `.cycle/` and harness trees are shared history. One computer runs
  `cycle update`, verifies, and commits the result; the others only pull that consuming-repository
  commit. They should not independently regenerate the same update.

### When to rerun `install.sh`

Rerun it after the first clone, for the one-time 0.1.x-to-0.2.x link correction described above,
after moving the source clone, after a symlink was removed or replaced, or when later release
notes explicitly say the link layout changed. Do not rerun it after an ordinary source-clone
pull. It is idempotent for links it owns and fails before writing if another file or directory
occupies a destination.

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
