---
name: cycle-setup
description: Install the-cycle's work pipeline into this repo, adapted to it. Reads the codebase to answer the setup questions properly — gates, risk surfaces, tracker vocabulary — instead of accepting generic defaults, then drafts the overlays that carry repo-specific content (reviewer routing, scout lenses, deploy topology). Also reconciles a repo that already has hand-written skills. Use for a first install, or to redo a setup that was rushed. Plan-first; writes nothing until you approve.
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
  reach the tracker, say so and use the defaults, flagged as unverified.
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

## 5. Render and verify

```sh
cycle update                  # renders every configured harness skill tree
cycle check                   # must report clean
```

Then **read what was produced** — at minimum `DOCTRINE.md`, `/next`, and one overlay-heavy skill.
A clean render of a skill that says something false about this repo is the outcome to catch here,
and only reading catches it. Fix by changing config or overlays and re-rendering, never by editing
the rendered file.

## Report

- Profile, backend, and harnesses, with the evidence for each.
- Every config value that differs from the draft, and why.
- Overlays written, and overlays deliberately skipped.
- Anything you couldn't verify — an unreachable tracker, a gate you couldn't run, a guessed brake.
  Say it plainly; a silent guess here becomes a rule every skill enforces.
- The suggested next step: commit `.cycle/` and every configured harness tree together, so config
  and rendered output stay in sync in history.

## Rules

- **Never write under a configured harness skill tree.** Config and overlays are yours; skills
  are the renderer's.
- **Never invent a gate command.** If you can't confirm it runs, leave it out and say so.
- **A wrong brake is expensive in both directions** — a missing one lets an agent make an
  irreversible change alone; a spurious one stops work that should have proceeded. Argue for each
  from something in the codebase.
- **Stop rather than render over an unsupported tracker.** `github` is the only backend the-cycle
  binds; a repo whose issues genuinely live elsewhere has nothing to adopt onto yet, and writing to
  the wrong tracker is silent and hard to undo.
