## Why

OpenAI is one useful drafting provider. Its adapter must stay narrow, structured, mock-testable,
and visibly separate from any authorization to send maintainer content.

## Touches

`packages/openai-integration/**`, dependency manifests, injected-client contract tests, mock
composition, AI/security documentation, and reviewed oracle expectations.

## Requested change

Implement a structured OpenAI Responses adapter for the release-draft contract. Build bounded
input from selected candidate fields, request a strict schema, disable storage where supported,
validate the response through core postconditions, classify refusals/errors safely, and construct
the SDK only in an explicit live-AI composition root.

## Acceptance

- The request includes only selected candidate content documented by a testable input builder.
- Structured output and source-reference postconditions are both enforced.
- Refusal, truncation, invalid structure, invented source identity, rate limit, and safe provider
  failure have injected-client tests.
- Provider request/response bodies, prompts, credentials, and raw errors are never logged.
- Default mock mode and all tests perform no live call or DNS work.
- The oracle records product-shaped SDK/model/call-site expectations independently of detector
  output.
- All gates pass.

No live evaluation or provider call is authorized as part of this task.
