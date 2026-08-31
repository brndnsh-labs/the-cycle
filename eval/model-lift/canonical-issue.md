**Why:** `buildDraftInput` sends only `included: true` candidates to OpenAI, but `createOpenAiDrafter` validates the returned draft against the complete original candidate list. A provider response can therefore cite an excluded source identity and be accepted as a validated draft, even though that identity was never supplied to the provider. This contradicts the selected-candidate grounding contract.

**Touches:** `packages/openai-integration/src/draft.ts`, `packages/openai-integration/src/draft.test.ts`.

**Fix (drafted):** Validate the returned draft against the same included candidate set used to construct the bounded provider input. Add an injected-client regression test whose response cites excluded `issue/7` and assert an `unsupported-claims` result with `unknown-source`. Preserve successful validation for included identities. The written product contract is already correct and should not need changing.

**Acceptance:**
- A response citing an excluded candidate returns `unsupported-claims`.
- Its finding identifies the excluded source as `unknown-source`.
- Included candidate citations still produce a validated draft.
- Provider input remains limited to included candidates and safe fields.
- No live provider call, credentials, network access, or oracle change is introduced.
- `pnpm check` and `pnpm build` pass.

**Dependencies:** None.

**Non-goals:** Changing core validation semantics, making a live OpenAI request, changing provider configuration, or modifying reviewed oracle truth.
