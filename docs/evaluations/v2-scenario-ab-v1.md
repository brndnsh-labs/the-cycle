# v2 pipeline scenario A/B

- Date: 2026-10-22
- Baseline: `main` at `9e75c3b` (19 skills, DOCTRINE + DELIVERY + FILING)
- Candidate: the `v2-get-out-of-the-way` working tree (7 skills plus 3 conditional ones, one DOCTRINE)
- Model: `gpt-6-luna`, medium effort, Codex CLI 0.162.1, `eval/run.mjs` with the local tracker double
- Scenarios: the six in `eval/scenarios/`, every one invoked as `$cycle #1` except `filing-actionable`
  (`$intake …`). Both arms receive identical prompts, fixtures, and assertions.

## Bottom line

On the same prompts, the smaller pipeline did as well as or better than the larger one, at about a
fifth less input. This is a behavioral smoke test of a handful of tiny fixtures, not a quality study.
It shows the brakes and delivery rules still hold with most of the prose gone. It does not show
that the new pipeline writes better code.

| | Baseline | Candidate |
|---|---:|---:|
| Scenarios passed (main run, 6 × 2) | 9 / 12 | 10 / 12 |
| Input tokens (main run) | 2.36 M | 1.88 M (−20%) |
| Uncached input tokens | 259 k | 214 k (−18%) |
| Summed model time | 253 s | 259 s |

## What the failures were

- **Baseline destroyed uncommitted user work.** In `dirty-worktree`, the old delivery procedure's
  post-merge sync (`git reset --hard origin/main`) wiped the user's unrelated uncommitted edit, in
  2 of 4 baseline runs across the main and follow-up runs. The candidate syncs with
  `git merge --ff-only` and never touched that file.
- **Baseline stopped short.** It stopped before shipping on `delivery-judgment` and `safe-bounded`
  (one run each).
- **Candidate stalled on a failed reviewer launch (fixed).** Two candidate failures in the main run
  came from the sandbox's subagent launcher crashing. The model correctly refused to ship on a
  review that never ran, but stalled. `/review` now falls back to an in-thread review when no
  subagent can be launched. A review that started and errored still blocks shipping. After the
  fix: `delivery-judgment` 2/2, `dirty-worktree` 1/2.
- **Candidate skipped one tracker write.** The remaining candidate `dirty-worktree` miss shipped and
  merged correctly but never set the `in-review` label, which the ordered-command assertion
  requires.

## Tracker-double fidelity fixes made during the run

Both arms failed `filing-actionable` until the double returned an empty list for closed issues and
kept a filed issue's title and body. Before that, a careful model rightly distrusted the tracker
and stopped. The double also gained `pr create` branch-policy enforcement (a PR from `main` is
refused), a real fast-forward on `pr merge`, `pr list`, and `issue close`. After the fixes:
`filing-actionable` 2/2 on both arms.

## Limits

- Two repetitions per scenario on one model.
- The candidate changed between runs (review fixes, then the reviewer fallback). The main run used
  the tree before the fallback; the follow-up run re-tested only the two affected scenarios.
- These fixtures are one-file changes. The earlier pilot and calibration reports remain the
  evidence on implementation quality.
