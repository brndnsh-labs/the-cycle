#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);

if (args[0] === '--version') {
    console.log('fake-pipeline-codex 1.0');
    process.exit(0);
}

if (args[0] === 'app-server') {
    if (!args.includes('--strict-config') || !args.includes('--listen') || !args.includes('off')) {
        console.error('fake pipeline Codex expected strict no-transport config probe');
        process.exit(2);
    }
    const home = process.env.CODEX_HOME;
    if (!home || existsSync(join(home, 'auth.json')) || process.env.OPENAI_API_KEY) {
        console.error('fake pipeline config probe received authentication');
        process.exit(2);
    }
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    if (!/\[permissions\.pipeline-fixture\.filesystem\]/.test(config)
        || !/":root" = "deny"/.test(config)
        || !/\[permissions\.pipeline-fixture\.network\]\nenabled = false/.test(config)) {
        console.error('fake pipeline config probe found an invalid permission profile');
        process.exit(1);
    }
    console.error('Error: no transport configured; use --listen or enable remote control');
    process.exit(1);
}

if (args[0] !== 'exec') {
    console.error('fake pipeline Codex expected codex exec');
    process.exit(2);
}

const resume = args[1] === 'resume';
const workspace = process.cwd();
const stage = process.env.CYCLE_PIPELINE_STAGE;
const arm = process.env.CYCLE_PIPELINE_ARM;
const caseId = process.env.CYCLE_PIPELINE_CASE;
const attempt = Number(process.env.CYCLE_PIPELINE_ATTEMPT ?? '1');
const turn = Number(process.env.CYCLE_PIPELINE_TURN ?? '1');
const threadId = process.env.CYCLE_PIPELINE_SESSION_ID ?? `fake-${caseId}-${arm}`;
let item = 0;

function event(value) {
    console.log(JSON.stringify(value));
}

function command(command, commandArgs) {
    const result = spawnSync(command, commandArgs, {
        cwd: workspace,
        env: process.env,
        encoding: 'utf8',
    });
    event({
        type: 'item.completed',
        item: {
            id: `item-${++item}`,
            type: 'command_execution',
            command: [command, ...commandArgs].join(' '),
            aggregated_output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
            exit_code: result.status,
            status: result.status === 0 ? 'completed' : 'failed',
        },
    });
    if (result.status !== 0) process.exit(result.status ?? 2);
    return result;
}

function finish(payload) {
    event({
        type: 'item.completed',
        item: { id: `item-${++item}`, type: 'agent_message', text: JSON.stringify(payload) },
    });
    event({
        type: 'turn.completed',
        usage: {
            input_tokens: 100,
            cached_input_tokens: resume ? 50 : 0,
            output_tokens: 25,
            reasoning_output_tokens: 5,
        },
    });
}

event({ type: 'thread.started', thread_id: threadId });
event({ type: 'turn.started' });

if (caseId === 'sik-133' && arm === 'intake' && attempt === 2 && turn === 1) {
    console.error('synthetic infrastructure interruption');
    process.exit(86);
}

if (caseId === 'sik-133' && arm === 'shaped-direct' && attempt === 1 && turn === 1) {
    event({ type: 'item.completed', item: { id: `item-${++item}`, type: 'agent_message', text: 'invalid fake response' } });
    event({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } });
    process.exit(0);
}

if (stage === 'intake') {
    if (turn === 1) {
        finish({
            status: 'needs-input',
            question: 'What exact boundary and acceptance behavior should this change use?',
            summary: 'The raw request needs one bounded acceptance decision.',
        });
    } else {
        const body = Buffer.from(process.env.CYCLE_PIPELINE_CANONICAL_ISSUE_BASE64 ?? '', 'base64').toString('utf8');
        command('gh', [
            'issue', 'create', '--title', `Frozen ${caseId} issue`, '--body', body, '--label', 'enhancement',
        ]);
        finish({ status: 'complete', question: '', summary: 'Filed one actionable issue.' });
    }
    process.exit(0);
}

if (arm === 'raw-direct' && turn === 1) {
    finish({
        status: 'needs-input',
        question: 'What behavior and edge cases should the implementation preserve?',
        summary: 'The short request needs one product clarification.',
    });
    process.exit(0);
}

if (stage === 'direct') {
    writeFileSync(join(workspace, 'feature.txt'), `${caseId} implemented\n`);
    command('npm', ['test']);
    finish({ status: 'complete', question: '', summary: 'Implemented and verified the direct arm.' });
    process.exit(0);
}

if (stage === 'implement') {
    command('gh', ['issue', 'view', '1', '--json', 'number,title,state,url,labels,milestone,body']);
    command('gh', ['issue', 'edit', '1', '--remove-label', 'status:ready,status:in-progress,status:in-review,status:needs-decision,status:blocked']);
    command('gh', ['issue', 'edit', '1', '--add-label', 'status:in-progress']);
    command('git', ['checkout', '-b', `eval/${caseId}`]);
    writeFileSync(join(workspace, 'feature.txt'), `${caseId} implemented\n`);
    command('npm', ['test']);
    finish({ status: 'complete', question: '', summary: 'Implemented the shaped issue and ran the gate.' });
    process.exit(0);
}

if (stage === 'review') {
    command('git', ['status', '--short']);
    command('git', ['diff', '--stat']);
    finish({ status: 'complete', question: '', summary: 'Review found one bounded edge-case hardening item.' });
    process.exit(0);
}

if (stage === 'patch') {
    appendFileSync(join(workspace, 'feature.txt'), 'review finding patched\n');
    command('npm', ['test']);
    finish({ status: 'complete', question: '', summary: 'Patched the review finding and reran the gate.' });
    process.exit(0);
}

if (stage === 'done') {
    command('gh', ['issue', 'view', '1', '--json', 'number,title,state,url,labels,milestone,body']);
    command('git', ['add', 'feature.txt']);
    command('git', ['commit', '-m', `fix: complete ${caseId} pipeline fixture`]);
    command('git', ['push', '-u', 'origin', `eval/${caseId}`]);
    command('gh', ['pr', 'create', '--head', `eval/${caseId}`, '--base', 'main', '--title', `Fix ${caseId}`, '--body', 'Closes #1']);
    command('gh', ['issue', 'edit', '1', '--remove-label', 'status:ready,status:in-progress,status:in-review,status:needs-decision,status:blocked']);
    command('gh', ['issue', 'edit', '1', '--add-label', 'status:in-review']);
    command('gh', ['issue', 'comment', '1', '--body', 'PR: https://example.invalid/pipeline-eval/pull/1']);
    if (caseId !== 'sik-133') {
        command('gh', ['pr', 'checks', '1', '--watch', '--interval', '30', '--fail-fast']);
        command('gh', ['pr', 'merge', '1', '--squash', '--delete-branch']);
        command('git', ['checkout', 'main']);
        command('git', ['fetch', 'origin']);
        command('git', ['reset', '--hard', 'origin/main']);
    }
    finish({ status: 'complete', question: '', summary: 'Committed, recorded the local push, and opened the fake PR.' });
    process.exit(0);
}

console.error(`unknown fake pipeline stage: ${stage}`);
process.exit(2);
