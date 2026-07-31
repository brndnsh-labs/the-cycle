<!-- cycle:rendered template=DOCTRINE.md.tmpl hash=da246dcbb675 — managed by the-cycle; edit the template, not this file -->
# Pipeline doctrine (shared)

Single source of truth for the rules the the-cycle work-loop skills share. A skill that says
"see DOCTRINE §X" means *this* file. **If this isn't already in your context, read it once** —
within a session the read amortizes across every pipeline skill you run.

Reconcile here, not in the skills: when a rule changes, edit this file, not the skills that
restate it. The skills hold only their *unique* procedure.

---

## §1 Tracker & readiness

The tracker is the **Forgejo repo's issues** (`brandon/the-cycle`). A **story = an issue**: its **body** holds
Why / Touches / Acceptance; its **labels** hold routing (§3). **Milestones = epics.**

**Labels are the source of truth**; any board/project *view* is eyes-only — no skill writes it.

| Status | Meaning | Pipeline action |
| --- | --- | --- |
| **ready** | scoped + pickable | `/next` ranks & picks; `/implement`/`/cycle` build |
| **in-progress** | being built | don't re-pick |
| **in-review** | built, under review / PR open | don't re-pick |
| **needs-decision** | blocked on a human call | surface it; **don't build** |
| **blocked** | blocked on a dependency | skip; name the blocker |
| **(none)** | the idea pile, not a scheduled story | triage/scope it first; don't pick |

**Ranking pickable work** (`/next`): **milestone first** (a real numbered epic beats no milestone), then **issue number** (lower first).

**A closed issue is "done."** There is no `status/shipped`; `issue close` is the terminal step, and the merge guard drops any lingering `status/*` label as it closes — a closed issue never keeps one. Pass `--open` when picking work. The pipeline doesn't argue with the
close; it lets the close speak.

**A stale-*open* issue may already be shipped.** An umbrella/parent issue's slices often ship
under sibling-numbered PRs that never reference the umbrella's own number — `git log --grep=#<n>`
finds nothing even though the work is done. Before building a pickable-looking issue, trace
whether the described *behavior* already exists in live code (`git log -S"<symbol>"`, read the
actual function) — don't trust issue-number absence in history as proof no work has happened.

## §2 Labels

- **`finding`** — review debt, diff-coupled; **should trend to empty**. A cycle must not *grow*
  this set as a side effect — escalate only with Brandon's nod (§5).
- **`scout`** — provenance stamp on issues filed by a `/scout` sweep, so their origin stays
  visible later. Additive only; doesn't change routing.

**An issue carved from a review's out-of-scope observation arrives unrouted by design** — no
routing values set. Don't treat that as under-specification: routing is decided by the *picking*
skill at `/cycle` time, from what the diff actually touches, not at filing time.

## §3 Routing

- **Model:** **opus for everything** (spawned agents included).
- **Executor:** **`orchestrator-inline` by default** — the main thread builds directly,
  keeping accumulated context. **Spawn parallel agents only for
  independent mechanical work** (the same change across several files); keep shared-file edits
  (indexes, schema) and the validation gates on the main thread.
- **Reviewer** (`/review` routes by the diff):
  - The **inline correctness pass** — any non-trivial diff. The orchestrator reviews the diff
    itself (logic, edges, error paths, contracts, invariants). The heavyweight `/code-review` is
    **human-triggered** — the loop cannot invoke it; offer it on a large or risky diff and leave
    the call to Brandon.
  - **`/security-review`** — **additionally**, whenever the diff touches auth / tokens / secrets, schema / data migration, anything destructive or irreversible.
  - A **second-model angle** (a Sonnet pass over an opus diff, or vice-versa) is a cheap way to
    catch same-prior blind spots on a meaty diff.

**Re-verify agent claims:** a spawned agent's "gates green / tests pass" is a *claim*. Re-run the
gates **yourself** before trusting it — a spawned "all green" has failed in a clean shell before.

## §4 Gates

Local, before handing to `/review` or `/done` (never proceed over a red gate):

```
npm test
```

## §5 Judgment calls & autonomy

**Default: run the whole chain unattended** for self-contained, gate-verifiable, non-destructive
stories; Brandon reviews the *result*. **Tier does not gate autonomy** — it only picks the
executor's model. What gates a pause is a **judgment call**.

**Stop and surface — the always-brake set:**
- **auth / tokens / secrets** — Brandon wants to *see* these even when the cycle could proceed.
- **schema / data migration** — Brandon wants to *see* these even when the cycle could proceed.
- **anything destructive or irreversible** — Brandon wants to *see* these even when the cycle could proceed.
- A review finding needs a **design decision**, is **P0**, or **contradicts a memory note**.
- An **implementation choice is genuinely ambiguous** with no obvious default — surface options +
  a recommendation, don't guess.
- **Gates/CI red**, an agent returned **Blocked**, or a spawned "green" that doesn't reproduce.

When the work is well-specified, run it. When in doubt about a *decision*, surface it.

**Findings get actioned, not parked:** `/patch` fix-now is the default (P0/P1/bounded-P2); too-big
= *escalate* to a `finding` issue with Brandon's nod, never a silent defer. An implementer's
own "out of scope, defer to follow-up" tag does **not** override this — if the deferred item would
falsify the story's stated `Acceptance:` criterion, it's in scope regardless of the tag.

**Plans are status updates, not confirmation gates.** Every pipeline skill presents its plan
(`## Plan` / `## Cycle plan` / `## Review plan` / `## Patch plan`) before acting — that's for
visibility, so Brandon can see and redirect. It is **not** a "Proceed?" prompt to wait on.
Present the plan, then continue in the same turn unless the plan *itself* surfaces a judgment call
from this section. This applies whether a skill is driven by `/cycle` or invoked directly.

**The autonomous safe set (`/burndown`).** The unattended grinders operate on the **negation of the
always-brake set**: an item is safe only if it is *none* of the classes above AND is
well-specified, small-to-medium, single-area, and **gate-verifiable** (provable by §4). When
unsure, **exclude and surface** — a mis-graded autonomous merge costs trust; a skipped-safe item
only costs throughput.

## §6 Merge guard

The pipeline pushes + opens PRs. **Auto-merge SAFE stories** (none of §5's always-brake classes,
AND green CI); **a judgment-call story's PR is left open for Brandon's manual merge** —
report "ready for your merge: <url>" + *why* it's gated.

There is **no server-side auto-merge-on-green** here, so the **poll-then-merge guard IS the
enforcement**. Never use a fire-and-forget auto-merge flag — with nothing to wait on it merges
immediately. Run the guard in the **background** (the poll takes minutes; a foreground `sleep` is
harness-blocked):

```bash
node scripts/forgejo-merge.mjs "<pr>" --closes "<n>" &
```

**Always pass `--closes`** — the issue number(s) already in hand, or **`none`** when the merge should close nothing (a multi-phase PR: "Phase 2a of #539"). The guard's body-regex scan is only a fallback for an ad-hoc merge with no `--closes`, and it fires on any `Closes #n` token in prose — even "will close #539 later" (bit on a real PR). Editing the body after launch doesn't help; the guard snapshots it at registration.

**Reading a red gate.** Logs come from `node scripts/ci-logs.mjs "<run>"`.
The most recent *failing* run is `node scripts/ci-logs.mjs --failed` — it scans
back through the run list. A red CI is diagnosable, so **"retry and see" is not
an acceptable first move** — read the log, then decide transient-vs-real. §5 still makes an
unexplained red a hard stop.

After a safe merge: **sync local main** (`git checkout main && git fetch origin && git reset --hard
origin/main`) and prune the branch.

**The harness's own auto-mode classifier can independently deny the background merge command**, even
on a safe story with everything above satisfied. That's an environment-level permission gate, not a
pipeline judgment call, and no skill text can route around it. If it fires: report the open,
CI-pending PR and ask Brandon for a one-turn approval to re-run the merge (or to
merge it himself). Don't treat the denial as a §5 pause, and don't retry with `--no-verify` or
other workarounds.

## §7 Tracker mechanics

Routing values are label namespaces. Read one by finding the label with the prefix and stripping it: `labels.find(l => l.startsWith('status/'))?.slice('status/'.length)`. `forgejo-project.mjs` enforces one label per namespace and preserves workflow labels (`bug`, `area:*`, `finding`, `scout`).

- **Read the tracker:** `node scripts/forgejo.mjs list --open`
- **Read one issue:** `node scripts/forgejo.mjs issue view "<n>"`
- **Write a routing value:** `node scripts/forgejo-project.mjs status "<n>" "<Status>"` (or `node scripts/forgejo-project.mjs set-field "<n>" "<Field>" "<Value>"`)
- **Bulk writes:** **always** `node scripts/forgejo-project.mjs batch "<file.json>"` — an array of `{issue, field, value}`,
  grouped into one read + one write per issue. Never loop single-op writes.
- **Issue/PR ops:** `node scripts/forgejo.mjs issue create --title "<title>" --body "<body>" --label "<label>"` · `node scripts/forgejo.mjs issue comment "<n>" "<text>"` ·
  `node scripts/forgejo.mjs issue close "<n>"` · `node scripts/forgejo.mjs pr create --head "<branch>" --base main --title "<title>" --body "<body>"`

**Unreachable → STOP.** All three scripts exit **3** and print `unreachable` on a connection failure. Stop and say so — never fall back to a cached list or a frozen markdown tracker.

## §8 Commit & PR conventions

- **Conventional Commit** (`feat(scope)` / `fix` / `docs` / `chore` / `test`), scoped to the area;
  body names the story. Ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```
- **`git add <explicit paths>` — never `-A` / `.`**. Never `--no-verify`; never amend; never
  **force**-push.
- **PR:** base `main`, a "what shipped + which findings were actioned" narrative as the body,
  **with `Closes #<n>`** (closing the issue is the done-signal), title = the Conventional-Commit
  subject. PR bodies end with:
  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```
- The `Closes/Fixes/Resolves #N` keyword fires **anywhere** in the body regardless of surrounding
  prose — writing "`Closes #844` is NOT set" still closes #844. When carving one item out of a
  multi-item umbrella issue, never put that token next to the umbrella's number at all, not even to
  deny it — write "part of #844" instead.
- Post a one-line issue comment linking the PR; the narrative lives in the PR body.

## §9 Branch policy

- **Issue work → a feature branch + PR**, always. Never build on `main`; `/implement` branches
  (`git checkout -b <short-slug>`), reusing an epic branch if one exists.
- **No minor-edit carve-out.** `main` is protected against *all* direct pushes — skills, scripts,
  ops notes and docs each need their own branch + PR, even though most auto-merge immediately (§6).
- **Branch off freshly-fetched `origin/main`, not local `main`.** A squash-merge PR is based
  against `origin/main` HEAD, not your local HEAD — if local `main` carries commits never pushed to
  origin, cutting a branch off it silently folds those unpushed commits into your feature's squash
  commit (content survives, but loses its own commit identity). `git checkout main && git fetch
  origin && git reset --hard origin/main` before branching avoids it; the tell after the fact is
  `git pull --ff-only` refusing to fast-forward with local-ahead commits that aren't yours.
- **Local branches don't clean up on their own.** The merge guard deletes the *remote* branch but
  never the local one, and they pile up silently across sessions. Periodically: `git fetch --prune
  origin`, confirm zero open PRs, then bulk `git branch -D` everything but `main` and the current
  branch (`-D` because a squash-merged branch is never a literal ancestor, so plain `-d` refuses
  every one) — safe, since the commits stay recoverable via reflog.

## §10 Filing an issue

Shared by `/scout` (machine-found) and `/intake` (human-described). Both *find or interview, then
file* — neither fixes, branches, or merges.

1. **Dedup first.** Search open issues before filing. A near-duplicate gets a comment on the
   existing issue, not a new one.
2. **The bar is *actionable*.** An issue nobody could pick up and start is noise. If it can't be
   stated as Why / Touches / Acceptance, it isn't ready to file — keep interviewing, or don't file.
3. **Shape it so the smallest human input unlocks it.** Prefer a pre-drafted fix with a
   yes/no decision over an open-ended question. A finding that arrives with the diff already
   written costs Brandon one glance; the same finding as a paragraph costs a work session.
4. **Body format:**
   ```
   **Why:** <the problem, and what's wrong today — with file:line evidence>
   **Touches:** <files / surfaces>
   **Fix (drafted):** <the concrete change — a diff, or the exact edit>
   **Acceptance:** <the observable condition that means it's done>
   ```
   The **Fix** line is mandatory for a machine-found finding (`/scout` read the code; the draft
   is the point) and best-effort for a human-described idea (`/intake` interviews toward it but
   files without it when the idea is scope, not a defect).
5. **Classify, don't over-classify.** Set what you know; leave routing to the picking skill (§2).
6. **Budget.** Filing zero is a success. A sweep that files 20 low-grade issues has made the queue
   worse, not better. Cap a focused pass at **3–5** findings; a multi-lens sweep caps *per lens* and
   stays in single digits overall. Rank by (impact × how-actionable) and file only the top ones —
   mention the rest in the report without filing.
