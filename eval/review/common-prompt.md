Review the current uncommitted diff against the task context below.

This is a review-only evaluation. Do not modify files. Do not use the network, inspect paths
outside this repository, or attempt to recover later history. Inspect the implementation, tests,
and relevant repository documentation closely enough to identify consequential correctness,
contract, safety, and edge-case defects.

Before reviewing, read `.agents/skills/review/SKILL.md` if that repository-local guide exists.
Otherwise perform a strong general code review using the same output contract.

Return only findings that are actionable and caused by the uncommitted change. For each finding,
provide:

- severity: `P0`, `P1`, or `P2`;
- the precise file and line;
- the concrete mechanism;
- a plausible consequence;
- a repair direction; and
- a regression test that would demonstrate the defect.

Do not treat absence from an expected historical patch as evidence that a finding is false. If no
actionable defect is present, return an empty findings array.

Task context follows:
