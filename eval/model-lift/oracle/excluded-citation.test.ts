import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateItem } from "@release-relay/core";
import { createOpenAiDrafter, type OpenAiApi } from "./draft.js";

const candidates: readonly CandidateItem[] = [
  {
    sourceIdentity: "pull/1",
    sourceUrl: "https://github.com/example/project/pull/1",
    title: "Included change",
    included: true,
    order: 0
  },
  {
    sourceIdentity: "issue/7",
    sourceUrl: "https://github.com/example/project/issues/7",
    title: "Excluded change",
    included: false,
    order: 1
  }
];

function response(sourceIdentity: string) {
  return {
    status: "completed",
    created_at: 1_800_000_000,
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              title: "Release",
              summary: "Summary",
              supporterNote: null,
              changeGroups: [
                {
                  kind: "changed",
                  heading: "Changed",
                  items: [{ summary: "Change", sourceIdentities: [sourceIdentity] }]
                }
              ],
              acknowledgements: []
            })
          }
        ]
      }
    ]
  };
}

function drafter(sourceIdentity: string) {
  const api: OpenAiApi = {
    createResponse: () => Promise.resolve(response(sourceIdentity))
  };
  return createOpenAiDrafter(api, {
    model: "offline-model",
    configurationId: "offline-config"
  });
}

test("an excluded citation is rejected while an included citation remains valid", async () => {
  const excluded = await drafter("issue/7").draft({
    operationId: "excluded",
    candidates
  });
  assert.equal(excluded.status, "completed");
  if (excluded.status !== "completed") return;
  assert.deepEqual(excluded.value, {
    kind: "unsupported-claims",
    findings: [{ code: "unknown-source", sourceIdentity: "issue/7" }]
  });

  const included = await drafter("pull/1").draft({
    operationId: "included",
    candidates
  });
  assert.equal(included.status, "completed");
  if (included.status !== "completed") return;
  assert.equal(included.value.kind, "validated-draft");
});
