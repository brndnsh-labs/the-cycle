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
