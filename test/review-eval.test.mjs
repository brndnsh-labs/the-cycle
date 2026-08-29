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
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertNoCredentialMaterial,
    buildSchedule,
    createReviewerHome,
    loadProtocol,
    reviewerConfig,
    reviewerEnvironment,
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
    assert.equal(protocol.scoring.composite_score, false);
    assert.equal(protocol.scoring.scorers, 2);

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
            .every((result) => result.treatment_guidance_read));
        assert.ok(valid.filter((result) => result.arm === 'baseline')
            .every((result) => !result.treatment_guidance_read));
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
            valid_cells: 0,
            attempts: 4,
            invalid_attempts: 2,
        });
        assert.equal(statSync(join(output, 'scoring'), { throwIfNoEntry: false }), undefined);
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
