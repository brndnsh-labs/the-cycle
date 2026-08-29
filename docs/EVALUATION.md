# Behavioral evaluation

The deterministic repository gates prove that skills render and remain internally consistent.
They cannot prove that a workflow instruction changes agent behavior. The on-demand evaluator
compares a baseline the-cycle snapshot with a candidate while holding the fixture, task, model,
permissions, gates, and assertions constant.

From a clone of this repository:

```sh
node eval/run.mjs \
  --baseline HEAD \
  --candidate . \
  --model MODEL_ID \
  --output /tmp/cycle-eval-run
```

`HEAD` is a git ref in this repository; `.` may include uncommitted template work. Each arm is
rendered into its own physical repository and uses a local `gh` double, so scenarios do not write
to GitHub. Codex must already be authenticated through its `CODEX_HOME` login; ambient credential
variables are not forwarded.

Snapshots are untrusted data inputs, not executable renderers. The runner copies only the selected
snapshot's `templates/`, `backends/`, `harnesses/`, and `profiles/` trees into a temporary render
stage, rejects symlinks and special files in path-based inputs, and places them beside its own
reviewed `bin/cycle.mjs` and package metadata. A snapshot's `bin/cycle.mjs` is hashed as source
provenance but never executed. This evaluator therefore compares skill data, not candidate engine
behavior; engine changes need a separately sandboxed evaluator.

The evaluator also pins the Codex discovery layout to `.agents/skills/<name>/SKILL.md`. Snapshot
harness capabilities and prose still participate in the comparison, but discovery-root and skill
filename changes need a separate evaluator; letting untrusted data choose arbitrary fixture output
paths could turn a rendered template into code that a later fixture gate executes.

For the runner repository itself, path inputs retain commit and dirty-worktree metadata. Arbitrary
external path inputs are not Git-inspected—the runner records their content hash and leaves commit
and dirty state unknown, avoiding checkout-configured hooks before isolation exists.

The runner uses
[`codex exec --json`](https://developers.openai.com/codex/noninteractive) and records the event
stream, tracker and gate commands, token usage when Codex reports it, the final diff,
source/skill/fixture hashes, the trusted renderer hash, and deterministic assertions in the
requested output directory. It does not copy authentication into the fixtures: renderer and model
launches both use explicit environment allowlists and isolated homes. The Codex launcher retains
its existing login through `CODEX_HOME`, while model-generated commands receive a core-only
environment, an empty evaluation home, no network access, and no approval path out of the workspace
sandbox.

Start with the default single matched run. If the arms differ, or the result will justify a
meaningful instruction change, add `--repeat 3` to repeat both arms. `--scenario <id>` narrows the
run to one targeted behavior.

Model-backed runs are externally metered and intentionally absent from `npm test` and CI.
Ordinary tests exercise fixture isolation, the tracker double, JSONL parsing, assertions, and
result formatting with a fake Codex executable. A behavioral FAIL is evidence in `results.jsonl`,
not a merge-gate exit code; invalid runner or harness execution exits 2.

## Release Relay review study

`eval/review/` is a separate preregistered retrospective study for one narrower public claim:
pre-existing repository-specific review guidance helps one strong model find consequential edge
cases and give more actionable review evidence than the same model with a strong generic prompt.
The [case census](../eval/review/CENSUS.md) is purposive and illustrative; it is not a defect-rate
or prevalence sample.

The frozen protocol contains four flawed Release Relay changes, two named-target-clean controls,
two arms, and three repetitions. That is 18 matched pairs and 36 valid scored cells. Model, effort,
timeout, prompt, schema, permissions, ordering seed, fixture commit time, invalid-pair rule, captured
original tasks, normalized tasks, guidance, source trees, candidate patches, repairs, hidden
oracles, census, and score schema are all hashed before scoring.

### Model-free validation

Use a local Release Relay checkout containing the pinned public commits. Historical lockfiles must
be present in pnpm's store so verification can remain offline. If the cache is incomplete, populate
it explicitly:

```sh
node eval/review/run.mjs fetch-cache \
  --source ../release-relay \
  --allow-network
```

That is the only dependency-network step. It uses a private temporary home, does not inherit npm
credentials, fetches from the public npm registry, runs no package lifecycle scripts, and does not
invoke a model. It is never called automatically by preflight or scoring.

Then run both model-free checks:

```sh
node eval/review/run.mjs dry-run --output /tmp/review-eval-dry

node eval/review/run.mjs preflight \
  --source ../release-relay \
  --output /tmp/review-eval-preflight
```

The fake run exercises the complete seeded schedule, a deliberately invalid cell and paired retry,
successful content-backed reads of both guidance files, normalization, blinded scoring input, and
private artifact writing. `dry-run-batch` exercises the same path one matched pair at a time and
resumes from the same output directory:

```sh
node eval/review/run.mjs dry-run-batch --output /tmp/review-eval-dry-batched
```

Repeat that command 18 times; each successful invocation prints a receipt with reviewer calls,
invalid attempts, reported token usage, elapsed time, and completed/remaining pairs. The first fake
pair deliberately retries both arms, so its receipt shows four calls; ordinary pairs show two.
Preflight
reconstructs all six one-commit repositories, checks the artifact lock and history truncation,
probes filesystem isolation, and proves every hidden oracle is green before insertion, red on the
flaw, and green after repair. It records `scored_model_calls: 0`.

Every scored `run` or `run-batch` repeats the full preflight before authenticating or invoking the
model. A red artifact, oracle, history, or filesystem-isolation check therefore stops before the
first scored cell. Review commands run through Codex's Linux sandbox with root denied, only the
exact fixture and Codex runtime readable, and command network disabled. Source/evaluator
repositories, sibling temp trees, memory, and hidden-oracle sentinels are not mounted. Fixtures
have no remotes, tags, alternates, reflogs, or later objects.

### Scored run brake

A scored run is metered and permanently burns these published cases for future model/workflow
comparisons. It also uses the caller's existing Codex login through an outer-client symlink, so it
is a separate manual security/cost decision. After reviewing the model-free artifacts, calculate
and explicitly confirm the exact protocol bytes:

```sh
sha256sum eval/review/protocol.json

node eval/review/run.mjs run \
  --source ../release-relay \
  --output /tmp/review-eval-scored \
  --confirm-protocol-sha256 EXACT_HASH_FROM_ABOVE
```

For quota-monitored execution, use `run-batch` with the same output directory and exact hash. Each
invocation completes exactly one matched pair, including both arms of its single allowed retry, and
then stops with a receipt:

```sh
node eval/review/run.mjs run-batch \
  --source ../release-relay \
  --output /tmp/review-eval-scored \
  --confirm-protocol-sha256 EXACT_HASH_FROM_ABOVE
```

Resume validates an exact completed prefix of the frozen schedule plus the protocol bytes, model,
effort, Codex version, result index, private per-cell results, artifact paths, and artifact hashes
before another reviewer call. A lock prevents concurrent batches. An `active-pair.json` marker is
written before either arm starts and removed only after the complete pair is persisted; if a process
dies mid-pair, later invocations fail closed so no model call is silently duplicated. Inspect the
private artifacts and quota state before manually removing a stale marker or lock. Preflight-only
state from a batch that never reached its first checkpoint can be reused safely with the same
command and output directory.

Do not commit scored output. Authentication remains only in a mode-0700 disposable Codex home and
is never copied into candidate fixtures. Reviewer commands inherit no shell environment, cannot
read that home, and receive no credentials. Before any reviewer stream is persisted, the runner
fails closed if it contains a long value from `auth.json`. The home and symlink are removed after
each cell.

### Scoring and reporting

Give only `scoring/scoring-input.json`, `scoring/score.schema.json`, and its opaque fixture diffs to
two independent scorers. The input contains normalized finding fields and deterministic A/B labels;
it omits summaries, plans, arm/case identifiers, tool traces, usage, and timing. Each scorer locks a
separate schema-valid file before seeing the private map. Preserve both originals, then adjudicate
disagreements with written evidence from the frozen fixture.

Score each frozen target as `caught`, `partial`, or `missed`. Separately record whether the finding
gives a bounded repair direction and a regression test that would fail on the flawed fixture and
pass after repair. Count a finding as unsupported only when independent inspection disproves it;
absence from the historical repair is not evidence. Named-target recall is not applicable on clean
controls, while every finding on a control is still independently adjudicated.

Report target-level arm counts, paired wins/ties/losses, both actionability rates, and disproved
finding counts. Report controls, tokens, elapsed time, reviewer count, and guidance-read lifecycle
evidence separately. Do not combine them into one score, claim statistical significance, or infer
population prevalence from repeated samples of six fixed changes.

Raw `private/runs/`, `private/results.jsonl`, `private/experiment.json`, the blinding map,
per-cell measures, stderr, and event streams remain mode-0700/0600 private because they contain arm
mappings, tool traces, and possibly host-local metadata. Public artifacts are limited to the frozen
protocol/census, path-scrubbed preflight summary, normalized scoring packets and locked score files,
and a reviewed aggregate report. The requested output root is also mode 0700 by default; copy only
the allowlisted artifacts when sharing them.
