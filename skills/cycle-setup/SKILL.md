---
name: cycle-setup
description: Install the-cycle's work pipeline into this repo, adapted to it. Reads the codebase to answer the setup questions properly — gates, risk surfaces, tracker vocabulary — instead of accepting generic defaults, drafts the overlays that carry repo-specific content, then proves the result with an operational readiness receipt. Also reconciles a repo that already has hand-written skills. Use for a first install, or to redo a setup that was rushed. Plan-first; writes nothing until you approve.
---

# /cycle-setup

`cycle install` can guess a repo's name and gates. It cannot know what breaks this codebase
irreversibly, which directories deserve which reviewer, or what "ready" means here. Those are
reading problems, and reading is what you're for.

**Your output is data, never prose that ships.** You write `.cycle/config.jsonc` and
`.cycle/overlays/*.md`. The renderer writes every configured harness tree (for example,
`.claude/skills/` and `.agents/skills/`). Never hand-write or hand-edit a rendered skill — one
that doesn't match its template is drift, and `cycle check` will report it as a defect for as
long as it survives.

## 0. Orient

```sh
cycle install --plan          # JSON: detected values, open questions, overlay points
```

Writes nothing. If it reports `existing_config`, this repo is already installed — you're doing a
re-setup, so read the current config before proposing changes and treat every existing value as a
decision someone made until you find evidence otherwise.

If the repo has hand-written skills in a supported harness root with no `.cycle/` directory, it predates
the-cycle. **Stop and surface it** — the automated conversion path (`cycle adopt`) was retired
after the last legacy repo converged, so reconciliation is now a deliberate manual job: extract
the repo facts into config and overlays, then diff each hand-written skill against its rendered
replacement before letting `cycle update` overwrite anything. Never render over hand-written
content without that comparison.

## 1. Read the repo before answering anything

Budget real effort here. Every question in the plan has a defensible answer sitting in the
codebase; the defaults are placeholders, and shipping them is the failure mode this skill exists
to prevent.

- **Gates** — the plan reads `package.json` scripts. Confirm they exist and actually gate
  something. Check CI config for gates that no script name reveals. A gate that doesn't run is
  worse than no gate: it makes green meaningless.
- **Brakes** (DOCTRINE §5, the always-stop list) — the highest-value question here. What in *this*
  codebase is irreversible or expensive to get wrong? Auth and token handling, schema migrations,
  anything touching money or user data, destructive operations, a public API's shape, key or
  crypto material. Name the surfaces this repo actually has. Generic brakes are close to useless —
  they name risks the repo doesn't run and miss the ones it does.
- **Tracker vocabulary** — read the real labels or board columns, not the defaults. If you can't
  reach the tracker, say so and use the defaults, flagged as unverified. You may draft and render
  from that provisional answer, but the final receipt is **NOT READY** until tracker access and
  every required label are verified.
- **Backend** — not a question the plan asks: `github` is the only backend the-cycle binds today
  (see `docs/BACKENDS.md`), so there is nothing to confirm. If this repo's issues genuinely live
  somewhere else, there is no backend for that yet — **stop and say so** rather than rendering
  GitHub verbs over the wrong tracker.
- **Profile** — `lean` unless the repo already does the thing a bigger profile assumes. Don't
  install `/nightly` because it sounds useful; install it when there's an overnight lane.
- **Harnesses** — which AI coding tool(s) actually run here. Detect before asking: a `.claude/`
  tree means Claude Code, `AGENTS.md` or a `.agents/` tree means Codex CLI, a `.github/` skills
  convention means Copilot CLI. More than one can be configured together — each gets its own
  complete, independent skill tree. Default to what's detected; ask only when nothing points at
  an answer. `cycle install --plan` lists the full registry as `options`.

## 2. Ask only what reading can't settle

Use the current harness's structured-question tool for genuine forks: a profile call that hinges
on intent rather than evidence, a brake surface you can argue either way. Recommend one option
and say why.

Do not ask what the codebase already answers. A question you could have resolved by reading is a
tax on the person you're supposed to be helping.

## 3. Propose, then write

Present the config you intend to write — the values that differ from the draft, and why each
changed. Get a nod. Then write `.cycle/config.jsonc`.

Keep the comment header the file ships with. It explains the file to whoever opens it in six
months.

## 4. Draft the overlays that earn their place

The plan lists every overlay point with its purpose, the shape its content should take, and when
it's worth having. All are optional, and **an empty overlay is better than a vague one** — vague
guidance gets followed, which is worse than absent guidance getting noticed.

Two are worth real effort in almost any repo:

- **`review-routing`** — the path→reviewer table. Without it `/review` has no idea what this
  repo's risky surfaces are. Derive it from the actual directory structure and where complexity
  concentrates. If the repo has no reviewer agents yet, write the table against the domains
  anyway and note which agents don't exist — that list is the backlog for writing them.
- **`scout-lenses`** — what each lens looks for *here*. Quote real patterns from real files.
  Generic lenses find generic nothing.

Write the rest only where you found something concrete. `dep-update-landmines` needs a dependency
that has actually caused trouble; `deploy` needs a real topology. Skip the ones you'd have to
invent, and say which you skipped and why.

## 5. Render and inspect

```sh
cycle update                  # renders every configured harness skill tree
```

Then **read what was produced** — at minimum `DOCTRINE.md`, `/next`, and one overlay-heavy skill.
A clean render of a skill that says something false about this repo is the outcome to catch here,
and only reading catches it. Fix by changing config or overlays and re-rendering, never by editing
the rendered file.

## 6. Prove operational readiness

Setup is not complete because files rendered. Prove that the repository can actually use the
pipeline, and keep unknown distinct from passing.

### Repository gates

Read `.cycle/config.jsonc`. If `gates.commands` is present, run every non-empty command in that
array. Otherwise run every non-empty string-valued configured gate. Run the commands exactly as
configured — do not replace, weaken, or silently skip one. Record one row per command:

- **PASS** — the command ran and exited zero.
- **FAIL** — it ran and exited non-zero. Preserve the useful diagnostic and stop calling setup
  ready.
- **UNVERIFIED** — the environment prevented a real run even after using the harness's supported
  retry or approval path. Name the constraint; never translate it into PASS.

If no gate is configured, record the gate surface as **UNVERIFIED — no repository gate
configured**. Do not invent a command, and do not report READY.

### Tracker and required labels

Use read-only GitHub CLI calls first, from the repository root:

```sh
gh repo view --json nameWithOwner,url
gh issue list --state all --limit 1 --json number
gh label list --limit 1000 --json name
```

The first result must identify the repository configured in `repo.slug`; the issue call must
succeed even when its result is an empty array. Compare the label names by **exact equality** with
every `tracker.statuses[].name` in config. A failed read is **UNVERIFIED**, a repository mismatch
is **FAIL**, and any missing required label is **FAIL**. All three block READY.

If labels are missing, list their exact names, descriptions, and target repository. Creating them
is an external tracker mutation and an auth surface: get a **fresh explicit approval** for that
exact list before running any write. A general setup nod is not approval. After approval, create
only the confirmed missing labels, without `--force`:

```sh
gh label create "<exact name>" --description "<configured meaning>"
```

If approval is declined, leave the labels missing and the receipt NOT READY. If it is granted,
re-run the read-only label list and require every exact name to be present before changing the
label row to PASS. Never print tokens or credential-bearing remotes while diagnosing access.

### Render consistency and commit boundary

```sh
cycle check                  # must report clean
git status --short -- .cycle <each configured harness root>
```

`cycle check` is **PASS** only when it exits zero and reports clean. Translate the scoped Git
status into the exact changed paths to commit; do not write a vague `.cycle/` or harness-tree glob,
and do not include unrelated dirty files. Config, overlays, state, and every rendered harness tree
belong in the same commit.

## Report

End with this operational receipt, after the setup-decision summary:

```text
Setup readiness: READY | NOT READY

Surface                    Result                 Evidence
configured gate: <command> PASS|FAIL|UNVERIFIED   <exit/result or constraint>
tracker repository/access PASS|FAIL|UNVERIFIED   <resolved repo or diagnostic>
required status labels     PASS|FAIL|UNVERIFIED   <verified names or missing names>
rendered content review    PASS|FAIL               <files read and any correction>
cycle check                PASS|FAIL               <clean or diagnostic>

Exact files to commit:
- <one changed path per line, or "none">

First use after that commit: /next
```

**READY is allowed only when every surface is PASS.** Any FAIL or UNVERIFIED makes the headline
NOT READY; name the shortest action that would clear each blocker and rerun the affected check.
Do not offer `/next` as immediately usable until the receipt is READY — it is the first-use
handoff after the verified setup is committed.

Before the receipt, summarize:

- Profile, backend, and harnesses, with the evidence for each.
- Every config value that differs from the draft, and why.
- Overlays written, and overlays deliberately skipped.
- Anything you couldn't verify — an unreachable tracker, a gate you couldn't run, a guessed brake.
  Say it plainly; the receipt must carry the same uncertainty.

## Rules

- **Never write under a configured harness skill tree.** Config and overlays are yours; skills
  are the renderer's.
- **Never invent a gate command.** If you can't confirm it runs, leave it out and say so.
- **Never call setup READY with a failed or unverified gate, tracker read, required label, content
  review, or `cycle check`.** Rendering is necessary evidence, not operational proof.
- **Never create or update a tracker label without fresh explicit approval** for the exact
  repository and labels. Missing-label repair creates only what was approved and never uses
  `--force`.
- **A wrong brake is expensive in both directions** — a missing one lets an agent make an
  irreversible change alone; a spurious one stops work that should have proceeded. Argue for each
  from something in the codebase.
- **Stop rather than render over an unsupported tracker.** `github` is the only backend the-cycle
  binds; a repo whose issues genuinely live elsewhere has nothing to adopt onto yet, and writing to
  the wrong tracker is silent and hard to undo.
