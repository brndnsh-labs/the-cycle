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

The runner uses
[`codex exec --json`](https://developers.openai.com/codex/noninteractive) and records the event
stream, tracker and gate commands, token usage when Codex reports it, the final diff,
source/skill/fixture hashes, and deterministic assertions in the requested output directory. It
does not copy authentication into the fixtures: the Codex launcher retains its existing login,
while model-generated commands receive a core-only environment, an empty evaluation home, no
network access, and no approval path out of the workspace sandbox.

Start with the default single matched run. If the arms differ, or the result will justify a
meaningful instruction change, add `--repeat 3` to repeat both arms. `--scenario <id>` narrows the
run to one targeted behavior.

Model-backed runs are externally metered and intentionally absent from `npm test` and CI.
Ordinary tests exercise fixture isolation, the tracker double, JSONL parsing, assertions, and
result formatting with a fake Codex executable. A behavioral FAIL is evidence in `results.jsonl`,
not a merge-gate exit code; invalid runner or harness execution exits 2.
