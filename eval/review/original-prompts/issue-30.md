**Why:** The live GitHub reader accepts a comparison range but currently discards the comparison payload and returns repository-wide closed pull requests, issues, contributors, and releases. A reproduced identical `main...main` range with no commits still returned an unrelated old merged pull request. That violates `docs/spec.md`'s source-grounded range workflow and can put unrelated historical work into a release candidate.

**Evidence:** In `packages/github-integration/src/live.ts`, `compare()` only validates that `compareCommits` returned an object, then independently pages `pulls.list`, `issues.listForRepo`, `repos.listContributors`, and `repos.listReleases` without filtering their results through the selected comparison. The live mapper also hard-codes empty PR/issue links and `reverted: false`, so the product assembler's deduplication and reverted-work behavior cannot be grounded from live data.

**Touches:** `packages/github-integration/src/live.ts`, its injected-client tests, GitHub read DTOs in `packages/core/**` if the range evidence needs a stricter shape, `docs/architecture.md`, `docs/spec.md` only if the reviewed contract needs clarification, and the source-derived oracle expectations.

**Fix (drafted):** Using current official Octokit documentation, make the comparison response the authoritative boundary for candidate source selection. Derive a bounded set of merged pull requests and contributors from comparison evidence and approved read endpoints; derive linked issue and reverted-work metadata under an explicit tested rule; keep prior releases as clearly separated context. Reject provider responses whose repository identity conflicts with configured scope, and classify conflict responses as conflicts rather than authorization failures. Do not replace the bug with date-only repository-wide filtering or unbounded per-commit fan-out.

**Acceptance:**
- An identical or empty comparison yields no pull-request or issue candidates even when repository-wide endpoints contain old closed work.
- A merged pull request evidenced by the selected range is retained; an unrelated merged pull request is excluded.
- Linked issue metadata lets `assembleCandidates` avoid duplicating one change, and the derivation rule is documented and tested.
- Reverted work is either grounded and marked excluded or reported under an explicit conservative fallback; it is never silently hard-coded non-reverted.
- Contributor identities are grounded in the selected range rather than the repository's all-time contributor list.
- Prior releases remain contextual and cannot become candidates.
- Repository identity mismatches are rejected safely; HTTP 409/422 responses map to `conflict`, not `authorization`.
- API fan-out and pagination are bounded with tests for maximum work, partial responses, authorization, rate limits, and empty ranges.
- Tests use injected fakes and perform no live request or DNS work.
- Oracle changes are derived from the intended source/API surface before any Breakscope comparison.
- `pnpm check`, `pnpm build`, and applicable workflow checks pass.

**Dependencies:** M1 and the shipped M2 contracts are complete. This is the M2 retrospective repair and should land before M3 is promoted.

**Non-goals:** Running a live GitHub call, changing authentication, adding webhooks or writes, choosing hosted persistence, per-file repository reads, unbounded commit fan-out, UI work, or changing Breakscope.

**Approval note:** Adding or changing the live-capable GitHub read surface is a repository brake. The cycle must present the exact SDK endpoints and bounds before implementation proceeds.
