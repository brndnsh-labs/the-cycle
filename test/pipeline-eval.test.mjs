import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertNoCredentialMaterial,
    buildPlan,
    clientEnvironment,
    loadProtocol,
    parseExecEvents,
    pipelineConfig,
    probePipelineConfig,
    sanitizeCandidateRepository,
    scriptedAnswer,
    sha256,
    trackerCreates,
    validateTurnText,
} from '../eval/pipeline/run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIPELINE_ROOT = join(ROOT, 'eval', 'pipeline');
const RUNNER = join(PIPELINE_ROOT, 'run.mjs');
const PROTOCOL_PATH = join(PIPELINE_ROOT, 'protocol.json');

function json(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function hashFiles(paths) {
    const hash = createHash('sha256');
    for (const rel of paths) {
        hash.update(rel);
        hash.update('\0');
        hash.update(readFileSync(join(PIPELINE_ROOT, rel)));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function permissionBits(path) {
    return statSync(path).mode & 0o777;
}

function assertPrivateTree(path) {
    assert.equal(permissionBits(path), 0o700, `${path} must be mode 0700`);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) assertPrivateTree(child);
        else assert.equal(permissionBits(child), 0o600, `${child} must be mode 0600`);
    }
}

test('pipeline protocol freezes the census, three arms, four cases, and local artifacts', () => {
    const { protocol } = loadProtocol(PROTOCOL_PATH);
    assert.deepEqual(protocol.schedule.case_order, ['sik-133', 'sik-131', 'sik-139', 'sik-123']);
    assert.deepEqual(protocol.arms.map((arm) => arm.id), ['raw-direct', 'shaped-direct', 'full-cycle']);
    assert.equal(protocol.schedule.cases_per_batch, 1);
    assert.equal(protocol.schedule.invalid_case_retry_limit, 1);
    assert.equal(protocol.execution.model, 'gpt-5.6-sol');
    assert.equal(protocol.execution.reasoning_effort, 'high');
    assert.equal(protocol.execution.codex_version, 'codex-cli 0.150.1');
    assert.equal(protocol.execution.command_network, false);
    assert.equal(protocol.execution.subagents, false);
    assert.deepEqual(protocol.execution.full_cycle.resumed_stages, ['implement', 'review', 'patch', 'done']);
    assert.equal(buildPlan(protocol).minimum_model_turns_per_valid_case, 7);
    const scoreSchema = json(join(PIPELINE_ROOT, protocol.scoring.schema_path));
    const scoreCase = scoreSchema.properties.cases.items.properties;
    assert.deepEqual(scoreCase.outcomes.required, ['A', 'B', 'C']);
    assert.deepEqual(scoreCase.process_quality.required, ['A', 'B', 'C']);
    assert.deepEqual(scoreCase.notes.required, ['A', 'B', 'C']);
    assert.deepEqual([123, 130, 131, 133, 139]
        .map((issue) => ({ issue, rank: sha256(`full-pipeline-pilot-v1-2026-08-30:${issue}`) }))
        .sort((a, b) => a.rank.localeCompare(b.rank))
        .map(({ issue }) => issue), [133, 131, 139, 123, 130]);

    assert.equal(sha256(readFileSync(RUNNER)), protocol.artifact_lock.runner_sha256);
    assert.equal(
        sha256(readFileSync(join(PIPELINE_ROOT, 'fake-codex.cjs'))),
        protocol.artifact_lock.fake_codex_sha256,
    );
    assert.equal(
        hashFiles(['bin/gh', 'bin/fake-gh.cjs']),
        protocol.artifact_lock.fake_tracker_sha256,
    );
    assert.equal(
        sha256(readFileSync(join(PIPELINE_ROOT, 'bin', 'git'))),
        protocol.artifact_lock.fake_git_sha256,
    );
    assert.equal(
        sha256(readFileSync(join(PIPELINE_ROOT, protocol.census_path))),
        protocol.artifact_lock.census_sha256,
    );
    for (const item of protocol.cases) {
        const lock = protocol.artifact_lock.cases[item.id];
        assert.equal(
            sha256(readFileSync(join(PIPELINE_ROOT, item.raw_prompt_path))),
            lock.raw_prompt_sha256,
        );
        assert.equal(
            sha256(readFileSync(join(PIPELINE_ROOT, item.canonical_issue_path))),
            lock.canonical_issue_sha256,
        );
        assert.equal(
            sha256(readFileSync(join(PIPELINE_ROOT, item.answer_sheet_path))),
            lock.answer_sheet_sha256,
        );
    }
});

test('pipeline config grants one writable workspace and drops ambient credentials', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-pipeline-config-test-'));
    try {
        const workspace = join(scratch, 'workspace');
        mkdirSync(workspace);
        const config = pipelineConfig({
            workspace,
            codexBin: join(PIPELINE_ROOT, 'fake-codex.cjs'),
            issueBody: 'body',
            issueTitle: 'title',
        });
        assert.match(config, /":root" = "deny"/);
        assert.match(config, /":minimal" = "read"/);
        assert.match(config, new RegExp(`${workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" = "write"`));
        assert.match(config, /\[permissions\.pipeline-fixture\.network\]\nenabled = false/);
        assert.match(config, /\[shell_environment_policy\]\ninherit = "none"/);
        assert.match(config, /multi_agent = false/);
        assert.doesNotMatch(config, /OPENAI_API_KEY|GH_TOKEN|NPM_TOKEN/);
        const neutralConfig = pipelineConfig({
            workspace,
            codexBin: join(PIPELINE_ROOT, 'fake-codex.cjs'),
        });
        assert.doesNotMatch(neutralConfig, /CYCLE_PIPELINE_ISSUE_(?:BODY|TITLE|LABEL)/);

        const env = clientEnvironment({
            clientHome: '/private/client',
            scratch: '/private/tmp',
            caseId: 'sik-123',
            arm: 'raw-direct',
            stage: 'direct',
            attempt: 1,
            turn: 1,
            sessionId: 'session',
        }, {
            PATH: '/usr/bin:/bin',
            OPENAI_API_KEY: 'secret',
            GH_TOKEN: 'secret',
            NPM_TOKEN: 'secret',
        });
        assert.equal(env.OPENAI_API_KEY, undefined);
        assert.equal(env.GH_TOKEN, undefined);
        assert.equal(env.NPM_TOKEN, undefined);
        assert.equal(env.HOME, '/private/client');
        assert.match(env.PATH, /eval\/pipeline\/bin/);

        const auth = join(scratch, 'auth.json');
        const token = 'pipeline-auth-fingerprint-1234567890';
        writeFileSync(auth, `${JSON.stringify({ token })}\n`);
        assert.doesNotThrow(() => assertNoCredentialMaterial(['ordinary output'], auth));
        assert.throws(
            () => assertNoCredentialMaterial([`accidental ${token} disclosure`], auth),
            /authentication material/,
        );
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('turn parsing and frozen answer selection reject malformed lifecycle output', () => {
    const parsed = parseExecEvents([
        JSON.stringify({ type: 'thread.started', thread_id: 'thread' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }),
        '',
    ].join('\n'));
    assert.equal(parsed.invalid, null);
    assert.deepEqual(parsed.usage, { input_tokens: 7, output_tokens: 3 });
    assert.equal(parseExecEvents('null\nnot json\n').invalid,
        'malformed JSONL at line(s) 2; invalid JSONL event at line(s) 1');

    assert.deepEqual(validateTurnText(JSON.stringify({
        status: 'complete', question: '', summary: 'done',
    })), {
        invalid: null,
        value: { status: 'complete', question: '', summary: 'done' },
    });
    assert.equal(validateTurnText('not json').invalid, 'final response is not JSON');
    assert.equal(validateTurnText(JSON.stringify({
        status: 'needs-input', question: '', summary: 'missing question',
    })).invalid, 'final response does not match turn.schema.json');

    const sheet = json(join(PIPELINE_ROOT, 'answers', 'sik-133.json'));
    assert.equal(scriptedAnswer(sheet, 'Do you approve this draft for filing?').rule_id, 'approve-filing');
    assert.equal(scriptedAnswer(sheet, 'Which byte limit should I use?').rule_id, 'default');

    const marker = (name, value) => `CYCLE_PIPELINE_TRACKER_${name}:${Buffer.from(value).toString('base64')}`;
    assert.deepEqual(trackerCreates([{ events: [{
        type: 'item.completed',
        item: {
            type: 'command_execution',
            aggregated_output: [
                marker('CREATE', 'first body'), marker('TITLE', 'first title'),
                marker('CREATE', 'second body'), marker('TITLE', 'second title'),
            ].join('\n'),
        },
    }] }]), [
        { body: 'first body', title: 'first title' },
        { body: 'second body', title: 'second title' },
    ]);
});

test('fake Codex passes the strict model-free profile probe without authentication', () => {
    assert.deepEqual(probePipelineConfig(join(PIPELINE_ROOT, 'fake-codex.cjs')), {
        strict_config: 'pass',
        authentication: 'absent',
        model_calls: 0,
    });
});

test('candidate Git controls are pinned and sanitized before evaluator-side inspection', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-pipeline-git-control-test-'));
    try {
        const workspace = join(scratch, 'workspace');
        mkdirSync(workspace);
        execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: workspace });
        const original = lstatSync(join(workspace, '.git'));
        const identity = { dev: original.dev, ino: original.ino };
        execFileSync('/usr/bin/git', ['config', 'core.fsmonitor', '/bin/false'], { cwd: workspace });
        sanitizeCandidateRepository(workspace, identity);
        assert.doesNotMatch(readFileSync(join(workspace, '.git', 'config'), 'utf8'), /fsmonitor/i);

        const replacement = join(scratch, 'replacement.git');
        mkdirSync(replacement);
        rmSync(join(workspace, '.git'), { recursive: true, force: true });
        symlinkSync(replacement, join(workspace, '.git'));
        assert.throws(
            () => sanitizeCandidateRepository(workspace, identity),
            /replaced its \.git control directory/,
        );
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('model-free full pilot exercises follow-ups, retry, three arms, four resumed stages, and blinding', {
    timeout: 120_000,
}, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-pipeline-dry-test-'));
    try {
        const output = join(scratch, 'output');
        execFileSync(process.execPath, [RUNNER, 'dry-run', '--output', output], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        });
        assert.deepEqual(json(join(output, 'summary.json')), {
            complete: true,
            completed_cases: 4,
            total_cases: 4,
            remaining_cases: 0,
            attempts: 5,
            invalid_attempts: 1,
            model_turns_started: 41,
            model_turns_completed: 41,
            usage: {
                reported_turns: 41,
                totals: {
                    input_tokens: 4010,
                    cached_input_tokens: 1100,
                    output_tokens: 1003,
                    reasoning_output_tokens: 200,
                },
            },
        });
        const results = readFileSync(join(output, 'private', 'results.jsonl'), 'utf8')
            .trim().split('\n').map(JSON.parse);
        assert.equal(results.length, 5);
        assert.equal(results.filter((result) => !result.valid).length, 1);
        assert.deepEqual(results[0].invalid_reasons, [
            'shaped-direct: direct turn 1: final response is not JSON',
        ]);
        assert.equal(results[1].attempt, 2);
        assert.ok(results.slice(1).every((result) => result.valid));
        for (const result of results.slice(1)) {
            assert.deepEqual(result.arms.map((arm) => arm.arm), [
                'raw-direct', 'shaped-direct', 'full-cycle',
            ]);
            const shaped = result.arms.find((arm) => arm.arm === 'shaped-direct');
            const cycle = result.arms.find((arm) => arm.arm === 'full-cycle');
            assert.equal(shaped.input_sha256, result.shaped_issue_envelope_sha256);
            assert.equal(cycle.input_sha256, result.shaped_issue_envelope_sha256);
            assert.ok(result.shaped_issue_title_sha256);
            assert.deepEqual(cycle.snapshots.map((snapshot) => snapshot.stage), [
                'implement', 'review', 'patch', 'done',
            ]);
            const stages = cycle.lifecycle;
            assert.deepEqual(stages.map((stage) => stage.stage), ['implement', 'review', 'patch', 'done']);
            assert.equal(new Set(stages.map((stage) => stage.thread_id)).size, 1);
            assert.equal(result.intake_issue_count, 1);
        }
        const scoring = readFileSync(join(output, 'scoring', 'scoring-input.json'), 'utf8');
        assert.doesNotMatch(scoring, /raw-direct|shaped-direct|full-cycle/);
        assert.doesNotMatch(scoring, /\/tmp\//);
        assert.doesNotMatch(scoring, /\/home\//);
        assert.equal(JSON.parse(scoring).packets.length, 4);
        assert.equal(JSON.parse(scoring).packets.flatMap((packet) => packet.outputs).length, 12);
        assert.match(readFileSync(join(output, 'private', 'blinding-map.json'), 'utf8'), /full-cycle/);
        assertPrivateTree(output);

        const completedResume = JSON.parse(execFileSync(process.execPath, [
            RUNNER, 'dry-run-batch', '--output', output,
        ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }));
        assert.equal(completedResume.complete, true);
        writeFileSync(join(output, 'scoring', 'scoring-input.json'), 'tampered\n');
        chmodSync(join(output, 'scoring', 'scoring-input.json'), 0o600);
        const tamperedScoring = spawnSync(process.execPath, [
            RUNNER, 'dry-run-batch', '--output', output,
        ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
        assert.equal(tamperedScoring.status, 2);
        assert.match(tamperedScoring.stderr, /resumable artifact content changed/);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('one-case batches resume an exact prefix and reject artifact tampering', { timeout: 120_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-pipeline-batch-test-'));
    try {
        const output = join(scratch, 'output');
        const first = JSON.parse(execFileSync(process.execPath, [
            RUNNER, 'dry-run-batch', '--output', output,
        ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }));
        assert.equal(first.completed_cases, 1);
        assert.equal(first.remaining_cases, 3);
        assert.equal(first.attempts, 2);

        const escape = join(scratch, 'escape-target');
        mkdirSync(escape);
        symlinkSync(escape, join(output, 'private', 'escape'));
        const symlinked = spawnSync(process.execPath, [RUNNER, 'dry-run-batch', '--output', output], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        });
        assert.equal(symlinked.status, 2);
        assert.match(symlinked.stderr, /private artifact tree contains a special file/);
        rmSync(join(output, 'private', 'escape'), { force: true });

        const result = readFileSync(join(output, 'private', 'results.jsonl'), 'utf8')
            .trim().split('\n').map(JSON.parse).at(-1);
        const [artifact] = Object.keys(result.artifacts);
        writeFileSync(join(output, artifact), 'tampered\n');
        chmodSync(join(output, artifact), 0o600);
        const resumed = spawnSync(process.execPath, [RUNNER, 'dry-run-batch', '--output', output], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        });
        assert.equal(resumed.status, 2);
        assert.match(resumed.stderr, /resumable artifact content changed/);
        assert.equal(lstatSync(join(output, '.batch.lock'), { throwIfNoEntry: false }), undefined);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
