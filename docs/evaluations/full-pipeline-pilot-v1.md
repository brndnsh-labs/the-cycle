# Full-pipeline pilot v1

Status: completed, scored, revealed, and validity-audited on 2026-08-30.

## Result in plain English

This pilot found useful evidence for intake and review, but it did **not** produce a trustworthy
task-completion comparison.

- Intake was the clearest value. Relative to a raw prompt, both arms that received the
  intake-shaped issue were rated better on decision handling in three of four cases and on test
  quality in all four cases by both blind scorers.
- Review found six bounded issues across three of four full-cycle implementations. The findings
  included unread-stream cleanup, a payment error path, pointer behavior behind an open backdrop,
  native-control and accessible-name coverage, and a test that claimed layout proof without a
  layout engine.
- The final full-cycle artifacts did not rate better than shaped-direct on decision handling or
  test quality. Both scorers rated those dimensions equal in all four matched cases. Scope was
  equal in three cases and worse in one; evidence quality was mixed.
- The hidden oracles reported the same result for every arm within every case: three all-fail
  cases and one all-pass case. A post-reveal audit found that the three failing oracles depended on
  historical-repair-specific interfaces or mechanisms. They rejected alternative implementations
  before fairly testing the stated behavior, so those outcomes are non-comparable rather than
  evidence that all three approaches failed.

The practical conclusion is narrower than the original claim: shaping an underspecified request
into an explicit issue materially improved the final artifact. The cycle added a real review and
braking layer, but this four-case pilot did not show that the layer improved final task completion
over a shaped issue alone. Demonstrating that requires behavior-only oracles and a cleaner evidence
capture path.

## Design

The frozen revision-3 protocol compared three matched arms for four reconstructed requests from a
purposive Songs I Know census:

1. `raw-direct`: the reconstructed short request and a generic implementation prompt.
2. `shaped-direct`: the exact title and body produced by a fresh intake session, then a generic
   implementation prompt.
3. `full-cycle`: the same intake bytes as shaped-direct, then resumed implement, review, patch, and
   done stages.

All implementation arms used `gpt-5.6-sol` at high reasoning effort with Codex CLI 0.151.0. Case
order, model, effort, answer sheets, retry rules, prompts, fixtures, and scoring were frozen under
protocol SHA-256
`4b6292686119ddb26c7e078b88062045095e80b1710a08ed6841f8e4a1ce7eb3`.

The run completed four valid cases in five attempts. The first `sik-131` attempt was behaviorally
invalid because intake created an issue without both a non-empty title and body. It was preserved,
excluded before any implementation arm ran, and retried once at the whole-case boundary as
predeclared. There were no infrastructure-invalid attempts.

Each valid intake used three turns: one substantive clarification, one draft/filing approval, and
one completion receipt. The decisions were supplied by the frozen, human-authored answer sheets
rather than made interactively during the scored run:

| Case | Raw request | Decision captured through intake |
| --- | --- | --- |
| `sik-133` | Protect the Stripe webhook from oversized bodies. | Exactly 1,000,000 bytes; check signature before reading; preserve raw bytes; enforce declared and streamed overflow; retain payment behavior and the security/merge brake. |
| `sik-131` | Fix the filter clear button. | Sibling native controls with independent pointer/keyboard behavior, distinct names, a stable visible pill, and a 44×44 Clear target. |
| `sik-139` | Stop IndexedDB upgrades from hanging forever. | Five-second grace period, generation-safe rejection/retry, late-connection cleanup, actionable error, and one deduplicated app-wide toast. |
| `sik-123` | Make the Drawer Close button easier to tap. | Shared 44×44 target, preserved header proportions, long-title shrink protection, and a 390 px regression check. |

Two fresh scorers independently received only the opaque normalized packet, score schema, and
candidate diffs:

- Scorer A: `gpt-5.6-terra`, high reasoning effort.
- Scorer B: `gpt-5.5`, xhigh reasoning effort.

Their files were structurally validated and locked before the private arm map was read. The lock
record is SHA-256
`3ac97b8ade308c6f05a96ae7a9741b2ce6abee3a9195906394fc22fed39291b6`.

## Primary outcome and oracle validity

The blind packet exposed the evaluator-owned oracle status but not arm identity. Both scorers
therefore reproduced all 12 supplied outcomes; that agreement validates transcription, not the
oracle design.

| Case | Raw direct | Shaped direct | Full cycle | Post-reveal interpretation |
| --- | --- | --- | --- | --- |
| `sik-133` oversized webhook body | Fail | Fail | Fail | Non-comparable: the oracle depended on a historical-repair-only interface. |
| `sik-131` filter clear control | Fail | Fail | Fail | Non-comparable: the oracle pinned historical naming and target mechanism beyond the issue contract. |
| `sik-139` blocked IndexedDB open | Fail | Fail | Fail | Non-comparable: the oracle imported historical repair-specific notification and mount identities. |
| `sik-123` Drawer close target | Pass | Pass | Pass | Usable, but shows no arm difference. |

Preflight had proved that each oracle failed on the historical base, passed after the accepted
repair, and failed when that repair was removed. The reveal shows why that criterion was
insufficient: it can prove sensitivity to one repair without proving compatibility with an
independent conforming implementation.

No verified-completion rate, arm ranking, or improvement claim is reported from these four oracle
rows.

## Blind process ratings

The table reports matched case counts as `better / equal / worse`. Each cell shows Scorer A and
Scorer B separately. These are four observations per scorer, not independent replications or an
inferential statistic.

| Dimension | Full cycle vs raw | Shaped direct vs raw | Full cycle vs shaped |
| --- | --- | --- | --- |
| Scope control | A `0/3/1`; B `1/2/1` | A `0/4/0`; B `1/3/0` | A `0/3/1`; B `0/3/1` |
| Decision handling | A `3/1/0`; B `3/1/0` | A `3/1/0`; B `3/1/0` | A `0/4/0`; B `0/4/0` |
| Test quality | A `4/0/0`; B `4/0/0` | A `4/0/0`; B `4/0/0` | A `0/4/0`; B `0/4/0` |
| Evidence quality | A `1/2/1`; B `0/4/0` | A `1/2/1`; B `1/2/1` | A `1/2/1`; B `1/2/1` |

The scorers agreed on 41 of 48 process cells. Agreement by dimension was 10/12 for scope, 10/12
for decision handling, 12/12 for test quality, and 9/12 for evidence quality.

The strongest matched signal is the intake cut: shaped-direct and full-cycle both improved
decision handling and regression coverage relative to raw-direct. The blind final-artifact ratings
do not isolate an additional gain from cycle-after-intake.

## Case narratives

| Case | Raw-direct initial result | Shaped-direct result | Full-cycle result before review |
| --- | --- | --- | --- |
| `sik-133` | Implemented the byte cap and raw-byte streaming, but its tests omitted some unread-body and existing-payment paths. | Implemented the shaped boundary and broad mechanism coverage. | Implemented the shaped issue with broad tests; review then found two additional error/resource edges. |
| `sik-131` | Removed the nested control but left Clear at 32 px and tested only basic pointer behavior. | Met the sibling-control, 44 px, pointer, and keyboard requirements. | Met the shaped requirements; review then found open-backdrop, native-element-proof, and selected-state naming gaps. |
| `sik-139` | Added a timeout, but silently chose ten seconds and omitted the recovery toast. | Implemented the five-second policy, retry/late cleanup, notification, and focused tests. | Implemented the same policy and mechanisms; review found no verified defect. |
| `sik-123` | Grew the target but omitted long-title/flex-shrink behavior. | Added target, shrink protection, spacing, overflow behavior, and focused tests. | Added the shaped behavior; review then found that the 390 px unit test did not actually prove layout. |

This pattern explains the blind ratings: the raw prompt was often enough for the central code
change, while intake supplied the policy and edge-case contract. Review mostly worked one level
deeper than that contract.

## What review contributed

The necessarily unblinded lifecycle audit found concrete work that the final-artifact comparison
does not capture:

| Case | Review findings | Patch result | Caution |
| --- | ---: | --- | --- |
| `sik-133` | 2 | Added unread-body cancellation and narrowed duplicate handling so unrelated database failures can retry. | The database change was useful but broader than the stated body-limit task; both scorers penalized full-cycle scope here. |
| `sik-131` | 3 | Kept Clear clickable while the popover backdrop was open, preserved selected-state information in the accessible name, and strengthened native-button coverage. | The historical oracle still rejected alternative naming/mechanism choices, so it cannot validate these fixes. |
| `sik-139` | 0 | Patch was correctly a no-op. | The historical oracle was implementation-coupled despite both scorers rating the final decision and test work strongly. |
| `sik-123` | 1 | Replaced a viewport-only unit-test claim with assertions derived from the actual style budget. | The frozen sequence did not run a second review after patch, so the finding's closure was not independently re-reviewed. |

Review found six issues in total and changed three of four full-cycle diffs. This is meaningful
qualitative evidence for the cycle as a second layer of trust, especially around edge cases and
test claims. It is not the same as evidence that the final full-cycle output beat shaped-direct on
the frozen primary outcome.

## Brakes and evidence

The full-cycle arm retained the human merge brake on the payment-sensitive case. Across all four
cases, done stopped before commit or PR creation because repository-wide lint and tests were red
on frozen baseline/environment failures. That is evidence that the workflow honored its gates;
the direct arms were implementation-only comparators, so this pilot cannot attribute a delivery
safety difference between them.

Evidence quality was never rated strong for any arm. Candidate-run command capture was uneven:
some arms supplied no gate execution, some supplied focused checks, and one supplied an unrelated
green test command. Full-cycle's repeated gate checks did not become clearer final evidence in the
blind packet. A future run should execute and publish a fixed evaluator-owned gate matrix after
each final candidate rather than rely primarily on commands chosen during model turns.

## Cost and latency

These are sums of completed model-turn wall time and reported usage for the four valid attempts.
Cached input is included in input and also shown separately. Shared intake is separated because
the same shaped issue fed both shaped arms.

| Segment | Turns | Wall time | Input | Cached input | Output | Reasoning output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Shared intake | 12 | 7.5 min | 1,443,105 | 1,211,136 | 17,178 | 8,109 |
| Raw direct | 4 | 9.4 min | 1,350,388 | 1,172,224 | 19,378 | 7,816 |
| Shaped direct | 4 | 16.9 min | 2,326,475 | 2,062,336 | 36,024 | 15,864 |
| Full cycle after intake | 20 | 50.3 min | 14,545,748 | 13,581,312 | 96,560 | 53,153 |

The full-cycle segment used five times as many model turns, about 6.3 times as much input, and
about three times as much model-turn wall time as shaped-direct. The excluded intake attempt added
3 turns, 1.5 minutes, 272,753 input tokens, 3,593 output tokens, and 1,458 reasoning-output tokens.
The complete preserved run therefore recorded 43 started and completed turns, 19,938,469 input
tokens, 172,733 output tokens, and 86,400 reasoning-output tokens.

## What this pilot supports

1. **Intake is the strongest demonstrated lever.** It turned short requests into explicit policy,
   edge cases, non-goals, and regression targets, and both blind scorers saw that in the final
   artifacts.
2. **Review adds observable trust work.** It found six bounded issues, including interaction,
   accessibility, resource cleanup, error-handling, and false-test-proof problems.
3. **Cycle-after-intake was expensive and did not improve the blind final-artifact rubric in this
   sample.** Its value appeared in the review trail and braking behavior, not in a measured
   completion lift.
4. **The primary test must be repaired before another scored claim.** Three implementation-coupled
   oracles make the current completion result unusable.

A reasonable product position from this pilot is that intake supplies broad everyday value, while
the full cycle is a risk- and trust-amplifier worth applying when review findings or delivery
brakes justify its additional cost. That position remains qualitative.

## Next test

Keep the three-arm design, but make four focused changes:

1. Write behavior-only hidden oracles from the issue contract. Do not import repair-only modules,
   require unpromised component names, or pin one visual/architectural mechanism.
2. Before freezing, prove each oracle against the base, the historical repair, the repair-removal
   mutation, **and at least one independently structured conforming implementation**.
3. Run an identical evaluator-owned gate matrix against every final candidate and expose its
   normalized result to scorers.
4. Blind-score the full-cycle implement snapshot and post-patch snapshot as an internal matched
   comparison, then re-review after patch. That directly tests whether review and patch improved
   the artifact rather than asking only whether the entire pipeline beat a strong shaped prompt.

Do not add more cases until those validity defects are fixed. After that, a second small batch is
more informative than statistical machinery on these four burned cases.

## Disclosures

- The raw prompts were reconstructed from historical issues rather than captured prospectively.
- The four cases are a deterministic but purposive census from one repository, with one repetition
  per accepted case.
- Scorers were blind to arm labels but saw issue text, diffs, command evidence, and supplied oracle
  status; lifecycle analysis after reveal was necessarily unblinded.
- The historical oracle construction overfit three accepted repairs. Those outcome rows are marked
  non-comparable, not rationalized into the comparison.
- Repository-wide baseline/environment gate failures limited delivery evidence.
- Codex CLI advanced from 0.150.1 during earlier protocol work to the frozen 0.151.0 revision-3
  run. Hosted model/backend behavior can drift even when the public model name is stable.
- The disclosed tasks, prompts, diffs, and oracle result pattern are now burned for future blinded
  reuse.
- This report makes no composite-score, statistical-significance, universal-quality, or defect-
  prevalence claim.

The normalized public artifacts are in [`eval/pipeline/results/v1`](../../eval/pipeline/results/v1).
Raw events, stderr, host paths, per-turn records, tracker transcripts, hidden-oracle contents,
credentials, private ordering, and the blinding map are intentionally excluded.
