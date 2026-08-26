import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExecEvents } from '../eval/run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ROOT, 'eval', 'run.mjs');

function fakeCodexSource() {
    return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
    console.log('fake-codex 1.0');
    process.exit(0);
}
if (args[0] !== 'exec') {
    console.error('expected codex exec');
    process.exit(2);
}
const cd = args.indexOf('--cd');
const workspace = args[cd + 1];
const scenario = process.env.CYCLE_EVAL_SCENARIO_ID;
writeFileSync(join(workspace, '.cycle-eval', 'codex-args.json'), JSON.stringify(args, null, 2) + '\\n');
writeFileSync(join(workspace, '.cycle-eval', 'codex-env.json'), JSON.stringify({
    forwarded_sentinel: process.env.CYCLE_EVAL_TEST_SECRET !== undefined,
    home: process.env.HOME,
    tmpdir: process.env.TMPDIR,
}, null, 2) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-' + scenario }));
console.log(JSON.stringify({ type: 'turn.started' }));
let item = 0;
const execute = (command, commandArgs) => {
    const result = spawnSync(command, commandArgs, {
        cwd: workspace,
        encoding: 'utf8',
        env: process.env,
    });
    console.log(JSON.stringify({
        type: 'item.completed',
        item: {
            id: 'item-' + (++item),
            type: 'command_execution',
            command: [command, ...commandArgs].join(' '),
            aggregated_output: (result.stdout ?? '') + (result.stderr ?? ''),
            exit_code: result.status,
            status: result.status === 0 ? 'completed' : 'failed',
        },
    }));
    return result;
};
const requireSuccess = (result) => {
    if (result.status !== 0) process.exit(result.status ?? 2);
};
if (scenario === 'safe-bounded' || scenario === 'dirty-worktree') {
    if (process.env.FAKE_CODEX_SKIP_BEHAVIOR !== '1') {
        requireSuccess(execute('gh', ['issue', 'view', '1', '--json', 'number,title,state,url,labels,milestone,body']));
        writeFileSync(join(workspace, 'feature.txt'), 'implemented\\n');
        const statusEdits = [
            ['issue', 'edit', '1', '--remove-label',
                'status:ready,status:in-progress,status:in-review,status:needs-decision,status:blocked'],
            ['issue', 'edit', '1', '--add-label', 'status:in-progress'],
        ];
        if (process.env.FAKE_CODEX_REVERSE_STATUS === '1') statusEdits.reverse();
        for (const edit of statusEdits) requireSuccess(execute('gh', edit));
        requireSuccess(execute('npm', ['test']));
    }
} else if (scenario === 'needs-decision') {
    requireSuccess(execute('gh', ['issue', 'view', '1', '--json', 'number,title,state,url,labels,milestone,body']));
} else if (scenario === 'tracker-outage') {
    const result = execute('gh', ['issue', 'view', '1', '--json', 'number,title,state,url,labels,milestone,body']);
    if (result.status === 0) {
        console.error('tracker outage did not fail');
        process.exit(2);
    }
} else {
    console.error('unknown scenario ' + scenario);
    process.exit(2);
}
console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 20, reasoning_output_tokens: 5 },
}));
`;
}

test('Codex JSONL parsing keeps usage and rejects malformed streams', () => {
    const parsed = parseExecEvents([
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }),
        '',
    ].join('\n'));
    assert.equal(parsed.invalid, null);
    assert.deepEqual(parsed.usage, { input_tokens: 7, output_tokens: 3 });

    const malformed = parseExecEvents('{"type":"turn.started"}\nnot json\n');
    assert.equal(malformed.invalid, 'malformed JSONL at line(s) 2');
});

test('behavioral runner compares isolated snapshots without making a model call', { timeout: 120_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-eval-test-'));
    try {
        const fakeCodex = join(scratch, 'codex');
        const output = join(scratch, 'results');
        writeFileSync(fakeCodex, fakeCodexSource());
        chmodSync(fakeCodex, 0o755);

        execFileSync(process.execPath, [
            RUNNER,
            '--baseline', 'HEAD',
            '--candidate', ROOT,
            '--model', 'fake-model',
            '--output', output,
            '--codex-bin', fakeCodex,
            '--timeout-ms', '30000',
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
            env: { ...process.env, CYCLE_EVAL_TEST_SECRET: 'must-not-be-forwarded' },
        });

        const results = readFileSync(join(output, 'results.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        assert.equal(results.length, 8);
        assert.deepEqual(new Set(results.map((result) => result.scenario)), new Set([
            'dirty-worktree',
            'needs-decision',
            'safe-bounded',
            'tracker-outage',
        ]));
        assert.deepEqual(new Set(results.map((result) => result.arm)), new Set(['baseline', 'candidate']));
        assert.ok(results.every((result) => result.invalid_reason === null));
        assert.ok(results.every((result) => result.passed === true));
        assert.ok(results.every((result) => result.codex_version === 'fake-codex 1.0'));
        assert.ok(results.every((result) => result.usage.input_tokens === 100));
        assert.ok(results.every((result) => /^[a-f0-9]{64}$/.test(result.snapshot.source_sha256)));

        for (const scenario of new Set(results.map((result) => result.scenario))) {
            const pair = results.filter((result) => result.scenario === scenario);
            assert.equal(pair.length, 2);
            assert.equal(pair[0].fixture_sha256, pair[1].fixture_sha256);
            assert.equal(pair[0].snapshot.rendered_skill_sha256, pair[1].snapshot.rendered_skill_sha256);
            const workspaces = pair.map((result) => join(output, result.artifacts.workspace));
            assert.notEqual(workspaces[0], workspaces[1]);
            assert.notEqual(statSync(workspaces[0]).ino, statSync(workspaces[1]).ino);
        }

        const experiment = JSON.parse(readFileSync(join(output, 'experiment.json'), 'utf8'));
        assert.equal(experiment.model, 'fake-model');
        assert.equal(experiment.repeat, 1);
        assert.equal(experiment.codex_version, 'fake-codex 1.0');
        assert.match(experiment.baseline.source_sha256, /^[a-f0-9]{64}$/);
        assert.match(experiment.candidate.source_sha256, /^[a-f0-9]{64}$/);

        const invocation = JSON.parse(readFileSync(join(
            output,
            results[0].artifacts.workspace,
            '.cycle-eval',
            'codex-args.json',
        ), 'utf8'));
        assert.ok(invocation.includes('--json'));
        assert.ok(invocation.includes('--ephemeral'));
        assert.ok(invocation.includes('--ignore-user-config'));
        assert.ok(invocation.includes('workspace-write'));
        assert.ok(invocation.includes('fake-model'));
        assert.ok(!invocation.includes('--approve-for-me'));
        assert.ok(invocation.includes('approval_policy="never"'));
        assert.ok(invocation.includes('sandbox_workspace_write.network_access=false'));
        assert.ok(invocation.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
        assert.ok(invocation.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
        assert.ok(invocation.includes('shell_environment_policy.inherit="core"'));
        const codexEnv = JSON.parse(readFileSync(join(
            output,
            results[0].artifacts.workspace,
            '.cycle-eval',
            'codex-env.json',
        ), 'utf8'));
        assert.equal(codexEnv.forwarded_sentinel, false);
        assert.equal(codexEnv.home, join(output, results[0].artifacts.workspace, '.cycle-eval', 'home'));
        assert.equal(codexEnv.tmpdir, join(output, results[0].artifacts.workspace, '.cycle-eval', 'tmp'));

        const bounded = results.filter((result) => ['safe-bounded', 'dirty-worktree'].includes(result.scenario));
        assert.ok(bounded.every((result) => result.artifacts.independent_gate));
        assert.ok(bounded.every((result) => result.assertions.some((assertion) =>
            assertion.type === 'fixture_gate' && assertion.pass)));
        assert.ok(bounded.every((result) => result.assertions.some((assertion) =>
            assertion.type === 'commands_succeeded_in_order' && assertion.pass)));

        const failingOutput = join(scratch, 'behavioral-failure');
        const run = execFileSync(process.execPath, [
            RUNNER,
            '--baseline', ROOT,
            '--candidate', ROOT,
            '--model', 'fake-model',
            '--output', failingOutput,
            '--codex-bin', fakeCodex,
            '--scenario', 'safe-bounded',
            '--repeat', '2',
            '--timeout-ms', '30000',
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
            env: { ...process.env, FAKE_CODEX_SKIP_BEHAVIOR: '1' },
        });
        assert.match(run, /safe-bounded\s+1\s+FAIL\s+FAIL/);
        assert.match(run, /safe-bounded\s+2\s+FAIL\s+FAIL/);
        const failures = readFileSync(join(failingOutput, 'results.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        assert.equal(failures.length, 4);
        assert.ok(failures.every((result) => result.invalid_reason === null));
        assert.ok(failures.every((result) => result.passed === false));

        const orderOutput = join(scratch, 'status-order-failure');
        execFileSync(process.execPath, [
            RUNNER,
            '--baseline', ROOT,
            '--candidate', ROOT,
            '--model', 'fake-model',
            '--output', orderOutput,
            '--codex-bin', fakeCodex,
            '--scenario', 'safe-bounded',
            '--timeout-ms', '30000',
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
            env: { ...process.env, FAKE_CODEX_REVERSE_STATUS: '1' },
        });
        const orderFailures = readFileSync(join(orderOutput, 'results.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        assert.ok(orderFailures.every((result) => result.passed === false));
        assert.ok(orderFailures.every((result) => result.assertions.some((assertion) =>
            assertion.type === 'commands_succeeded_in_order' && !assertion.pass)));

        const missing = spawnSync(process.execPath, [
            RUNNER,
            '--baseline', ROOT,
            '--candidate', ROOT,
            '--model', 'fake-model',
            '--output', join(scratch, 'missing-codex'),
            '--codex-bin', join(scratch, 'does-not-exist'),
        ], { cwd: ROOT, encoding: 'utf8' });
        assert.equal(missing.status, 2);
        assert.match(missing.stderr, /cannot run .*does-not-exist --version/);
        assert.doesNotMatch(missing.stderr, /\n\s+at /);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
