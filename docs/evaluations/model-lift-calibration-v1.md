# Sol/Luna full-pipeline calibration

- Date: 2026-08-31
- Task: Release Relay #76, reject excluded candidate citations
- Corrected packet: `c413d133c721c2c6`
- Original superseded packet: `86ad5bb04075e722`

## Bottom line

This single task produced a ceiling effect: Luna and Sol both solved the behavior correctly from
the raw prompt, and all six final candidates passed the hidden behavior oracle, `pnpm check`, and
`pnpm build`. Two independent blinded judges gave every implementation arm 2/2 for scope control,
test quality, and evidence quality. There was therefore no observed implementation-quality lift
from shaping or from the full cycle on this case.

The useful differences were process and efficiency:

- Shaped-direct preserved perfect quality while reducing Luna's model-turn time by 51% and input
  tokens by 72% versus raw-direct. Sol's shaped arm used 35% fewer input tokens but similar time.
- The preregistered five-stage arm preserved perfect quality but changed neither model's
  implementation after the implement stage. Review was clean, the deliberately invoked patch was
  a no-op, and the deliberately invoked finding-closure review was clean.
- That fixed-stage arm took 3.5x Luna's shaped-direct time and 3.4x Sol's, with 6.7x and 9.6x the
  input tokens respectively. Those totals are not a simulation of ordinary `/cycle`: the live
  workflow skips patch and finding closure after a clean review. Removing the two protocol-only
  no-op stages leaves an observed clean-path subtotal of 3.2x Luna's and 3.1x Sol's shaped-direct
  time, with 6.2x and 9.0x the input tokens.
- Luna intake filed a precise, complete issue on its first attempt. Sol's first intake attempt used
  all three turns without filing an issue; its accepted retry was complete but over-scoped into
  core files.

For this kind of small, unambiguous, oracle-backed task, the evidence favors a routed path: shape
the request, run one direct implementation, then independently verify it. Reserve a separate review
and conditional patch/closure loop for risk, ambiguity, weak oracles, cross-cutting changes, or a
failed first pass.

## Objective implementation results

| Model | Arm | Hidden oracle | Full gates | Judge A | Judge B | Model turns | Model-turn time |
|---|---|---:|---:|---:|---:|---:|---:|
| Luna | raw-direct | pass | pass | 2/2/2 | 2/2/2 | 1 | 3:23 |
| Luna | shaped-direct | pass | pass | 2/2/2 | 2/2/2 | 1 | 1:39 |
| Luna | fixed five-stage cycle | pass | pass | 2/2/2 | 2/2/2 | 5 | 5:49 |
| Sol | raw-direct | pass | pass | 2/2/2 | 2/2/2 | 1 | 3:43 |
| Sol | shaped-direct | pass | pass | 2/2/2 | 2/2/2 | 1 | 3:32 |
| Sol | fixed five-stage cycle | pass | pass | 2/2/2 | 2/2/2 | 5 | 11:55 |

Judge triples are scope control / test quality / evidence quality. Judge A was GPT-5.6 Terra;
Judge B was GPT-5.5. Both scored opaque labels from isolated read-only packets before reveal.

## Usage

| Model | Arm | Input tokens | Cached input | Output tokens | Reasoning output |
|---|---|---:|---:|---:|---:|
| Luna | raw-direct | 1,412,949 | 1,334,272 | 6,689 | 3,351 |
| Luna | shaped-direct | 396,439 | 356,608 | 3,363 | 1,141 |
| Luna | fixed five-stage cycle | 2,664,129 | 2,505,472 | 13,818 | 6,592 |
| Sol | raw-direct | 480,761 | 427,776 | 3,963 | 1,516 |
| Sol | shaped-direct | 312,171 | 274,432 | 3,456 | 1,026 |
| Sol | fixed five-stage cycle | 2,995,088 | 2,835,712 | 13,199 | 5,694 |

Accepted Luna used 9 turns and 12:51 of summed model-turn time. Accepted Sol used 10 turns and
23:17. Sol's invalid intake attempt added 3 turns, 2:40, 222,005 input tokens, and 3,452 output
tokens. Across accepted and invalid attempts, Sol used 13 turns and 25:57. Input totals are heavily
cached and should not be treated as equivalent to uncached billing.

## Intake

| Model | Accepted attempt | Intake turns | Intake time | Completeness | Scope precision |
|---|---:|---:|---:|---:|---:|
| Luna | 1 | 2 | 2:01 | 2/2 | 2/2 |
| Sol | 2 | 3 | 4:07 | 2/2 | 1/2 |

Both judges agreed. Luna stayed within the OpenAI adapter and tests and named explicit non-goals.
Sol's accepted issue was implementable but unnecessarily directed work into core validation and
core tests. Sol attempt 1 created no complete issue and was preserved as a behavioral invalidation.

## Review-stage effect

For both models, the implement, review, patch, finding-closure, and done snapshots had identical
diff hashes. Both reviews reported no findings, both patch stages were explicit no-ops, and both
closure reviews remained clean. The cycle added structured inspection and delivery evidence, but
it did not alter the implementation on this case.

## Protocol-to-workflow correction

The frozen protocol always invoked `implement`, `review`, `patch`, finding-closure `review`, and
`done` to preserve a comparable artifact at every stage. The current `/cycle` workflow is
conditional: a clean initial review goes directly to `/done`; `/patch` and finding closure run only
when there is an actionable finding. The five-stage cost is therefore a valid measurement of the
preregistered arm, but not of the ordinary clean path.

Using the already-recorded stage receipts, without rerunning either model, the matching clean-path
subtotal (`implement` + initial `review` + `done`) is:

| Model | Clean-path turns | Clean-path time | Input tokens | Versus shaped-direct time | Versus shaped-direct input |
|---|---:|---:|---:|---:|---:|
| Luna | 3 | 5:19 | 2,469,181 | 3.2x | 6.2x |
| Sol | 3 | 10:54 | 2,798,264 | 3.1x | 9.0x |

The forced no-op patch plus closure added 0:30 and 194,948 input tokens for Luna, and 1:01 and
196,824 input tokens for Sol. This subtotal is a post hoc descriptive correction, not a separately
randomized arm. It shows that most of the observed overhead came from implementation, review, and
delivery rather than the two protocol-only no-op turns.

## Harness correction

The first reveal showed every hidden oracle passing but every `pnpm check` failing. The common
failure was evaluator-owned: the fresh final verifier lacked a `.git` repository, and Release
Relay's coverage-oracle test correctly refused a non-repository source root. Issue #143 was
reopened; PR #145 initialized the frozen verifier as a one-root, no-remote repository and made
preflight exercise that exact constructor. CI passed on both required Node runtimes.

The original model outputs and first locked scores were not changed. All six opaque final diffs
were re-applied to fresh verifiers from merged evaluator commit
`c4093f7523a134136360e38dc5d1aa0d9ec4aeb1`; all six then passed the hidden oracle and full gates.
This created corrected packet `c413d133c721c2c6` with zero new Luna or Sol implementation calls.
The same two judges rescored the corrected packet without access to the map, old scores, or each
other's score.

## Interpretation and routing recommendation

This case supports three narrow conclusions:

1. A smaller model can execute the task as reliably as the larger model when the behavior is
   locally testable and the repository provides a strong contract.
2. Specification shaping can improve efficiency even when it cannot improve an already-correct
   outcome. The effect was especially large for Luna here.
3. Running review and delivery after implementation was substantially more expensive than shaped
   direct work on this simple, oracle-backed change. Its value on this case was assurance and
   traceability, not correction. The ordinary workflow already avoids the no-op patch and closure
   turns that the protocol forced for measurement.

Recommended route:

```text
intake / shape
      |
      +-- small + unambiguous + strong oracle --> shaped direct --> independent gates
      |
      +-- ambiguous / risky / cross-cutting / weak oracle / first pass red
                                                    --> implement --> review
                                                        --> [patch --> closure]* --> done
```

The lightweight path should still keep independent verification; the experiment does not support
removing the second layer of trust. It supports spending the separate review turn where it has a
reasonable chance to change or de-risk the result. Because this is one ceiling-effect case, it
identifies an oracle-backed code fast path as a follow-up hypothesis; it does not by itself justify
broadening the current docs/config receipt path to application code.

## Limitations

- One historical task is descriptive, not representative, and cannot support significance claims.
- The task was easy enough for every implementation arm, so it could not measure corrective lift.
- The fixed five-stage arm intentionally ran patch and finding closure after a clean review; use the
  separately labeled clean-path subtotal, not the five-stage total alone, when reasoning about the
  current conditional `/cycle` workflow.
- Hosted model behavior can drift; these observations are tied to the frozen protocol and date.
- Intake retry behavior may vary across repeated samples.
- The qualitative judges were models, not human raters, though they agreed completely after the
  verifier correction.
- The post-reveal evaluator correction is fully disclosed; only verification and scoring were
  repeated, not implementation generation.
