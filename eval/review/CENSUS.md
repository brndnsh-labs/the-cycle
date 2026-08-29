# Release Relay review-evaluation census

This is a purposive retrospective suite, not a prevalence sample. Its bounded claim is whether the
already-existing Release Relay review guidance improves review of these reconstructable changes.
It does not estimate how often the-cycle finds defects in general.

## Pool and eligibility

The candidate era starts at the earliest selected base (`674f4d4`) and ends at the last selected
repair (`dfa1467`). The census contains every mainline commit in that interval whose subject starts
with `fix(`, plus `c930975`, the pre-squash review correction attached to PR #31. This subject-based
pool can miss repairs labeled another way; that is a stated selection limitation.

A case is eligible only when all five conditions hold:

1. the original public task context exists;
2. the introducing flawed change can be reconstructed as an uncommitted diff over its base;
3. the candidate and tests can run offline with injected or local doubles;
4. a later committed regression test fails on the flaw and passes with the production repair; and
5. the defect is reviewable from the introducing diff rather than requiring later operational data.

The suite is capped at four flawed cases. Eligible cases beyond that cap remain named reserves,
not hidden degrees of freedom. Selection favors distinct consequential API-boundary mechanisms:
source boundary validation, provenance grounding, event ordering, and pagination/idempotency.

## Included cases

| Repair | Original task / flawed change | Why included |
| --- | --- | --- |
| `c930975` | issue #30 / `57d1b37` | A pre-merge second-model review correction with two separable GitHub comparison-boundary targets and a committed injected-client oracle. |
| `17e47ab` | issue #9 / `38e5748` | An OpenAI grounding postcondition accepted citations to candidates excluded from provider input; the repair supplies an offline regression oracle. |
| `7d57564` | issue #11 / `d5b8bf3` | Same-second distinct Stripe events were collapsed by timestamp ordering; the pure core-domain oracle applies without provider access. |
| `dfa1467` | issue #12 / `9d29ef7` | First-page-only Stripe catalog resolution could duplicate or ambiguously bind resources; injected fakes reproduce it offline. |

The GitHub and pagination cases also have target-clean controls made by applying only the named
production repair to the same candidate. “Clean” means only that the named target is repaired;
other findings must still be independently checked.

## Eligible reserves

These passed the five criteria but were not selected after the four-case cap and mechanism balance
were frozen.

| Repair | Mechanism | Disposition |
| --- | --- | --- |
| `f08b1ec` (#68) | Conflicting mock-runtime operation-ID reuse | Reserve: overlaps the selected idempotency family. |
| `0db76a6` (#69) | Case-sensitive GitHub repository identity | Reserve: overlaps the selected GitHub identity-boundary family. |
| `80194d8` (#74) | Unbounded webhook raw body before signature verification | Reserve: distinct security/resource-bound case for a later, separately preregistered suite. |

## Excluded census entries

| Repair | Reason for exclusion |
| --- | --- |
| `5ba6137` (#31) | Final squash of the same PR represented by the more informative flawed `57d1b37` → review correction `c930975`; duplicate family/observation. |
| `5c64094` (#33) | Follow-up GitHub comparison-boundary hardening overlaps the selected #30 case rather than adding an independent family. |
| `2ac65db` (#49) | Coverage-oracle manifest pin: evaluator/process infrastructure, not an application candidate review. |
| `67e2ff1` (#57) | Coverage-oracle source-checkout separation: evaluator isolation/process failure, not an application diff. |
| `cb40449` (#64) | Static typed-construction cleanup with no distinct runtime regression oracle. |
| `f08fd97` (#65) | SDK parameter and CLI cast hygiene with no distinct runtime regression oracle. |
| `33175b8` (#73) | Type-narrowing cleanup with no independently failing runtime oracle. |
| `8aaf7fc` (#75) | Coverage-oracle typed-construction cleanup, not an application candidate review. |
| `98f4097` (#81) | Workflow routing correction; outside the code-review edge-case claim. |
| `7938406` (#86) | Test-discovery gate correction; it changes which oracle runs instead of supplying an application defect case. |
| `ef014b3` (#93) | Dead oracle-validator fallback; no reachable application behavior or distinct regression oracle. |
| `112f6eb` (#95) | Deleted-customer webhook repair has no committed regression test in the repair, so criterion 4 fails. |
| `e2a5c1f` (#96) | Architectural ownership/coupling move, not a bounded defect with an isolated fail/pass oracle. |
| `23b68b4` (#112) | The later safe-integer test does not apply to the introducing publisher diff without manual adaptation, so criterion 4 fails for a frozen historical reconstruction. |

## Task normalization record

The four files in `original-prompts/` capture the public issue bodies for Release Relay issues
#30, #9, #11, and #12 as observed on 2026-08-29. The corresponding files in `prompts/` are
normalized from those frozen originals. The normalization is intentionally semantic, not verbatim:

- `Fix (drafted)` became `Requested change` and “using current official documentation” was removed;
- tracker dependencies, milestone/process language, and Breakscope-specific comparison wording were
  removed or generalized;
- non-goals were shortened to the external-action boundary relevant to the review; and
- approval/brake wording became a neutral statement that no live provider call is authorized.

Why, touched code, requested behavior, acceptance semantics, and the no-live-call boundary remain.
Both the captured original and normalized file are hashed in `protocol.json`; changing even one
byte invalidates preflight. The original issue numbers and immutable source commits remain in the
protocol for auditability.

## Selection limitations

The cases come from one repository and a short development period, three of four concern external
API boundaries, and one was already caught during an actual second-model review. Repetitions are
multiple samples from the same model over the same diffs, not independent repositories. Once any
scored output is produced, all six published fixtures are burned for future model/workflow
comparisons; later use may be labeled only as replication or demonstration.
