## Why

The live GitHub reader accepts a comparison range but currently discards the comparison payload
and returns repository-wide closed pull requests, issues, contributors, and releases. A reproduced
identical `main...main` range with no commits still returned an unrelated old merged pull request.
That violates the source-grounded range workflow and can put unrelated historical work into a
release candidate.

## Evidence

In `packages/github-integration/src/live.ts`, `compare()` only validates that `compareCommits`
returned an object, then independently pages repository-wide endpoints without filtering their
results through the selected comparison. The live mapper also hard-codes empty PR/issue links and
`reverted: false`, so assembler deduplication and reverted-work behavior cannot be grounded from
live data.

## Touches

`packages/github-integration/src/live.ts`, its injected-client tests, GitHub read DTOs in
`packages/core/**` if range evidence needs a stricter shape, architecture/spec documentation only
if the reviewed contract needs clarification, and source-derived oracle expectations.

## Requested change

Make the comparison response the authoritative boundary for candidate source selection. Derive a
bounded set of merged pull requests and contributors from comparison evidence and approved read
endpoints; derive linked issue and reverted-work metadata under an explicit tested rule; keep prior
releases as separated context. Reject provider responses whose repository identity conflicts with
configured scope, and classify conflict responses as conflicts rather than authorization failures.
Do not replace the bug with date-only filtering or unbounded per-commit fan-out.

## Acceptance

- An identical or empty comparison yields no pull-request or issue candidates even when
  repository-wide endpoints contain old closed work.
- A merged pull request evidenced by the range is retained; an unrelated one is excluded.
- Linked issue metadata lets the assembler avoid duplicating one change, under a documented rule.
- Reverted work is grounded or reported under an explicit conservative fallback.
- Contributor identities are grounded in the selected range.
- Prior releases remain contextual and cannot become candidates.
- Repository identity mismatches are rejected safely; HTTP 409/422 map to `conflict`.
- API fan-out and pagination are bounded and tested.
- Tests use injected fakes with no live request or DNS work.

No live GitHub call is authorized as part of this task.
