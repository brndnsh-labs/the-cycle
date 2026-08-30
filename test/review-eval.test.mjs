import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertNoCredentialMaterial,
    buildSchedule,
    createReviewerHome,
    guidanceEvidence,
    loadProtocol,
    probeReviewerConfig,
    reviewerConfig,
    reviewerEnvironment,
    runStrictConfigProbe,
    sha256,
} from '../eval/review/run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ROOT, 'eval', 'review', 'run.mjs');
const PROTOCOL_PATH = join(ROOT, 'eval', 'review', 'protocol.json');

function json(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function permissionBits(path) {
    return statSync(path).mode & 0o777;
}

function reviewerProbeTempEntries() {
    return readdirSync(tmpdir()).filter((entry) => [
        'cycle-review-config-probe-',
        'cycle-review-codex-home-',
    ].some((prefix) => entry.startsWith(prefix))).sort();
}

function assertPrivateTree(path) {
    assert.equal(permissionBits(path), 0o700, `${path} must be mode 0700`);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) assertPrivateTree(child);
        else assert.equal(permissionBits(child), 0o600, `${child} must be mode 0600`);
    }
}

test('review protocol freezes the balanced study and local artifact hashes', () => {
    const { protocol } = loadProtocol(PROTOCOL_PATH);
    const schedule = buildSchedule(protocol);
    assert.equal(schedule.length, 18);
    assert.equal(schedule.flatMap((pair) => pair.cells).length, 36);
    assert.equal(schedule.filter((pair) => pair.arms[0] === 'baseline').length, 9);
    assert.equal(schedule.filter((pair) => pair.arms[0] === 'treatment').length, 9);
    assert.equal(new Set(schedule.flatMap((pair) => pair.cells.map((cell) => cell.cell_id))).size, 36);
    assert.equal(protocol.execution.timeout_ms, 900_000);
    assert.equal(protocol.execution.fixture_commit_time, '2026-08-29T12:00:00Z');
    assert.equal(protocol.execution.subagents, false);
    assert.equal(protocol.execution.command_network, false);
    assert.equal(protocol.schedule.pairs_per_batch, 1);
    assert.equal(protocol.schedule.batch_unit, 'matched_pair');
    assert.equal(protocol.scoring.composite_score, false);
    assert.equal(protocol.scoring.scorers, 2);
    assert.equal(protocol.revision.number, 3);
    assert.deepEqual(protocol.revision.preserved_invalid_attempts.map((attempt) =>
        attempt.scored_model_calls), [0, 4]);
    assert.deepEqual(protocol.revision.unchanged, [
        'claim', 'cases', 'model', 'scoring',
        'schedule seed, repetitions, ordering, and batch size',
    ]);

    const reviewRoot = join(ROOT, 'eval', 'review');
    assert.equal(sha256(readFileSync(RUNNER)), protocol.artifact_lock.runner_sha256);
    assert.equal(
        sha256(readFileSync(join(reviewRoot, 'fake-codex.cjs'))),
        protocol.artifact_lock.fake_reviewer_sha256,
    );
    assert.equal(
        sha256(readFileSync(join(reviewRoot, protocol.census_path))),
        protocol.artifact_lock.census_sha256,
    );
    assert.equal(
        sha256(readFileSync(join(reviewRoot, protocol.prompt.common_path))),
        protocol.artifact_lock.common_prompt_sha256,
    );
    assert.equal(
        sha256(readFileSync(join(reviewRoot, protocol.prompt.output_schema_path))),
        protocol.artifact_lock.output_schema_sha256,
    );
    assert.equal(
        sha256(readFileSync(join(reviewRoot, protocol.scoring.schema_path))),
        protocol.artifact_lock.score_schema_sha256,
    );
    for (const item of protocol.cases.filter((entry) => !entry.variant)) {
        assert.equal(
            sha256(readFileSync(join(reviewRoot, item.original_task_path))),
            protocol.artifact_lock.cases[item.id].original_task_sha256,
        );
    }
});

test('reviewer profile exposes only explicit read roots and drops ambient credentials', () => {
    const config = reviewerConfig('/usr/bin:/bin', ['/fixture', '/runtime/codex']);
    assert.match(config, /":root" = "deny"/);
    assert.match(config, /":minimal" = "read"/);
    assert.match(config, /"\/fixture" = "read"/);
    assert.match(config, /"\/runtime\/codex" = "read"/);
    assert.match(config, /\[permissions\.review-fixture\.network\]\nenabled = false/);
    assert.match(config, /\[shell_environment_policy\]\ninherit = "none"/);
    assert.match(config, /multi_agent = false/);
    const featureSection = config.match(/\[features\]\n([\s\S]*?)(?:\n\[|$)/)?.[1] ?? '';
    assert.match(featureSection, /^view_image = false$/m);
    assert.doesNotMatch(config, /\[tools\]/);
    assert.doesNotMatch(config, /workspace_roots/);

    const env = reviewerEnvironment({
        reviewerHome: '/private/reviewer-home',
        scratch: '/private/reviewer-tmp',
        cellId: 'cell',
        arm: 'treatment',
        caseId: 'case',
        repetition: 2,
        pairIndex: 3,
        attempt: 1,
    }, {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        HOME: '/home/private',
        GH_TOKEN: 'github-secret',
        OPENAI_API_KEY: 'openai-secret',
        CODEX_API_KEY: 'codex-secret',
        NPM_TOKEN: 'npm-secret',
    });
    assert.equal(env.HOME, '/private/reviewer-home');
    assert.equal(env.CODEX_HOME, '/private/reviewer-home');
    assert.equal(env.TMPDIR, '/private/reviewer-tmp');
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.CYCLE_REVIEW_ATTEMPT, '1');
});

test('strict reviewer-config preflight is credential-free and rejects the obsolete field', () => {
    const fakeCodex = join(ROOT, 'eval', 'review', 'fake-codex.cjs');
    const tempEntriesBefore = reviewerProbeTempEntries();
    assert.deepEqual(probeReviewerConfig(fakeCodex), {
        strict_config: 'pass',
        credentials: 'absent',
        model_calls: 0,
    });
    assert.deepEqual(reviewerProbeTempEntries(), tempEntriesBefore);

    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-config-probe-test-'));
    try {
        const reviewerHome = join(scratch, 'home');
        const workspace = join(scratch, 'workspace');
        const reviewerScratch = join(scratch, 'tmp');
        mkdirSync(reviewerHome);
        mkdirSync(workspace);
        mkdirSync(reviewerScratch);
        writeFileSync(join(reviewerHome, 'config.toml'), '[tools]\nview_image = false\n');
        assert.throws(
            () => runStrictConfigProbe({
                codexBin: fakeCodex,
                reviewerHome,
                workspace,
                scratch: reviewerScratch,
            }),
            /strict reviewer-config probe failed/,
        );
        assert.throws(
            () => runStrictConfigProbe({
                codexBin: '/bin/true',
                reviewerHome,
                workspace,
                scratch: reviewerScratch,
            }),
            /strict reviewer-config probe failed \(0\)/,
        );
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('outer Codex authentication is symlinked outside the fixture and never copied', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-auth-test-'));
    let reviewerHome;
    try {
        const codexHome = join(scratch, 'codex-home');
        const workspace = join(scratch, 'workspace');
        mkdirSync(codexHome);
        mkdirSync(workspace);
        const auth = join(codexHome, 'auth.json');
        const sentinel = 'credential-material-must-stay-outside-the-fixture';
        writeFileSync(auth, `${sentinel}\n`, { mode: 0o600 });
        reviewerHome = createReviewerHome({
            codexHome,
            includeAuth: true,
            codexBin: join(ROOT, 'eval', 'review', 'fake-codex.cjs'),
            workspace,
        });
        const authLink = join(reviewerHome, 'auth.json');
        assert.ok(lstatSync(authLink).isSymbolicLink());
        assert.equal(readlinkSync(authLink), auth);
        assert.doesNotMatch(readFileSync(join(reviewerHome, 'config.toml'), 'utf8'), new RegExp(sentinel));
        assert.doesNotMatch(readFileSync(join(reviewerHome, 'config.toml'), 'utf8'), /auth\.json/);
        assert.equal(readFileSync(auth, 'utf8'), `${sentinel}\n`);
    } finally {
        if (reviewerHome) rmSync(reviewerHome, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('captured output fails closed on authentication material without reporting the secret', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-auth-output-test-'));
    try {
        const auth = join(scratch, 'auth.json');
        const secret = 'credential-material-with-enough-entropy-123456789';
        writeFileSync(auth, `${JSON.stringify({ tokens: { access_token: secret } })}\n`, { mode: 0o600 });
        assert.doesNotThrow(() => assertNoCredentialMaterial(['ordinary reviewer output'], auth));
        assert.throws(
            () => assertNoCredentialMaterial([`accidental echo: ${secret}`], auth),
            (error) => {
                assert.match(error.message, /contained authentication material/);
                assert.doesNotMatch(error.message, new RegExp(secret));
                return true;
            },
        );
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('fake reviewer exercises paired retry, guidance evidence, normalization, and artifacts', {
    timeout: 120_000,
}, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-dry-test-'));
    try {
        const output = join(scratch, 'output');
        execFileSync(process.execPath, [RUNNER, 'dry-run', '--output', output], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        });

        assert.deepEqual(json(join(output, 'summary.json')), {
            complete: true,
            completed_pairs: 18,
            total_pairs: 18,
            remaining_pairs: 0,
            valid_cells: 36,
            attempts: 38,
            invalid_attempts: 1,
        });
        const results = readFileSync(join(output, 'private', 'results.jsonl'), 'utf8')
            .trim().split('\n').map(JSON.parse);
        assert.equal(results.length, 38);
        const invalid = results.filter((result) => !result.valid);
        assert.equal(invalid.length, 1);
        assert.deepEqual(invalid[0].invalid_reasons, ['final response is not JSON']);
        const retriedPair = results.filter((result) => result.attempt === 2);
        assert.equal(retriedPair.length, 2);
        assert.equal(new Set(retriedPair.map((result) => result.case_id)).size, 1);
        assert.equal(new Set(retriedPair.map((result) => result.repetition)).size, 1);
        assert.deepEqual(new Set(retriedPair.map((result) => result.arm)), new Set(['baseline', 'treatment']));
        assert.ok(retriedPair.every((result) => result.valid));

        const valid = results.filter((result) => result.valid);
        assert.ok(valid.filter((result) => result.arm === 'treatment')
            .every((result) => result.treatment_guidance_read
                && result.guidance_files_read === 2
                && result.guidance_files_exposed === 2));
        assert.ok(valid.filter((result) => result.arm === 'baseline')
            .every((result) => !result.treatment_guidance_read
                && result.guidance_files_read === 0
                && result.guidance_files_exposed === 0
                && !result.baseline_guidance_exposed));
        assert.ok(results.every((result) => result.model_turn_started && result.model_turn_completed));
        const fixtureCommits = new Map();
        for (const result of results) {
            const key = `${result.case_id}:${result.arm}`;
            const commits = fixtureCommits.get(key) ?? new Set();
            commits.add(result.fixture.commit);
            fixtureCommits.set(key, commits);
        }
        assert.ok([...fixtureCommits.values()].every((commits) => commits.size === 1));
        for (const result of results) {
            for (const path of Object.values(result.artifacts).filter(Boolean)) {
                assert.equal(isAbsolute(path), false);
                assert.ok(readFileSync(join(output, path)).length >= 0);
            }
        }

        const scoringText = readFileSync(join(output, 'scoring', 'scoring-input.json'), 'utf8');
        assert.doesNotMatch(scoringText, /"(?:arm|case_id|cell_id)"/);
        assert.doesNotMatch(scoringText, /"(?:baseline|treatment)"/);
        assert.doesNotMatch(scoringText, /command_execution|tool trace/iu);
        const scoring = JSON.parse(scoringText);
        assert.equal(scoring.fixtures.length, 6);
        assert.equal(scoring.packets.length, 18);
        assert.equal(scoring.packets.flatMap((packet) => packet.reviews).length, 36);
        assert.ok(scoring.packets.every((packet) =>
            packet.reviews.map((review) => review.output_label).sort().join('') === 'AB'));

        const mapping = json(join(output, 'private', 'blinding-map.json'));
        assert.equal(mapping.length, 36);
        assert.equal(mapping.filter((entry) => entry.attempt === 2).length, 2);
        const measures = readFileSync(join(output, 'private', 'measures.jsonl'), 'utf8')
            .trim().split('\n').map(JSON.parse);
        assert.equal(measures.length, 36);
        const manifest = json(join(output, 'scoring', 'manifest.json'));
        assert.equal(manifest.packet_count, 18);
        assert.equal(manifest.normalized_review_count, 36);
        assert.equal(manifest.scoring_input_sha256, sha256(Buffer.from(scoringText)));
        assert.equal(
            manifest.score_schema_sha256,
            sha256(readFileSync(join(output, 'scoring', 'score.schema.json'))),
        );
        assertPrivateTree(output);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('a retry cannot combine valid cells from different attempts', { timeout: 120_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-split-retry-test-'));
    try {
        const output = join(scratch, 'output');
        assert.throws(() => execFileSync(process.execPath, [RUNNER, 'dry-run', '--output', output], {
            cwd: ROOT,
            env: { ...process.env, CYCLE_REVIEW_FAKE_MODE: 'split-retry' },
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        assert.deepEqual(json(join(output, 'summary.json')), {
            complete: false,
            completed_pairs: 0,
            total_pairs: 18,
            remaining_pairs: 18,
            valid_cells: 0,
            attempts: 4,
            invalid_attempts: 2,
        });
        assert.equal(statSync(join(output, 'scoring'), { throwIfNoEntry: false }), undefined);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('fake reviewer resumes one complete matched pair per quota-monitored batch', {
    timeout: 120_000,
}, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-batch-test-'));
    try {
        const output = join(scratch, 'output');
        for (let batch = 1; batch <= 18; batch += 1) {
            const receipt = JSON.parse(execFileSync(process.execPath, [
                RUNNER,
                'dry-run-batch',
                '--output',
                output,
            ], {
                cwd: ROOT,
                encoding: 'utf8',
                stdio: 'pipe',
            }));
            assert.equal(receipt.pair_index, batch);
            assert.equal(receipt.calls, batch === 1 ? 4 : 2);
            assert.equal(receipt.invalid_attempts, batch === 1 ? 1 : 0);
            assert.equal(receipt.reviewer_processes, receipt.calls);
            assert.equal(receipt.model_turns_started, receipt.calls);
            assert.equal(receipt.model_turns_completed, receipt.calls);
            assert.equal(receipt.invalid_cells, receipt.invalid_attempts);
            assert.equal(receipt.token_usage.input_tokens, receipt.calls * 100);
            assert.equal(receipt.token_usage.cached_input_tokens, receipt.calls * 25);
            assert.equal(receipt.token_usage.output_tokens, receipt.calls * 20);
            assert.equal(receipt.token_usage.reasoning_output_tokens, receipt.calls * 5);
            assert.equal(receipt.completed_pairs, batch);
            assert.equal(receipt.remaining_pairs, 18 - batch);
            assert.equal(receipt.complete, batch === 18);
            if (batch < 18) assert.equal(statSync(join(output, 'scoring'), { throwIfNoEntry: false }), undefined);
        }
        assert.deepEqual(json(join(output, 'summary.json')), {
            complete: true,
            completed_pairs: 18,
            total_pairs: 18,
            remaining_pairs: 0,
            valid_cells: 36,
            attempts: 38,
            invalid_attempts: 1,
        });
        assert.equal(json(join(output, 'scoring', 'manifest.json')).normalized_review_count, 36);
        assertPrivateTree(output);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('batched resume rejects changed checkpoint state before another reviewer call', {
    timeout: 120_000,
}, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-batch-tamper-test-'));
    try {
        const output = join(scratch, 'output');
        execFileSync(process.execPath, [RUNNER, 'dry-run-batch', '--output', output], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        });
        const runsPath = join(output, 'private', 'runs');
        const runCount = readdirSync(runsPath).length;
        const activePairPath = join(output, 'private', 'active-pair.json');
        writeFileSync(activePairPath, '{}\n', { mode: 0o600 });
        assert.throws(() => execFileSync(process.execPath, [
            RUNNER,
            'dry-run-batch',
            '--output',
            output,
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        assert.equal(readdirSync(runsPath).length, runCount);
        rmSync(activePairPath);

        const resultsPath = join(output, 'private', 'results.jsonl');
        const results = readFileSync(resultsPath, 'utf8').trim().split('\n').map(JSON.parse);
        results[0].pair_index = 99;
        writeFileSync(resultsPath, `${results.map((result) => JSON.stringify(result)).join('\n')}\n`);

        assert.throws(() => execFileSync(process.execPath, [
            RUNNER,
            'dry-run-batch',
            '--output',
            output,
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        assert.equal(readdirSync(runsPath).length, runCount);

        results[0].pair_index = 1;
        writeFileSync(resultsPath, `${results.map((result) => JSON.stringify(result)).join('\n')}\n`);
        const candidatePath = join(output, results[0].artifacts.candidate_diff);
        writeFileSync(candidatePath, `${readFileSync(candidatePath, 'utf8')}changed after checkpoint\n`);
        assert.throws(() => execFileSync(process.execPath, [
            RUNNER,
            'dry-run-batch',
            '--output',
            output,
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        assert.equal(readdirSync(runsPath).length, runCount);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('batched output rejects symlinked state before writing through it', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-batch-symlink-test-'));
    try {
        const output = join(scratch, 'output');
        const target = join(scratch, 'target');
        mkdirSync(output, { mode: 0o700 });
        mkdirSync(target, { mode: 0o700 });
        symlinkSync(target, join(output, 'private'));
        assert.throws(() => execFileSync(process.execPath, [
            RUNNER,
            'dry-run-batch',
            '--output',
            output,
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        assert.deepEqual(readdirSync(target), []);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('an early zero-call batch failure can retry from the same output', { timeout: 120_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-batch-early-failure-test-'));
    try {
        const output = join(scratch, 'output');
        assert.throws(() => execFileSync(process.execPath, [
            RUNNER,
            'dry-run-batch',
            '--output',
            output,
            '--codex-bin',
            join(scratch, 'missing-codex'),
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        assert.deepEqual(readdirSync(join(output, 'private')), []);
        const receipt = JSON.parse(execFileSync(process.execPath, [
            RUNNER,
            'dry-run-batch',
            '--output',
            output,
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        assert.equal(receipt.pair_index, 1);
        assert.equal(receipt.calls, 4);
        assert.equal(receipt.reviewer_processes, 4);
        assert.equal(receipt.model_turns_started, 4);
        assert.equal(receipt.model_turns_completed, 4);
        assert.equal(receipt.completed_pairs, 1);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('a terminally invalid batch still reports consumed calls and tokens', { timeout: 120_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-batch-invalid-receipt-test-'));
    try {
        const output = join(scratch, 'output');
        let failure;
        try {
            execFileSync(process.execPath, [RUNNER, 'dry-run-batch', '--output', output], {
                cwd: ROOT,
                env: { ...process.env, CYCLE_REVIEW_FAKE_MODE: 'split-retry' },
                encoding: 'utf8',
                stdio: 'pipe',
            });
        } catch (error) {
            failure = error;
        }
        assert.ok(failure);
        const receipt = JSON.parse(failure.stdout);
        assert.equal(receipt.pair_index, 1);
        assert.equal(receipt.calls, 4);
        assert.equal(receipt.invalid_attempts, 2);
        assert.equal(receipt.reviewer_processes, 4);
        assert.equal(receipt.model_turns_started, 4);
        assert.equal(receipt.model_turns_completed, 4);
        assert.equal(receipt.invalid_cells, 2);
        assert.equal(receipt.token_usage.input_tokens, 400);
        assert.equal(receipt.completed_pairs, 0);
        assert.equal(receipt.remaining_pairs, 18);
        assert.equal(receipt.complete, false);
        assert.equal(statSync(join(output, 'scoring'), { throwIfNoEntry: false }), undefined);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('batched execution can restart from preflight-only state before the first checkpoint', {
    timeout: 120_000,
}, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-batch-fresh-restart-test-'));
    try {
        const output = join(scratch, 'output');
        mkdirSync(join(output, 'private'), { recursive: true, mode: 0o700 });
        writeFileSync(join(output, 'preflight.json'), '{}\n', { mode: 0o600 });
        const receipt = JSON.parse(execFileSync(process.execPath, [
            RUNNER,
            'dry-run-batch',
            '--output',
            output,
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        assert.equal(receipt.pair_index, 1);
        assert.equal(receipt.calls, 4);
        assert.equal(json(join(output, 'summary.json')).completed_pairs, 1);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('mentioning guidance paths without returning their contents is invalid', { timeout: 120_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-guidance-proof-test-'));
    try {
        const output = join(scratch, 'output');
        assert.throws(() => execFileSync(process.execPath, [RUNNER, 'dry-run', '--output', output], {
            cwd: ROOT,
            env: { ...process.env, CYCLE_REVIEW_FAKE_MODE: 'guidance-mention-only' },
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        const results = readFileSync(join(output, 'private', 'results.jsonl'), 'utf8')
            .trim().split('\n').map(JSON.parse);
        const invalidTreatment = results.filter((result) => result.arm === 'treatment');
        assert.equal(invalidTreatment.length, 2);
        assert.ok(invalidTreatment.every((result) => result.invalid_reasons.includes(
            'treatment did not read pinned review guidance',
        )));
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('guidance exposure requires frozen content, not an absent-file compound command', () => {
    const guidance = [
        { path: '.agents/skills/review/SKILL.md', content: 'first distinctive frozen guidance marker for review evidence\n' },
        { path: '.agents/skills/DOCTRINE.md', content: 'second distinctive frozen doctrine marker for review evidence\n' },
    ];
    const absentCheck = [{
        type: 'item.completed',
        item: {
            type: 'command_execution',
            status: 'completed',
            exit_code: 0,
            command: "pwd && if [ -f .agents/skills/review/SKILL.md ]; then sed -n '1,240p' .agents/skills/review/SKILL.md; fi && if [ -f .agents/skills/DOCTRINE.md ]; then sed -n '1,260p' .agents/skills/DOCTRINE.md; fi",
            aggregated_output: '/isolated/workspace\n',
        },
    }];
    assert.deepEqual(guidanceEvidence(absentCheck, guidance, '/isolated/workspace'), {
        read: false,
        exposed: false,
        readPaths: [],
        exposedPaths: [],
    });

    for (const exposed of guidance) {
        const evidence = guidanceEvidence([{
            type: 'item.completed',
            item: {
                type: 'command_execution',
                status: 'completed',
                exit_code: 0,
                command: 'unexpected output',
                aggregated_output: exposed.content,
            },
        }], guidance, '/isolated/workspace');
        assert.equal(evidence.exposed, true);
        assert.deepEqual(evidence.exposedPaths, [exposed.path]);
    }
});

test('treatment must return content from both frozen guidance files', { timeout: 120_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-one-guide-test-'));
    try {
        const output = join(scratch, 'output');
        assert.throws(() => execFileSync(process.execPath, [RUNNER, 'dry-run-batch', '--output', output], {
            cwd: ROOT,
            env: { ...process.env, CYCLE_REVIEW_FAKE_MODE: 'guidance-one-file' },
            encoding: 'utf8',
            stdio: 'pipe',
        }));
        const results = readFileSync(join(output, 'private', 'results.jsonl'), 'utf8')
            .trim().split('\n').map(JSON.parse);
        const treatment = results.filter((result) => result.arm === 'treatment');
        assert.equal(treatment.length, 2);
        assert.ok(treatment.every((result) => !result.valid
            && !result.treatment_guidance_read
            && result.guidance_files_read === 1));
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('proven baseline guidance exposure stops before the paired retry', { timeout: 120_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-baseline-exposure-test-'));
    try {
        const output = join(scratch, 'output');
        let failure;
        try {
            execFileSync(process.execPath, [RUNNER, 'dry-run-batch', '--output', output], {
                cwd: ROOT,
                env: { ...process.env, CYCLE_REVIEW_FAKE_MODE: 'baseline-guidance-exposure' },
                encoding: 'utf8',
                stdio: 'pipe',
            });
        } catch (error) {
            failure = error;
        }
        assert.ok(failure);
        const receipt = JSON.parse(failure.stdout);
        assert.deepEqual({
            reviewer_processes: receipt.reviewer_processes,
            model_turns_started: receipt.model_turns_started,
            model_turns_completed: receipt.model_turns_completed,
            invalid_cells: receipt.invalid_cells,
        }, {
            reviewer_processes: 2,
            model_turns_started: 2,
            model_turns_completed: 2,
            invalid_cells: 1,
        });
        const results = readFileSync(join(output, 'private', 'results.jsonl'), 'utf8')
            .trim().split('\n').map(JSON.parse);
        assert.equal(results.length, 2);
        assert.ok(results.every((result) => result.attempt === 1));
        const baseline = results.find((result) => result.arm === 'baseline');
        assert.equal(baseline.baseline_guidance_exposed, true);
        assert.deepEqual(baseline.invalid_reasons, [
            'baseline received treatment review guidance content',
        ]);
        assert.equal(json(join(output, 'summary.json')).completed_pairs, 0);
        assert.equal(statSync(join(output, 'scoring'), { throwIfNoEntry: false }), undefined);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('receipts distinguish reviewer processes from started and completed model turns', {
    timeout: 120_000,
}, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cycle-review-turn-count-test-'));
    try {
        const output = join(scratch, 'output');
        let failure;
        try {
            execFileSync(process.execPath, [RUNNER, 'dry-run-batch', '--output', output], {
                cwd: ROOT,
                env: { ...process.env, CYCLE_REVIEW_FAKE_MODE: 'turn-start-only' },
                encoding: 'utf8',
                stdio: 'pipe',
            });
        } catch (error) {
            failure = error;
        }
        assert.ok(failure);
        const receipt = JSON.parse(failure.stdout);
        assert.deepEqual({
            reviewer_processes: receipt.reviewer_processes,
            model_turns_started: receipt.model_turns_started,
            model_turns_completed: receipt.model_turns_completed,
            invalid_cells: receipt.invalid_cells,
        }, {
            reviewer_processes: 4,
            model_turns_started: 4,
            model_turns_completed: 0,
            invalid_cells: 4,
        });
        assert.deepEqual(receipt.token_usage, {});
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
