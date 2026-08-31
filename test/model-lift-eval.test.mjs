import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildPlan,
    loadProtocol,
    validateProtocol,
    verifierSandboxArgs,
} from '../eval/model-lift/run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_ROOT = join(ROOT, 'eval', 'model-lift');
const RUNNER = join(EVAL_ROOT, 'run.mjs');
const PROTOCOL_PATH = join(EVAL_ROOT, 'protocol.json');

function json(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function permissionBits(path) {
    return statSync(path).mode & 0o777;
}

function assertPrivateTree(path) {
    assert.equal(permissionBits(path), 0o700, `${path} must be mode 0700`);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) assertPrivateTree(child);
        else {
            assert.ok(entry.isFile(), `${child} must not be a link or special file`);
            assert.equal(permissionBits(child), 0o600, `${child} must be mode 0600`);
        }
    }
}

test('model-lift protocol freezes the two models, three arms, five stages, and local assets', () => {
    const { protocol } = loadProtocol(PROTOCOL_PATH);
    assert.deepEqual(protocol.models, [
        { id: 'luna', model: 'gpt-5.6-luna' },
        { id: 'sol', model: 'gpt-5.6-sol' },
    ]);
    assert.deepEqual(protocol.arms.map((arm) => arm.id), [
        'raw-direct', 'shaped-direct', 'full-cycle',
    ]);
    assert.deepEqual(protocol.execution.full_cycle.resumed_stages, [
        'implement', 'review', 'patch', 'review', 'done',
    ]);
    assert.deepEqual(protocol.gates.candidate_matrix, [
        'pnpm check', 'pnpm build',
    ]);
    assert.equal(protocol.execution.pnpm_version, '11.24.0');
    assert.equal(protocol.execution.node_version, 'v26.8.1');
    assert.equal(protocol.execution.verifier_sandbox, 'bubblewrap 0.12.0');
    assert.deepEqual(protocol.execution.inner_gate_matrix, [
        'pnpm format:check',
        'pnpm lint',
        'pnpm typecheck',
        'pnpm build',
        'pnpm --filter @release-relay/openai-integration test',
    ]);
    assert.deepEqual(protocol.execution.package_manager_policy, [
        'pmOnFail: ignore',
        'trustLockfile: true',
        'storeDir: fixture-private scratch index',
    ]);
    assert.deepEqual(buildPlan(protocol), {
        study_id: 'release-relay-sol-luna-model-lift-v1',
        models: protocol.models,
        reasoning_effort: 'high',
        model_order: ['luna', 'sol'],
        models_per_batch: 1,
        intake_only_per_model: true,
        implementation_arms_per_model: ['raw-direct', 'shaped-direct', 'full-cycle'],
        full_cycle_stages: ['implement', 'review', 'patch', 'review', 'done'],
        minimum_model_turns_per_model: 9,
        maximum_model_turns_per_attempt: 30,
        retry_limits: {
            behavioral: 1,
            infrastructure: 1,
            max_attempts_per_model: 3,
        },
    });

    const plan = JSON.parse(execFileSync(process.execPath, [RUNNER, 'plan'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
    }));
    assert.match(plan.protocol_sha256, /^[0-9a-f]{64}$/);

    const reordered = structuredClone(protocol);
    reordered.schedule.model_order.reverse();
    assert.throws(() => validateProtocol(reordered), /invalid schedule/);
    const unlocked = structuredClone(protocol);
    unlocked.artifact_lock = {};
    assert.throws(() => validateProtocol(unlocked), /not artifact-locked/);
});

test('verifier sandbox unshares the network and mounts no user home', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cycle-model-lift-bwrap-'));
    try {
        const args = verifierSandboxArgs(workspace, 'pnpm check', {
            node: '/usr/bin/node',
            pnpm: '/usr/bin/node',
        });
        assert.ok(args.includes('--unshare-all'));
        assert.ok(args.includes('--unshare-user'));
        assert.ok(args.includes('--disable-userns'));
        assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), [
            '--cap-drop', 'ALL',
        ]);
        assert.ok(args.includes('--clearenv'));
        assert.deepEqual(args.slice(-3), ['/bin/sh', '-c', 'pnpm check']);
        assert.ok(args.includes(workspace));
        assert.equal(args.includes('/etc'), false);
        assert.equal(args.some((arg) => arg === '/home/brandon' || arg.startsWith('/home/brandon/')), false);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test('candidate verifier initializes Git before applying an uncommitted candidate delta', () => {
    const runner = readFileSync(RUNNER, 'utf8');
    const body = runner.match(/export function prepareVerifier\([\s\S]+?\n}\n\nfunction executablePath/)?.[0];
    assert.ok(body, 'prepareVerifier body must remain discoverable');
    const control = body.indexOf('writeControlAssets(destination, protocol, protocolPath)');
    const initialize = body.indexOf('initializeRepository(destination, protocol.execution.fixture_commit_time)');
    const candidate = body.indexOf('copyCandidateDelta(candidate, fixture.initial_commit, destination)');
    const oracle = body.indexOf('writeFileSync(oracleTarget');
    assert.ok(control >= 0 && control < initialize, 'control assets must be frozen into the verifier root');
    assert.ok(initialize < candidate, 'candidate delta must remain uncommitted');
    assert.ok(candidate < oracle, 'the evaluator-owned oracle must overwrite any candidate path');

    const preflight = runner.match(/function preflight\([\s\S]+?\n}\n\nfunction resultIndexPath/)?.[0];
    assert.ok(preflight, 'preflight body must remain discoverable');
    assert.match(preflight, /prepareVerifier\([\s\S]+?candidate_matrix/,
        'preflight gates must exercise the final verifier constructor');
});

test('model-free batches resume an exact model prefix and produce a private blinded packet', {
    timeout: 120_000,
}, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-model-lift-test-'));
    try {
        const output = join(scratch, 'output');
        const first = JSON.parse(execFileSync(process.execPath, [
            RUNNER, 'dry-run-batch', '--output', output,
        ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }));
        assert.deepEqual(first, {
            accepted_models: ['luna'],
            total_models: 2,
            attempts: 1,
            invalid_attempts: 0,
            model_turns_started: 10,
            model_turns_completed: 10,
            complete: false,
            terminal_invalid_model: null,
        });
        assert.equal(existsSync(join(output, 'scoring')), false);

        const resultsPath = join(output, 'private', 'results.json');
        const originalResults = readFileSync(resultsPath, 'utf8');
        const wrongPrefix = JSON.parse(originalResults);
        wrongPrefix[0].model_id = 'sol';
        writeFileSync(resultsPath, `${JSON.stringify(wrongPrefix, null, 2)}\n`);
        chmodSync(resultsPath, 0o600);
        const rejectedPrefix = spawnSync(process.execPath, [
            RUNNER, 'dry-run-batch', '--output', output,
        ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
        assert.equal(rejectedPrefix.status, 2);
        assert.match(rejectedPrefix.stderr, /resumable result identity mismatch: model_id/);
        writeFileSync(resultsPath, originalResults);
        chmodSync(resultsPath, 0o600);

        const second = JSON.parse(execFileSync(process.execPath, [
            RUNNER, 'dry-run-batch', '--output', output,
        ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }));
        assert.deepEqual(second.accepted_models, ['luna', 'sol']);
        assert.equal(second.complete, true);
        assert.equal(second.attempts, 2);
        assert.equal(second.model_turns_started, 20);
        assert.equal(second.model_turns_completed, 20);

        const results = json(resultsPath);
        assert.equal(results.length, 2);
        for (const result of results) {
            assert.equal(result.valid, true);
            assert.deepEqual(result.arms.map((arm) => arm.arm), [
                'raw-direct', 'shaped-direct', 'full-cycle',
            ]);
            const cycle = result.arms.find((arm) => arm.arm === 'full-cycle');
            assert.deepEqual(cycle.lifecycle.map((stage) => stage.stage), [
                'implement', 'review', 'patch', 'review', 'done',
            ]);
            assert.deepEqual(cycle.snapshots.map((snapshot) => snapshot.stage), [
                'implement', 'review', 'patch', 'finding-closure', 'done',
            ]);
            assert.equal(new Set(cycle.lifecycle.map((stage) => stage.thread_id)).size, 1);
        }

        const scoringText = readFileSync(join(output, 'scoring', 'scoring-input.json'), 'utf8');
        const scoring = JSON.parse(scoringText);
        assert.equal(scoring.outputs.length, 6);
        assert.equal(scoring.intake.length, 2);
        assert.doesNotMatch(scoringText, /gpt-5\.6-(?:luna|sol)|raw-direct|shaped-direct|full-cycle/);
        assert.match(readFileSync(join(output, 'private', 'blinding-map.json'), 'utf8'), /full-cycle/);
        assertPrivateTree(output);

        const completedResume = JSON.parse(execFileSync(process.execPath, [
            RUNNER, 'dry-run-batch', '--output', output,
        ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }));
        assert.equal(completedResume.complete, true);
        assert.equal(completedResume.attempts, 2);

        const scoringPath = join(output, 'scoring', 'scoring-input.json');
        writeFileSync(scoringPath, 'tampered\n');
        chmodSync(scoringPath, 0o600);
        const tampered = spawnSync(process.execPath, [
            RUNNER, 'dry-run-batch', '--output', output,
        ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
        assert.equal(tampered.status, 2);
        assert.match(tampered.stderr, /resumable artifact content changed/);
        assert.equal(existsSync(join(output, '.batch.lock')), false);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
