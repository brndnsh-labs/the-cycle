#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);

if (args[0] === '--version') {
    console.log('fake-review-codex 1.0');
    process.exit(0);
}

if (args[0] !== 'exec') {
    console.error('fake reviewer expected codex exec');
    process.exit(2);
}

const cdIndex = args.indexOf('--cd');
if (cdIndex < 0 || !args[cdIndex + 1]) {
    console.error('fake reviewer requires --cd');
    process.exit(2);
}

const workspace = args[cdIndex + 1];
const guidancePaths = [
    '.agents/skills/review/SKILL.md',
    '.agents/skills/DOCTRINE.md',
];
const fakeMode = process.env.CYCLE_REVIEW_FAKE_MODE || 'default';
let item = 0;

console.log(JSON.stringify({ type: 'thread.started', thread_id: `fake-${process.env.CYCLE_REVIEW_CELL ?? 'cell'}` }));
console.log(JSON.stringify({ type: 'turn.started' }));

for (const path of guidancePaths) {
    const guidance = join(workspace, path);
    if (!existsSync(guidance)) continue;
    const content = readFileSync(guidance, 'utf8');
    console.log(JSON.stringify({
        type: 'item.completed',
        item: {
            id: `item-${++item}`,
            type: 'command_execution',
            command: `cat ${path}`,
            aggregated_output: fakeMode === 'guidance-mention-only'
                ? 'mentioned a path without returning its contents\n'
                : content,
            exit_code: 0,
            status: 'completed',
        },
    }));
}

const firstPair = process.env.CYCLE_REVIEW_PAIR_INDEX === '1';
const exerciseInvalidRetry = fakeMode === 'default'
    ? firstPair && process.env.CYCLE_REVIEW_ARM === 'baseline'
        && process.env.CYCLE_REVIEW_ATTEMPT === '1'
    : fakeMode === 'split-retry' && firstPair
        && ((process.env.CYCLE_REVIEW_ARM === 'baseline' && process.env.CYCLE_REVIEW_ATTEMPT === '1')
            || (process.env.CYCLE_REVIEW_ARM === 'treatment' && process.env.CYCLE_REVIEW_ATTEMPT === '2'));

console.log(JSON.stringify({
    type: 'item.completed',
    item: {
        id: `item-${++item}`,
        type: 'agent_message',
        text: exerciseInvalidRetry
            ? 'deliberately invalid fake response'
            : JSON.stringify({ findings: [], summary: 'No actionable findings in deterministic fake review.' }),
    },
}));
console.log(JSON.stringify({
    type: 'turn.completed',
    usage: {
        input_tokens: 100,
        cached_input_tokens: 25,
        output_tokens: 20,
        reasoning_output_tokens: 5,
    },
}));
