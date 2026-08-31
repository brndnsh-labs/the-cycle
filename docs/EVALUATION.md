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
timeout, prompt, schema, permissions, ordering seed, fixture commit time, captured original tasks,
normalized tasks, guidance, source trees, candidate patches, repairs, hidden oracles, census, and
score schema are all hashed before scoring. Revision 3 preserves the study claim, cases, model,
scoring, seed, repetitions, ordering, and batch size while replacing revision 2's path-mention
guidance heuristic with content-backed evidence.

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

The fake run exercises the complete seeded schedule, an absent-file compound guidance check in
every baseline, a deliberately invalid cell and paired retry, successful content-backed reads of
both treatment guidance files, normalization, blinded scoring input, and private artifact writing.
Focused synthetic modes also prove that either guide's returned content invalidates baseline, one
returned treatment guide is insufficient, and proven baseline exposure stops before retry.
`dry-run-batch` exercises the same path one matched pair at a time and resumes from the same output
directory:

```sh
node eval/review/run.mjs dry-run-batch --output /tmp/review-eval-dry-batched
```

Repeat that command 18 times; each successful invocation prints a receipt that separately counts
reviewer processes, model turns started, model turns completed, invalid cells, reported token
usage, elapsed time, and completed/remaining pairs. Legacy `calls` and `invalid_attempts` aliases
remain for existing receipt consumers. The first fake pair deliberately retries both arms, so its
receipt shows four reviewer processes and model turns; ordinary pairs show two.
Token usage is summed only from completed turn events. If a turn starts without completing, its
usage is unavailable and is not inferred to be zero.
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
invocation completes exactly one matched pair and then stops with a receipt. Ordinary cell
invalidity gets one paired retry. Successful command output containing the frozen content of either
guide proves baseline contamination and instead stops the experiment immediately, preserving the
first pair without spending a retry:

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

## Full intake-to-cycle pilot

`eval/pipeline/` tests a different, broader claim: whether the complete intake, implementation,
review, patch, and delivery structure improves work that begins as a short request. It is a
four-case descriptive Songs I Know pilot, not a general benchmark. The census applies one fixed
two-day eligibility rule and a deterministic hash rank before selecting #133, #131, #139, and #123.

Each case begins with one resumable `$intake` session. A frozen answer sheet responds only when the
model asks a question, and the GitHub double captures the one issue it files. The exact resulting
title and body bytes then feed both shaped arms:

```text
raw request ──┬── intake + scripted answers ── exact issue bytes ─┬── shaped direct
              │                                                   └── implement
              └── raw direct                                           │
                                                                        review
                                                                          │
                                                                        patch
                                                                          │
                                                                        done
```

The full-cycle stages are separate resumed turns in one Codex thread, so the patch stage retains the
review context and the evaluator can capture deltas after all four stages. The raw-direct arm gets
the same scripted responder if it asks a material question. All arms use the same frozen model and
effort; implementation-arm ordering is fixed in the protocol.

The candidate workspaces are physical one-commit repositories without remotes, tags, alternates, or
later source objects. Current pipeline guidance is injected only into intake and full-cycle
fixtures. Direct arms receive a neutral repository instruction. Dependency trees are full physical
copies of the selected local Songs I Know checkout, never symlinks or hardlinks back to it. Completed
arm workspaces are discarded before the next arm so the pilot does not retain several copies at
once. Model commands get write access only to the exact candidate root, no network, no ambient
credentials, and a stateless local `gh`/push double. Hidden regression tests are inserted later into
a separate verifier copy; candidate-authored tests and test-runner configuration cannot replace or
disable them. Before evaluator-side Git inspection, the runner verifies the original physical
`.git` control directory, rejects links and special files, and restores a known-safe local Git
configuration. Batch resume likewise rejects links or special files anywhere in the output tree
before writing another artifact.

### Model-free validation

The local Songs I Know checkout supplies the frozen public Git objects and an installed physical
`node_modules` tree. First exercise all resumable lifecycle and artifact paths with the fake client:

```sh
node eval/pipeline/run.mjs dry-run --output /tmp/pipeline-eval-dry
```

The fake run deliberately invalidates the first shaped-direct attempt, retries the whole case, and
then completes all four cases. It covers intake follow-ups, raw-direct follow-ups, all three arms,
the four resumed full-cycle stages, tracker and push doubles, stage snapshots, private artifacts,
normalization, and scoring blinding without a scored model call.

Quota-style batching completes one full case per invocation. Reuse the exact output path four times:

```sh
node eval/pipeline/run.mjs dry-run-batch --output /tmp/pipeline-eval-dry-batched
```

Every receipt separates process turns started/completed from token usage actually reported. Resume
validates an exact result prefix and every artifact hash. A lock prevents concurrent batches, and
an `active-case.json` marker fails closed after interruption so a partially spent case is never
silently repeated.

Then prove the real historical fixtures and hidden verifier:

```sh
node eval/pipeline/run.mjs preflight \
  --source ../songsiknow \
  --output /tmp/pipeline-eval-preflight
```

Preflight checks the artifact lock, exact Codex version, strict permission profile, physical
history isolation, evaluator-asset write denial, command-network denial, and all four hidden
oracles. Each oracle must fail on the historical base, pass after the accepted repair, and fail
again when the accepted production repair is removed. It records `scored_model_calls: 0`.

### Scored batch brake

A scored batch authenticates the outer Codex client and can spend several resumed turns, but it
completes only one case before returning control for quota inspection. Review the model-free output,
calculate the exact frozen protocol bytes, and explicitly confirm them:

```sh
sha256sum eval/pipeline/protocol.json

node eval/pipeline/run.mjs run-batch \
  --source ../songsiknow \
  --output /tmp/pipeline-eval-scored \
  --confirm-protocol-sha256 EXACT_HASH_FROM_ABOVE
```

Repeat the same command and output directory for the remaining cases. Every invocation reruns the
model-free preflight before authentication-backed turns. Authentication exists only as a symlink in
a disposable mode-0700 client home; raw output is fingerprint-scanned before persistence and the
candidate command environment cannot read that home.

Do not commit scored output. Raw events, stderr, host paths, tracker transcripts, stage measures,
arm order, and the blinding map remain under `private/`. Only the protocol/census, path-scrubbed
preflight, normalized `scoring/` packet, locked score files, and reviewed aggregate report are
shareable. Two independent scorers should lock their files before the private arm map is revealed.
Report the four matched outcomes and qualitative mechanisms separately from turns, tokens, elapsed
time, and stage evidence; do not claim significance, prevalence, or a composite score.

## Sol/Luna full-pipeline calibration

`eval/model-lift/` is a one-task descriptive calibration for the question the broader pilot could
not isolate: does shaping and the full work loop add more value for a smaller model? It runs GPT-5.6
Luna and GPT-5.6 Sol, at high reasoning effort, through the same three implementation arms:

```text
short request ──┬── raw direct
                ├── frozen shaped issue ── shaped direct
                └── frozen shaped issue ── implement ─ review ─ patch ─ closure review ─ done
```

Each model also runs intake as a sidecar measurement. Its filed issue is scored for scope and
acceptance quality but is not fed to any implementation arm; both shaped arms receive the same
prewritten canonical issue bytes. This prevents a stronger intake result from silently changing
the implementation task. The task is Release Relay #76 at one pinned historical root, with the
historical repair, an independent alternative repair, and a repair-removal mutation used to prove
the behavior-only hidden oracle before any model call. This is a calibration, not a representative
sample: report the six matched implementation observations directly and do not claim significance.

### Dependencies and model-free validation

The evaluator installs the exact historical `pnpm-lock.yaml` tree into a disposable snapshot. It
never reuses the current Release Relay `node_modules`. If the public pnpm cache is incomplete,
populate it explicitly before preflight:

```sh
node eval/model-lift/run.mjs fetch-cache \
  --source ../release-relay \
  --allow-network
```

That is the only dependency-network command. It uses a private temporary home, fetches only the
locked public artifacts, and runs no lifecycle scripts. Candidate and verifier commands remain
offline.

Exercise one fake model batch at a time, using the same output path twice to prove exact Luna-then-
Sol resume and the final blinded packet:

```sh
node eval/model-lift/run.mjs dry-run-batch \
  --output /tmp/model-lift-dry
```

Then run the zero-model-call real preflight:

```sh
node eval/model-lift/run.mjs preflight \
  --source ../release-relay \
  --output /tmp/model-lift-preflight
```

The current frozen runtime is Codex CLI 0.151.0, Node v26.8.1, pnpm 11.24.0, and Bubblewrap
0.12.0. Model turns use Codex's root-denied, network-disabled permission profile. That inner Linux
sandbox rejects Node's synchronous child-process API, which Release Relay's unrelated CLI tests
exercise. Every arm therefore receives the same evaluation-only instruction to run formatting,
lint, typechecking, the full build, and the OpenAI package test during its turn. The evaluator does
not treat that subset as final proof: it reconstructs a fresh candidate from the pinned base and
reruns the exact `pnpm check` and `pnpm build` commands in Bubblewrap.

The Bubblewrap verifier unshares every namespace including the network, clears the environment,
mounts no user home or `/etc`, mounts only the disposable fixture writable, and mounts `/usr` plus
the Node/pnpm runtime read-only. Candidate changes to package-manager, compiler, formatter, or test
configuration are rejected before verification. This preserves the real Release Relay gate while
avoiding both a false sandbox failure and an unsandboxed execution of model-authored source.
The verifier commits the frozen base and control files as a one-root, no-remote repository before
applying the candidate delta uncommitted; preflight runs its gate matrix through that same path.

Preflight additionally proves the hidden oracle is red on the base, green on the historical and
independent repairs, and red after repair removal; checks exact history, dependency, artifact, and
guidance hashes; and records `scored_model_calls: 0`.

### Scored batches and reveal

After reviewing the preflight receipt, confirm the exact protocol bytes. Each invocation completes
one model across intake and all three implementation arms, then returns for quota inspection:

```sh
sha256sum eval/model-lift/protocol.json

node eval/model-lift/run.mjs run-batch \
  --source ../release-relay \
  --output /tmp/model-lift-scored \
  --confirm-protocol-sha256 EXACT_HASH_FROM_ABOVE
```

Run the same command a second time for Sol. Resume accepts only the exact frozen model-order prefix;
a batch lock prevents concurrency, and an active-model marker fails closed after interruption so a
partially spent model is not silently repeated. One behavioral retry and one infrastructure retry
are allowed, with three attempts as the hard ceiling.

Do not reveal the private map until two independent scorers have locked schema-valid scores for the
opaque six-output packet and two intake artifacts. Report hidden-oracle pass/fail, scope control,
test quality, evidence quality, intake quality, stage deltas, turns, tokens, and elapsed time as
separate observations. The comparisons of interest are shaped minus raw and full-cycle minus shaped
within each model, followed by Luna's lift minus Sol's lift. Do not collapse them into a composite.

Do not commit scored output. Raw event streams, stderr, host paths, tracker transcripts, per-turn
records, and the model/arm map remain under the mode-0700 `private/` tree. Only the frozen protocol,
path-scrubbed preflight summary, normalized scoring packet, locked score files, and a reviewed
aggregate report are shareable.
