import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the required gates job exercises both the default runtime and the exact Node floor', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const gatesStart = workflow.indexOf('\n  gates:\n');
    assert.notEqual(gatesStart, -1, 'CI no longer defines the branch-protected gates job');

    const afterGates = workflow.slice(gatesStart + '\n  gates:\n'.length);
    const nextJob = afterGates.search(/^  [a-zA-Z0-9_-]+:\n/m);
    const gates = nextJob === -1 ? afterGates : afterGates.slice(0, nextJob);
    const node22 = gates.indexOf("node-version: '22'");
    const node20 = gates.indexOf("node-version: '20.0.0'");

    assert.ok(node22 >= 0, 'gates does not exercise the default Node runtime');
    assert.ok(node20 > node22, 'gates does not exercise Node 20.0.0 after the default runtime');
    assert.doesNotMatch(workflow, /^  compat-node-20:/m, 'compatibility must not live in an optional job');
});
