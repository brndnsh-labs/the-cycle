#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DEFAULT_PROTOCOL = join(HERE, 'protocol.json');
const DEFAULT_FAKE_CODEX = join(HERE, 'fake-codex.cjs');
const MAX_BUFFER = 128 * 1024 * 1024;
const TREE_CACHE = new Map();
const PATCH_CACHE = new Map();

export class ReviewEvalError extends Error {}

function fail(message) {
    throw new ReviewEvalError(message);
}

function run(command, args, {
    cwd = ROOT,
    env = process.env,
    input,
    encoding = 'utf8',
    timeout,
    allowFailure = false,
} = {}) {
    const started = Date.now();
    const result = spawnSync(command, args, {
        cwd,
        env,
        input,
        encoding,
        timeout,
        maxBuffer: MAX_BUFFER,
    });
    const elapsedMs = Date.now() - started;
    if (result.error && !allowFailure) {
        fail(`${command} failed to start: ${result.error.message}`);
    }
    if (result.status !== 0 && !allowFailure) {
        const stderr = encoding === null ? result.stderr?.toString('utf8') : result.stderr;
        const stdout = encoding === null ? result.stdout?.toString('utf8') : result.stdout;
        fail(`${command} ${args.join(' ')} failed (${result.status})\n${stderr || stdout || ''}`.trimEnd());
    }
    return { ...result, elapsedMs };
}

function git(source, args, options = {}) {
    return run('git', ['-C', source, ...args], options);
}

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function stableJson(value) {
    return JSON.stringify(stable(value));
}

function ensureInside(root, path) {
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
        fail(`unsafe path outside ${root}: ${path}`);
    }
}

function resolveProtocolAsset(protocolPath, rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) fail(`invalid protocol asset path: ${rel}`);
    const root = dirname(protocolPath);
    const path = resolve(root, rel);
    ensureInside(root, path);
    if (!existsSync(path) || !lstatSync(path).isFile()) fail(`missing protocol asset: ${rel}`);
    return path;
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

export function validateProtocol(protocol, { requireLock = true } = {}) {
    if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) {
        fail('review protocol must be an object');
    }
    if (protocol.version !== 1 || !isNonEmptyString(protocol.study_id) || !isNonEmptyString(protocol.claim)
        || !isNonEmptyString(protocol.census_path)) {
        fail('review protocol requires version 1, study_id, claim, and census_path');
    }
    const revision = protocol.revision;
    if (!revision || revision.number !== 2
        || revision.prior_protocol_sha256 !== 'fda4e27bd8186dad607e4c5f78a498f4e4096beed84447b866a3c82827a8b87a'
        || revision.prior_runner_sha256 !== '46adf70d6dcce35dbefa51b8487cf55d10ff7525a8f4327e3e728c1f58c0a61d'
        || !isNonEmptyString(revision.reason)
        || revision.preserved_invalid_attempt?.issue !== 128
        || revision.preserved_invalid_attempt?.results_sha256
            !== '88139d34b4852acad61270bc05391640014bd1e9468366be116a190d9bfd4412'
        || revision.preserved_invalid_attempt?.summary_sha256
            !== 'b34ad05184e808e247613fa17683054096706954262cfd076c573d32fd8f9565'
        || revision.preserved_invalid_attempt?.scored_model_calls !== 0
        || stableJson(revision.unchanged) !== stableJson([
            'claim', 'cases', 'schedule', 'model', 'scoring', 'invalidation',
        ])) {
        fail('review protocol is missing the frozen revision 2 compatibility record');
    }
    if (!protocol.source || !isNonEmptyString(protocol.source.repository)
        || !/^[0-9a-f]{40}$/.test(protocol.source.review_guidance_commit)
        || !Array.isArray(protocol.source.review_guidance_paths)
        || !Array.isArray(protocol.source.excluded_fixture_paths)) {
        fail('review protocol has an invalid source definition');
    }
    if (!protocol.prompt || !isNonEmptyString(protocol.prompt.common_path)
        || !isNonEmptyString(protocol.prompt.output_schema_path)) {
        fail('review protocol has an invalid prompt definition');
    }
    if (!Array.isArray(protocol.arms) || stableJson(protocol.arms.map((arm) => arm.id).sort())
        !== stableJson(['baseline', 'treatment'])) {
        fail('review protocol must define baseline and treatment arms');
    }
    if (!protocol.schedule || protocol.schedule.repetitions !== 3
        || protocol.schedule.invalid_pair_retry_limit !== 1
        || protocol.schedule.pairs_per_batch !== 1
        || protocol.schedule.batch_unit !== 'matched_pair'
        || !isNonEmptyString(protocol.schedule.resume_rule)
        || !isNonEmptyString(protocol.schedule.seed)) {
        fail('review protocol must freeze three repetitions, one matched pair per batch, and a seed');
    }
    if (!protocol.execution || !isNonEmptyString(protocol.execution.model)
        || !isNonEmptyString(protocol.execution.reasoning_effort)
        || !Number.isSafeInteger(protocol.execution.timeout_ms) || protocol.execution.timeout_ms < 1
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(protocol.execution.fixture_commit_time ?? '')
        || protocol.execution.reviewers_per_arm !== 1
        || protocol.execution.fresh_session_per_cell !== true
        || protocol.execution.subagents !== false
        || protocol.execution.command_network !== false
        || protocol.execution.reviewer_workspace !== 'read-only') {
        fail('review protocol has an invalid execution definition');
    }
    if (!protocol.scoring || !isNonEmptyString(protocol.scoring.schema_path)
        || protocol.scoring.scorers !== 2 || protocol.scoring.composite_score !== false
        || !protocol.scoring.recall || !isNonEmptyString(protocol.scoring.recall.caught)
        || !isNonEmptyString(protocol.scoring.recall.partial)
        || !isNonEmptyString(protocol.scoring.recall.missed)
        || !isNonEmptyString(protocol.scoring.actionability)
        || !isNonEmptyString(protocol.scoring.unsupported_findings)
        || !isNonEmptyString(protocol.scoring.controls)
        || !isNonEmptyString(protocol.scoring.adjudication)
        || !isNonEmptyString(protocol.scoring.analysis)) {
        fail('review protocol has an invalid scoring definition');
    }
    if (!Array.isArray(protocol.cases) || protocol.cases.length !== 6) {
        fail('review protocol must define four flawed cases and two controls');
    }
    const ids = new Set();
    let controls = 0;
    for (const item of protocol.cases) {
        if (!isNonEmptyString(item.id) || ids.has(item.id)) fail(`invalid or duplicate case id: ${item.id}`);
        ids.add(item.id);
        if (item.variant === 'target-clean') {
            controls += 1;
            if (!isNonEmptyString(item.variant_of)) fail(`control ${item.id} is missing variant_of`);
            continue;
        }
        for (const key of ['base', 'candidate', 'repair']) {
            if (!/^[0-9a-f]{40}$/.test(item[key] ?? '')) fail(`case ${item.id} has invalid ${key}`);
        }
        if (!Number.isSafeInteger(item.original_issue) || !isNonEmptyString(item.original_task_path)
            || !isNonEmptyString(item.task_path)
            || !Array.isArray(item.repair_paths) || !item.repair_paths.length
            || !Array.isArray(item.oracle_paths) || !item.oracle_paths.length
            || !Array.isArray(item.oracle_commands) || !item.oracle_commands.length
            || !Array.isArray(item.targets) || !item.targets.length) {
            fail(`case ${item.id} is incomplete`);
        }
    }
    if (controls !== 2) fail('review protocol must define exactly two target-clean controls');
    for (const item of protocol.cases.filter((entry) => entry.variant === 'target-clean')) {
        const source = protocol.cases.find((entry) => entry.id === item.variant_of);
        if (!source || source.variant) fail(`control ${item.id} references an invalid source case`);
    }
    if (!protocol.artifact_lock || typeof protocol.artifact_lock !== 'object') {
        fail('review protocol is missing artifact_lock');
    }
    if (requireLock && stableJson(protocol.artifact_lock).includes('PENDING')) {
        fail('review protocol artifact lock is not frozen');
    }
    return protocol;
}

export function loadProtocol(path = DEFAULT_PROTOCOL, options) {
    const protocolPath = resolve(path);
    let protocol;
    try {
        protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
    } catch (error) {
        fail(`cannot read protocol ${protocolPath}: ${error.message}`);
    }
    validateProtocol(protocol, options);
    return { protocol, protocolPath };
}

function sourceCase(protocol, item) {
    if (!item.variant) return { ...item, targetClean: false, publicCase: item };
    const original = protocol.cases.find((entry) => entry.id === item.variant_of);
    return {
        ...original,
        id: item.id,
        title: item.title,
        targetClean: true,
        publicCase: item,
        sourceId: original.id,
    };
}

function isExcluded(path, excluded) {
    return excluded.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function treeEntries(source, revision, excluded) {
    const cacheKey = stableJson([resolve(source), revision, excluded]);
    if (TREE_CACHE.has(cacheKey)) return TREE_CACHE.get(cacheKey);
    const listing = git(source, ['ls-tree', '-r', '-z', '--full-tree', revision], { encoding: 'utf8' }).stdout;
    const entries = [];
    for (const record of listing.split('\0').filter(Boolean)) {
        const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(record);
        if (!match) fail(`cannot parse git tree record at ${revision}`);
        const [, mode, type, object, path] = match;
        if (isExcluded(path, excluded)) continue;
        if (type !== 'blob' || mode === '120000') {
            fail(`unsupported ${type} or symlink in source tree: ${path}`);
        }
        const content = git(source, ['show', `${revision}:${path}`], { encoding: null }).stdout;
        entries.push({ mode, object, path, content });
    }
    TREE_CACHE.set(cacheKey, entries);
    return entries;
}

function treeDigest(entries) {
    const hash = createHash('sha256');
    for (const entry of entries) {
        hash.update(entry.mode);
        hash.update('\0');
        hash.update(entry.path);
        hash.update('\0');
        hash.update(entry.content);
        hash.update('\0');
    }
    return hash.digest('hex');
}

function excludedPathspecs(excluded) {
    return excluded.flatMap((entry) => [
        `:(exclude)${entry}`,
        `:(exclude)${entry}/**`,
    ]);
}

function patchBetween(source, from, to, paths = null, excluded = []) {
    const cacheKey = stableJson([resolve(source), from, to, paths, excluded]);
    if (PATCH_CACHE.has(cacheKey)) return PATCH_CACHE.get(cacheKey);
    const pathspecs = paths?.length ? paths : ['.', ...excludedPathspecs(excluded)];
    const patch = git(source, [
        'diff', '--binary', '--full-index', '--no-ext-diff', '--no-renames', from, to, '--', ...pathspecs,
    ], { encoding: null }).stdout;
    if (!patch.length) fail(`empty patch from ${from} to ${to}`);
    PATCH_CACHE.set(cacheKey, patch);
    return patch;
}

function repairParent(source, revision) {
    const parents = git(source, ['show', '-s', '--format=%P', revision]).stdout.trim().split(/\s+/).filter(Boolean);
    if (parents.length !== 1) fail(`repair ${revision} must have exactly one parent`);
    return parents[0];
}

function hashNamedFiles(source, revision, paths) {
    const hash = createHash('sha256');
    for (const path of [...paths].sort()) {
        const content = git(source, ['show', `${revision}:${path}`], { encoding: null }).stdout;
        hash.update(path);
        hash.update('\0');
        hash.update(content);
        hash.update('\0');
    }
    return hash.digest('hex');
}

function verifySource(source, protocol) {
    const root = resolve(source);
    if (!existsSync(root) || !statSync(root).isDirectory()) fail(`source is not a directory: ${source}`);
    if (git(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).status !== 0) {
        fail(`source is not a Git repository: ${source}`);
    }
    const refs = new Set([
        protocol.source.review_guidance_commit,
        ...protocol.cases.filter((item) => !item.variant).flatMap((item) => [item.base, item.candidate, item.repair]),
    ]);
    for (const revision of refs) {
        const result = git(root, ['cat-file', '-e', `${revision}^{commit}`], { allowFailure: true });
        if (result.status !== 0) fail(`source is missing required commit ${revision}`);
    }
    return root;
}

export function computeArtifactLock(protocol, protocolPath, source) {
    const root = verifySource(source, protocol);
    const lock = {
        runner_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
        fake_reviewer_sha256: sha256(readFileSync(DEFAULT_FAKE_CODEX)),
        census_sha256: sha256(readFileSync(resolveProtocolAsset(protocolPath, protocol.census_path))),
        common_prompt_sha256: sha256(readFileSync(resolveProtocolAsset(protocolPath, protocol.prompt.common_path))),
        output_schema_sha256: sha256(readFileSync(resolveProtocolAsset(protocolPath, protocol.prompt.output_schema_path))),
        score_schema_sha256: sha256(readFileSync(resolveProtocolAsset(protocolPath, protocol.scoring.schema_path))),
        review_guidance_sha256: hashNamedFiles(
            root,
            protocol.source.review_guidance_commit,
            protocol.source.review_guidance_paths,
        ),
        cases: {},
    };
    for (const item of protocol.cases.filter((entry) => !entry.variant)) {
        const parent = repairParent(root, item.repair);
        const candidatePatch = patchBetween(
            root,
            item.base,
            item.candidate,
            null,
            protocol.source.excluded_fixture_paths,
        );
        const repairPatch = patchBetween(root, parent, item.repair, item.repair_paths);
        const oraclePatch = patchBetween(root, parent, item.repair, item.oracle_paths);
        lock.cases[item.id] = {
            original_task_sha256: sha256(readFileSync(resolveProtocolAsset(protocolPath, item.original_task_path))),
            task_sha256: sha256(readFileSync(resolveProtocolAsset(protocolPath, item.task_path))),
            base_tree_sha256: treeDigest(treeEntries(root, item.base, protocol.source.excluded_fixture_paths)),
            candidate_patch_sha256: sha256(candidatePatch),
            repair_patch_sha256: sha256(repairPatch),
            oracle_patch_sha256: sha256(oraclePatch),
            target_clean_patch_sha256: sha256(Buffer.concat([candidatePatch, repairPatch])),
        };
    }
    return lock;
}

export function assertArtifactLock(protocol, protocolPath, source) {
    const actual = computeArtifactLock(protocol, protocolPath, source);
    if (stableJson(actual) !== stableJson(protocol.artifact_lock)) {
        fail(`artifact lock mismatch\nexpected ${stableJson(protocol.artifact_lock)}\nactual   ${stableJson(actual)}`);
    }
    return actual;
}

function writeTree(destination, entries) {
    for (const entry of entries) {
        const path = resolve(destination, entry.path);
        ensureInside(destination, path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, entry.content);
        chmodSync(path, entry.mode === '100755' ? 0o755 : 0o644);
    }
}

const NEUTRAL_AGENTS = `# Review evaluation fixture

This repository is an isolated historical review fixture.

- Review the current uncommitted diff against the task under \`.review-eval/task.md\`.
- Do not modify files or use the network.
- Do not inspect paths outside this repository or attempt to recover later history.
- If \`.agents/skills/review/SKILL.md\` exists, read it before reviewing.
- Return findings using the requested structured output contract.
`;

function writeFixtureMetadata(destination, protocol, protocolPath, item) {
    writeFileSync(join(destination, 'AGENTS.md'), NEUTRAL_AGENTS);
    mkdirSync(join(destination, '.review-eval'), { recursive: true });
    writeFileSync(
        join(destination, '.review-eval', 'task.md'),
        readFileSync(resolveProtocolAsset(protocolPath, item.task_path)),
    );
    writeFileSync(
        join(destination, '.review-eval', 'findings.schema.json'),
        readFileSync(resolveProtocolAsset(protocolPath, protocol.prompt.output_schema_path)),
    );
}

function writeTreatmentGuidance(destination, protocol, source) {
    for (const rel of protocol.source.review_guidance_paths) {
        const path = resolve(destination, rel);
        ensureInside(destination, path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, git(source, [
            'show', `${protocol.source.review_guidance_commit}:${rel}`,
        ], { encoding: null }).stdout);
    }
}

function initializeFixtureRepository(destination, commitTime) {
    const template = privateDirectory('cycle-review-git-template-');
    const env = {
        PATH: sanitizedPath(),
        LANG: 'C.UTF-8',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_AUTHOR_DATE: commitTime,
        GIT_COMMITTER_DATE: commitTime,
    };
    try {
        // Why: fixture commit identity must not depend on a caller's hooks, templates, signing, or timestamps.
        run('git', ['init', '-q', '--template', template, '-b', 'main'], { cwd: destination, env });
        run('git', ['config', 'user.name', 'Review Evaluation'], { cwd: destination, env });
        run('git', ['config', 'user.email', 'review-eval@example.invalid'], { cwd: destination, env });
        run('git', ['config', 'core.logAllRefUpdates', 'false'], { cwd: destination, env });
        run('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: destination, env });
        run('git', ['config', 'core.autocrlf', 'false'], { cwd: destination, env });
        run('git', ['config', 'commit.gpgSign', 'false'], { cwd: destination, env });
        run('git', ['add', '--', '.'], { cwd: destination, env });
        run('git', ['commit', '-q', '--no-verify', '-m', 'fixture: historical base'], { cwd: destination, env });
    } finally {
        rmSync(template, { recursive: true, force: true });
    }
}

function applyPatch(workspace, patch) {
    run('git', ['apply', '--check', '--whitespace=nowarn', '-'], { cwd: workspace, input: patch, encoding: null });
    run('git', ['apply', '--whitespace=nowarn', '-'], { cwd: workspace, input: patch, encoding: null });
}

export function assertHistoryTruncated(workspace) {
    const count = run('git', ['rev-list', '--all', '--count'], { cwd: workspace }).stdout.trim();
    if (count !== '1') fail(`fixture has ${count} reachable commits instead of one`);
    const remotes = run('git', ['remote'], { cwd: workspace }).stdout.trim();
    if (remotes) fail(`fixture unexpectedly has remotes: ${remotes}`);
    const refs = run('git', ['for-each-ref', '--format=%(refname)'], { cwd: workspace })
        .stdout.trim().split('\n').filter(Boolean);
    if (stableJson(refs) !== stableJson(['refs/heads/main'])) {
        fail(`fixture has unexpected refs: ${refs.join(', ')}`);
    }
    if (run('git', ['tag', '--list'], { cwd: workspace }).stdout.trim()) fail('fixture unexpectedly has tags');
    for (const rel of ['.git/objects/info/alternates', '.git/shallow', '.git/logs']) {
        if (existsSync(join(workspace, rel))) fail(`fixture unexpectedly contains ${rel}`);
    }
    const status = run('git', ['status', '--porcelain=v1', '-z'], { cwd: workspace, encoding: null }).stdout;
    if (!status.length) fail('fixture candidate diff is empty');
    const diff = run('git', [
        'diff', '--binary', '--full-index', '--no-ext-diff', '--no-renames',
    ], { cwd: workspace, encoding: null }).stdout;
    const changedPaths = run('git', ['diff', '--name-only', '-z'], {
        cwd: workspace,
        encoding: null,
    }).stdout.toString('utf8').split('\0').filter(Boolean);
    return {
        commit: run('git', ['rev-parse', 'HEAD'], { cwd: workspace }).stdout.trim(),
        changed_paths: changedPaths,
        diff_sha256: sha256(diff),
    };
}

export function materializeFixture({
    protocol,
    protocolPath,
    source,
    caseId,
    arm,
    destination,
}) {
    if (!['baseline', 'treatment'].includes(arm)) fail(`invalid arm: ${arm}`);
    const publicCase = protocol.cases.find((entry) => entry.id === caseId);
    if (!publicCase) fail(`unknown case: ${caseId}`);
    const item = sourceCase(protocol, publicCase);
    const root = verifySource(source, protocol);
    const workspace = resolve(destination);
    if (existsSync(workspace) && (!statSync(workspace).isDirectory() || readdirSync(workspace).length)) {
        fail(`fixture destination must be new or empty: ${workspace}`);
    }
    mkdirSync(workspace, { recursive: true });
    writeTree(workspace, treeEntries(root, item.base, protocol.source.excluded_fixture_paths));
    writeFixtureMetadata(workspace, protocol, protocolPath, item);
    if (arm === 'treatment') writeTreatmentGuidance(workspace, protocol, root);
    initializeFixtureRepository(workspace, protocol.execution.fixture_commit_time);
    const candidatePatch = patchBetween(
        root,
        item.base,
        item.candidate,
        null,
        protocol.source.excluded_fixture_paths,
    );
    applyPatch(workspace, candidatePatch);
    if (item.targetClean) {
        const parent = repairParent(root, item.repair);
        applyPatch(workspace, patchBetween(root, parent, item.repair, item.repair_paths));
    }
    run('git', ['add', '--intent-to-add', '--', '.'], { cwd: workspace });
    const history = assertHistoryTruncated(workspace);
    return { workspace, item, history };
}

function seededRank(seed, value) {
    return sha256(`${seed}\0${value}`);
}

export function buildSchedule(protocol) {
    const pairs = [];
    for (const item of protocol.cases) {
        for (let repetition = 1; repetition <= protocol.schedule.repetitions; repetition += 1) {
            pairs.push({ case_id: item.id, repetition });
        }
    }
    pairs.sort((a, b) => seededRank(protocol.schedule.seed, `${a.case_id}:${a.repetition}`)
        .localeCompare(seededRank(protocol.schedule.seed, `${b.case_id}:${b.repetition}`)));
    return pairs.map((pair, index) => {
        const arms = index % 2 === 0 ? ['baseline', 'treatment'] : ['treatment', 'baseline'];
        return {
            ...pair,
            pair_index: index + 1,
            arms,
            cells: arms.map((arm) => ({
                ...pair,
                arm,
                cell_id: sha256(`${protocol.study_id}\0${pair.case_id}\0${pair.repetition}\0${arm}`).slice(0, 12),
            })),
        };
    });
}

function sanitizedPath(pathValue = process.env.PATH ?? '/usr/bin:/bin') {
    return pathValue.split(':').filter((entry) => entry && !entry.includes('\n') && !entry.includes('\0')).join(':');
}

export function reviewerConfig(pathValue = process.env.PATH, readablePaths = []) {
    const readableRules = [...new Set(readablePaths)].sort()
        .map((path) => `${JSON.stringify(path)} = "read"`)
        .join('\n');
    return `approval_policy = "never"
default_permissions = "review-fixture"
allow_login_shell = false
web_search = "disabled"
check_for_update_on_startup = false
file_opener = "none"

[history]
persistence = "none"

[feedback]
enabled = false

[features]
goals = false
hooks = false
memories = false
multi_agent = false
network_proxy = false
shell_snapshot = false
skill_mcp_dependency_install = false
view_image = false

[permissions.review-fixture.filesystem]
":root" = "deny"
":minimal" = "read"
${readableRules}

[permissions.review-fixture.network]
enabled = false

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false

[shell_environment_policy.set]
HOME = "/nonexistent"
PATH = ${JSON.stringify(sanitizedPath(pathValue))}
LANG = "C.UTF-8"
`;
}

function resolveExecutable(command, pathValue = process.env.PATH ?? '') {
    const candidates = command.includes(sep)
        ? [resolve(command)]
        : pathValue.split(':').filter(Boolean).map((entry) => resolve(entry, command));
    const path = candidates.find((candidate) => existsSync(candidate));
    if (!path) fail(`cannot resolve executable: ${command}`);
    const realPath = realpathSync(path);
    if (!statSync(realPath).isFile()) fail(`resolved executable is not a file: ${realPath}`);
    return realPath;
}

function privateDirectory(prefix) {
    const path = mkdtempSync(join(tmpdir(), prefix));
    chmodSync(path, 0o700);
    return path;
}

function privateMkdir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
}

function privateWrite(path, data) {
    privateMkdir(dirname(path));
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
}

function resolveAuthPath(codexHome) {
    return resolve(codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
}

export function assertNoCredentialMaterial(values, authPath) {
    if (!authPath) return;
    const raw = readFileSync(authPath, 'utf8');
    const fingerprints = new Set();
    const add = (value) => {
        if (typeof value === 'string' && value.length >= 24) fingerprints.add(value);
    };
    add(raw.trim());
    try {
        const visit = (value) => {
            if (typeof value === 'string') add(value);
            else if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') Object.values(value).forEach(visit);
        };
        visit(JSON.parse(raw));
    } catch {
        // A non-JSON auth file is still protected by the full-file fingerprint above.
    }
    for (const value of values) {
        const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
        if ([...fingerprints].some((fingerprint) => text.includes(fingerprint))) {
            fail('reviewer output contained authentication material; raw output was not written');
        }
    }
}

function startLoopbackProbe(root) {
    const portFile = join(root, 'loopback-port');
    const server = spawn(process.execPath, [
        '-e',
        [
            "const { writeFileSync } = require('node:fs');",
            "const { createServer } = require('node:net');",
            'const server = createServer();',
            "server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[1], String(server.address().port)));",
            'setTimeout(() => process.exit(0), 30000);',
        ].join(' '),
        portFile,
    ], { stdio: 'ignore' });
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 5_000;
    while (!existsSync(portFile) && Date.now() < deadline && server.exitCode === null) {
        Atomics.wait(wait, 0, 0, 10);
    }
    if (!existsSync(portFile)) {
        server.kill('SIGTERM');
        fail('could not start loopback isolation probe');
    }
    const port = Number(readFileSync(portFile, 'utf8'));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        server.kill('SIGTERM');
        fail('loopback isolation probe returned an invalid port');
    }
    return { port, stop: () => server.kill('SIGTERM') };
}

export function createReviewerHome({ codexHome, includeAuth, codexBin = 'codex', workspace }) {
    const home = privateDirectory('cycle-review-codex-home-');
    const readablePaths = [resolveExecutable(codexBin)];
    if (workspace) readablePaths.push(realpathSync(workspace));
    writeFileSync(
        join(home, 'config.toml'),
        reviewerConfig(process.env.PATH, readablePaths),
        { mode: 0o600 },
    );
    if (includeAuth) {
        const source = resolveAuthPath(codexHome);
        if (!existsSync(source) || !lstatSync(source).isFile()) {
            rmSync(home, { recursive: true, force: true });
            fail(`Codex authentication is unavailable at ${source}`);
        }
        symlinkSync(source, join(home, 'auth.json'));
    }
    return home;
}

export function reviewerEnvironment({
    reviewerHome,
    scratch,
    cellId = '',
    arm = '',
    caseId = '',
    repetition = '',
    pairIndex = '',
    attempt = '',
    fakeMode = '',
}, ambient = process.env) {
    const env = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
        if (ambient[key]) env[key] = ambient[key];
    }
    env.PATH = sanitizedPath(env.PATH);
    env.HOME = reviewerHome;
    env.CODEX_HOME = reviewerHome;
    env.TMPDIR = scratch;
    env.NO_COLOR = '1';
    env.CYCLE_REVIEW_CELL = cellId;
    env.CYCLE_REVIEW_ARM = arm;
    env.CYCLE_REVIEW_CASE = caseId;
    env.CYCLE_REVIEW_REPETITION = String(repetition);
    env.CYCLE_REVIEW_PAIR_INDEX = String(pairIndex);
    env.CYCLE_REVIEW_ATTEMPT = String(attempt);
    env.CYCLE_REVIEW_FAKE_MODE = fakeMode;
    return env;
}

export function parseExecEvents(text) {
    const events = [];
    const malformed = [];
    const invalid = [];
    for (const [index, line] of text.split('\n').entries()) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line);
            if (!event || typeof event !== 'object' || Array.isArray(event)) invalid.push(index + 1);
            else events.push(event);
        } catch {
            malformed.push(index + 1);
        }
    }
    const reasons = [];
    if (malformed.length) reasons.push(`malformed JSONL at line(s) ${malformed.join(', ')}`);
    if (invalid.length) reasons.push(`invalid JSONL event at line(s) ${invalid.join(', ')}`);
    const completed = events.findLast((event) => event.type === 'turn.completed');
    return { events, invalid: reasons.length ? reasons.join('; ') : null, usage: completed?.usage ?? null };
}

function guidanceMarkers(content) {
    const lines = content.split('\n').map((line) => line.trim()).filter((line) => line.length >= 24);
    if (!lines.length) return [content.trim()];
    return [...new Set([lines[0], lines[Math.floor(lines.length / 2)], lines.at(-1)])];
}

function guidanceEvidence(events, paths, workspace) {
    const completed = events
        .filter((event) => event.type === 'item.completed'
            && event.item?.type === 'command_execution'
            && event.item?.status === 'completed'
            && event.item?.exit_code === 0);
    const touched = events.some((event) => event.type === 'item.completed'
        && event.item?.type === 'command_execution'
        && paths.some((path) => String(event.item.command ?? '').includes(path)));
    const read = paths.every((path) => {
        const guidancePath = join(workspace, path);
        if (!existsSync(guidancePath)) return false;
        const output = completed
            .filter((event) => String(event.item.command ?? '').includes(path))
            .map((event) => String(event.item.aggregated_output ?? ''))
            .join('\n');
        if (!output) return false;
        return guidanceMarkers(readFileSync(guidancePath, 'utf8'))
            .every((marker) => output.includes(marker));
    });
    return { read, touched };
}

function finalAgentText(events) {
    return events
        .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
        .map((event) => event.item.text ?? event.item.message ?? '')
        .filter(Boolean)
        .at(-1) ?? null;
}

function validateFindingsText(text) {
    if (!text) return 'missing final structured response';
    let value;
    try { value = JSON.parse(text); }
    catch { return 'final response is not JSON'; }
    if (!value || !Array.isArray(value.findings) || !isNonEmptyString(value.summary)) {
        return 'final response does not match findings schema';
    }
    const required = [
        'severity', 'file', 'line', 'mechanism', 'consequence', 'recommendation', 'regression_test',
    ];
    for (const finding of value.findings) {
        if (!finding || typeof finding !== 'object' || Array.isArray(finding)
            || !['P0', 'P1', 'P2'].includes(finding.severity)
            || !Number.isSafeInteger(finding.line) || finding.line < 1
            || required.filter((key) => key !== 'line' && key !== 'severity')
                .some((key) => !isNonEmptyString(finding[key]))) {
            return 'final response does not match findings schema';
        }
    }
    return null;
}

function blindText(value) {
    return value.trim()
        .replace(/\.agents\/skills\/(?:review\/SKILL\.md|DOCTRINE\.md)/giu, '[review guidance]')
        .replace(/\brepository-specific review guidance\b/giu, '[review guidance]')
        .replace(/\b(?:baseline|treatment)\b/giu, '[arm]')
        .replace(/\bthe-cycle\b/giu, '[workflow]');
}

function normalizedFindings(text) {
    const value = JSON.parse(text);
    return value.findings.map((finding) => ({
        severity: finding.severity,
        file: blindText(finding.file),
        line: finding.line,
        mechanism: blindText(finding.mechanism),
        consequence: blindText(finding.consequence),
        recommendation: blindText(finding.recommendation),
        regression_test: blindText(finding.regression_test),
    }));
}

function commonPrompt(protocol, protocolPath, item) {
    return `${readFileSync(resolveProtocolAsset(protocolPath, protocol.prompt.common_path), 'utf8')}${
        readFileSync(resolveProtocolAsset(protocolPath, item.task_path), 'utf8')
    }`;
}

function setupDryFixture(protocol, protocolPath, publicCase, arm, destination) {
    mkdirSync(destination, { recursive: true });
    const item = sourceCase(protocol, publicCase);
    writeFileSync(join(destination, 'AGENTS.md'), NEUTRAL_AGENTS);
    mkdirSync(join(destination, '.review-eval'), { recursive: true });
    writeFileSync(join(destination, '.review-eval', 'task.md'), readFileSync(resolveProtocolAsset(protocolPath, item.task_path)));
    writeFileSync(join(destination, '.review-eval', 'findings.schema.json'), readFileSync(resolveProtocolAsset(protocolPath, protocol.prompt.output_schema_path)));
    if (arm === 'treatment') {
        mkdirSync(join(destination, '.agents', 'skills', 'review'), { recursive: true });
        writeFileSync(join(destination, '.agents', 'skills', 'review', 'SKILL.md'), '# Frozen review guidance\n');
        mkdirSync(join(destination, '.agents', 'skills'), { recursive: true });
        writeFileSync(join(destination, '.agents', 'skills', 'DOCTRINE.md'), '# Frozen doctrine\n');
    }
    writeFileSync(join(destination, 'candidate.txt'), 'historical base\n');
    initializeFixtureRepository(destination, protocol.execution.fixture_commit_time);
    writeFileSync(join(destination, 'candidate.txt'), `uncommitted candidate for ${item.id}\n`);
    return { workspace: destination, item, history: assertHistoryTruncated(destination) };
}

function codexVersion(codexBin, env) {
    const result = run(codexBin, ['--version'], { env, allowFailure: true });
    if (result.status !== 0) fail(`cannot run ${codexBin} --version`);
    return result.stdout.trim();
}

export function runStrictConfigProbe({ codexBin, reviewerHome, workspace, scratch }) {
    if (existsSync(join(reviewerHome, 'auth.json'))) {
        fail('strict reviewer-config probe must not receive authentication');
    }
    const env = reviewerEnvironment({ reviewerHome, scratch });
    const result = run(codexBin, [
        'app-server', '--strict-config', '--listen', 'off',
    ], {
        cwd: workspace,
        env,
        timeout: 30_000,
        allowFailure: true,
    });
    const expectedDiagnostic = 'Error: no transport configured; use --listen or enable remote control';
    const expectedNoTransport = result.status === 1
        && (result.stderr ?? '').trim() === expectedDiagnostic
        && !(result.stdout ?? '').trim();
    if (!expectedNoTransport) {
        const diagnostic = result.error?.message || result.stderr || result.stdout || '';
        fail(`Codex strict reviewer-config probe failed (${result.status})\n${diagnostic}`.trimEnd());
    }
    return {
        strict_config: 'pass',
        credentials: 'absent',
        model_calls: 0,
    };
}

export function probeReviewerConfig(codexBin = 'codex') {
    const root = privateDirectory('cycle-review-config-probe-');
    const workspace = join(root, 'workspace');
    const scratch = join(root, 'tmp');
    let reviewerHome;
    try {
        privateMkdir(workspace);
        privateMkdir(scratch);
        reviewerHome = createReviewerHome({ includeAuth: false, codexBin, workspace });
        return runStrictConfigProbe({ codexBin, reviewerHome, workspace, scratch });
    } finally {
        if (reviewerHome) rmSync(reviewerHome, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
}

function ensureNewOutput(path) {
    const output = resolve(path);
    if (existsSync(output) && (!statSync(output).isDirectory() || readdirSync(output).length)) {
        fail(`output path must be new or empty: ${output}`);
    }
    privateMkdir(output);
    return output;
}

function validatePrivateBatchTree(root, path = root) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) fail(`batch output contains a symlink: ${relative(root, path) || '.'}`);
    if (metadata.isDirectory()) {
        if ((metadata.mode & 0o077) !== 0) {
            fail(`batch output directory is not private: ${relative(root, path) || '.'}`);
        }
        for (const entry of readdirSync(path)) validatePrivateBatchTree(root, join(path, entry));
        return;
    }
    if (!metadata.isFile()) fail(`batch output contains a special file: ${relative(root, path)}`);
    if ((metadata.mode & 0o077) !== 0) fail(`batch output file is not private: ${relative(root, path)}`);
}

function prepareBatchOutput(path) {
    const output = resolve(path);
    if (!existsSync(output)) {
        privateMkdir(output);
        return { output, resume: false };
    }
    const metadata = lstatSync(output);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail(`batch output path must be a real directory: ${output}`);
    }
    if ((metadata.mode & 0o077) !== 0) {
        fail(`batch output directory must not be accessible by group or other users: ${output}`);
    }
    const entries = readdirSync(output);
    const occupied = entries.length > 0;
    if (occupied) validatePrivateBatchTree(output);
    else privateMkdir(output);
    const experimentPath = join(output, 'private', 'experiment.json');
    const resultsPath = join(output, 'private', 'results.jsonl');
    const resume = existsSync(experimentPath) || existsSync(resultsPath);
    if (resume !== (existsSync(experimentPath) && existsSync(resultsPath))) {
        fail('batch output contains a partial checkpoint; inspect private state before resuming');
    }
    if (!resume && occupied) {
        const allowedRoot = new Set(['preflight.json', 'private']);
        for (const entry of entries) {
            if (!allowedRoot.has(entry)) {
                fail(`batch output contains stale non-checkpoint state: ${entry}`);
            }
        }
        const privateRoot = join(output, 'private');
        if (existsSync(privateRoot) && readdirSync(privateRoot).length > 0) {
            fail('batch output contains stale private state before the first checkpoint; inspect it before resuming');
        }
    }
    return { output, resume };
}

function withBatchLock(output, callback) {
    const lockPath = join(output, 'private', 'batch.lock');
    privateMkdir(dirname(lockPath));
    try {
        writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, {
            flag: 'wx',
            mode: 0o600,
        });
    } catch (error) {
        fail(`batch output is locked or cannot be locked: ${lockPath} (${error.code ?? error.message})`);
    }
    try {
        return callback();
    } finally {
        rmSync(lockPath, { force: true });
    }
}

function installOffline(workspace) {
    return run('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], {
        cwd: workspace,
        timeout: 180_000,
    });
}

function prepareOfflineCache({ protocol, protocolPath, source }) {
    assertArtifactLock(protocol, protocolPath, source);
    const storePath = run('pnpm', ['store', 'path']).stdout.trim();
    if (!storePath.startsWith(sep)) fail(`pnpm returned a non-absolute store path: ${storePath}`);
    const cacheHome = privateDirectory('cycle-review-pnpm-home-');
    const env = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
        if (process.env[key]) env[key] = process.env[key];
    }
    env.HOME = cacheHome;
    env.NO_COLOR = '1';
    env.npm_config_registry = 'https://registry.npmjs.org/';
    env.npm_config_userconfig = '/dev/null';
    try {
        const fetched = [];
        for (const item of protocol.cases.filter((entry) => !entry.variant)) {
            const root = privateDirectory(`cycle-review-cache-${item.id}-`);
            try {
                const workspace = join(root, 'workspace');
                materializeFixture({
                    protocol,
                    protocolPath,
                    source,
                    caseId: item.id,
                    arm: 'baseline',
                    destination: workspace,
                });
                run('pnpm', ['fetch', '--store-dir', storePath], {
                    cwd: workspace,
                    env,
                    timeout: 180_000,
                });
                fetched.push(item.id);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        }
        return { store: storePath, fetched_cases: fetched };
    } finally {
        rmSync(cacheHome, { recursive: true, force: true });
    }
}

function executeCell({
    protocol,
    protocolPath,
    source,
    output,
    cell,
    attempt,
    codexBin,
    codexVersionValue,
    model,
    effort,
    timeoutMs,
    dryRun,
    codexHome,
}) {
    const publicCase = protocol.cases.find((entry) => entry.id === cell.case_id);
    const privateRoot = privateDirectory('cycle-review-cell-');
    const workspace = join(privateRoot, 'workspace');
    const reviewerScratch = join(privateRoot, 'reviewer-tmp');
    mkdirSync(reviewerScratch, { recursive: true });
    const runName = `${String(cell.pair_index ?? 0).padStart(2, '0')}-${cell.cell_id}-a${attempt}`;
    const runDir = join(output, 'private', 'runs', runName);
    privateMkdir(runDir);
    let reviewerHome;
    try {
        const fixture = dryRun
            ? setupDryFixture(protocol, protocolPath, publicCase, cell.arm, workspace)
            : materializeFixture({ protocol, protocolPath, source, caseId: cell.case_id, arm: cell.arm, destination: workspace });
        if (!dryRun) installOffline(workspace);
        const before = run('git', [
            'diff', '--binary', '--full-index', '--no-ext-diff', '--no-renames',
        ], { cwd: workspace, encoding: null }).stdout;
        const statusBefore = run('git', ['status', '--porcelain=v1', '-z'], {
            cwd: workspace,
            encoding: null,
        }).stdout;
        privateWrite(join(runDir, 'candidate.diff'), before);
        const authPath = dryRun ? null : resolveAuthPath(codexHome);
        reviewerHome = createReviewerHome({ codexHome, includeAuth: !dryRun, codexBin, workspace });
        const env = reviewerEnvironment({
            reviewerHome,
            scratch: reviewerScratch,
            cellId: cell.cell_id,
            arm: cell.arm,
            caseId: cell.case_id,
            repetition: cell.repetition,
            pairIndex: cell.pair_index,
            attempt,
            fakeMode: dryRun ? process.env.CYCLE_REVIEW_FAKE_MODE ?? '' : '',
        });
        const args = [
            'exec', '--json', '--ephemeral', '--strict-config', '--ignore-rules',
            '--cd', workspace,
            '--model', model,
            '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
            '--output-schema', join(workspace, '.review-eval', 'findings.schema.json'),
            '--color', 'never',
            commonPrompt(protocol, protocolPath, fixture.item),
        ];
        const startedAt = new Date().toISOString();
        const processResult = run(codexBin, args, {
            cwd: workspace,
            env,
            timeout: timeoutMs,
            allowFailure: true,
        });
        const finishedAt = new Date().toISOString();
        const stdout = processResult.stdout ?? '';
        const stderr = processResult.stderr ?? '';
        // Why: the outer client needs auth, but any accidental echo must fail closed before persistence.
        assertNoCredentialMaterial([stdout, stderr], authPath);
        privateWrite(join(runDir, 'events.jsonl'), stdout);
        privateWrite(join(runDir, 'stderr.txt'), stderr);
        const parsed = parseExecEvents(stdout);
        const finalText = finalAgentText(parsed.events);
        if (finalText) privateWrite(join(runDir, 'final.json'), `${finalText}\n`);
        const after = run('git', [
            'diff', '--binary', '--full-index', '--no-ext-diff', '--no-renames',
        ], { cwd: workspace, encoding: null }).stdout;
        const statusAfter = run('git', ['status', '--porcelain=v1', '-z'], {
            cwd: workspace,
            encoding: null,
        }).stdout;
        const invalid = [];
        if (processResult.status !== 0) invalid.push(`reviewer exited ${processResult.status}`);
        if (parsed.invalid) invalid.push(parsed.invalid);
        if (!parsed.events.some((event) => event.type === 'turn.completed')) invalid.push('missing turn.completed');
        const schemaInvalid = validateFindingsText(finalText);
        if (schemaInvalid) invalid.push(schemaInvalid);
        const guidance = guidanceEvidence(
            parsed.events,
            protocol.source.review_guidance_paths,
            workspace,
        );
        if (cell.arm === 'treatment' && !guidance.read) invalid.push('treatment did not read pinned review guidance');
        if (cell.arm === 'baseline' && guidance.touched) invalid.push('baseline discovered treatment review guidance');
        if (!before.equals(after) || !statusBefore.equals(statusAfter)) {
            invalid.push('reviewer mutated the candidate fixture');
        }
        const artifacts = {
            events: relative(output, join(runDir, 'events.jsonl')),
            stderr: relative(output, join(runDir, 'stderr.txt')),
            candidate_diff: relative(output, join(runDir, 'candidate.diff')),
            final: finalText ? relative(output, join(runDir, 'final.json')) : null,
        };
        const artifactSha256 = Object.fromEntries(Object.entries(artifacts)
            .filter(([, path]) => path)
            .map(([key, path]) => [key, sha256(readFileSync(join(output, path)))]));
        const result = {
            study_id: protocol.study_id,
            case_id: cell.case_id,
            repetition: cell.repetition,
            pair_index: cell.pair_index,
            arm: cell.arm,
            cell_id: cell.cell_id,
            attempt,
            valid: invalid.length === 0,
            invalid_reasons: invalid,
            model,
            reasoning_effort: effort,
            codex_version: codexVersionValue,
            started_at: startedAt,
            finished_at: finishedAt,
            elapsed_ms: processResult.elapsedMs,
            usage: parsed.usage,
            fixture: fixture.history,
            treatment_guidance_read: guidance.read,
            artifacts,
            artifact_sha256: artifactSha256,
        };
        privateWrite(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
        return result;
    } finally {
        if (reviewerHome) rmSync(reviewerHome, { recursive: true, force: true });
        rmSync(privateRoot, { recursive: true, force: true });
    }
}

export function acceptedResults(protocol, results) {
    const latestValid = new Map();
    for (const item of protocol.cases) {
        for (let repetition = 1; repetition <= protocol.schedule.repetitions; repetition += 1) {
            const attempts = results
                .filter((result) => result.case_id === item.id && result.repetition === repetition)
                .map((result) => result.attempt);
            if (!attempts.length) continue;
            const latestAttempt = Math.max(...attempts);
            const pair = results.filter((result) => result.case_id === item.id
                && result.repetition === repetition && result.attempt === latestAttempt);
            const arms = new Set(pair.map((result) => result.arm));
            // Why: retry validity belongs to the matched pair, never to compatible cells from different attempts.
            if (pair.length !== 2 || arms.size !== 2 || !arms.has('baseline') || !arms.has('treatment')
                || pair.some((result) => !result.valid)) continue;
            for (const result of pair) {
                latestValid.set(`${result.case_id}:${result.repetition}:${result.arm}`, result);
            }
        }
    }
    return latestValid;
}

function readResults(path) {
    if (!existsSync(path)) fail(`missing resumable results: ${path}`);
    const text = readFileSync(path, 'utf8').trim();
    if (!text) return [];
    return text.split('\n').map((line, index) => {
        try {
            return JSON.parse(line);
        } catch (error) {
            fail(`invalid resumable results JSON at line ${index + 1}: ${error.message}`);
        }
    });
}

function expectedArtifacts(pair, cell, result) {
    const runName = `${String(pair.pair_index).padStart(2, '0')}-${cell.cell_id}-a${result.attempt}`;
    const root = join('private', 'runs', runName);
    return {
        events: join(root, 'events.jsonl'),
        stderr: join(root, 'stderr.txt'),
        candidate_diff: join(root, 'candidate.diff'),
        final: result.artifacts?.final === null ? null : join(root, 'final.json'),
    };
}

function validatePersistedResult({ output, experiment, pair, cell, attempt, result }) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        fail(`resumable result for pair ${pair.pair_index} is not an object`);
    }
    const expectedIdentity = {
        study_id: experiment.study_id,
        case_id: pair.case_id,
        repetition: pair.repetition,
        pair_index: pair.pair_index,
        arm: cell.arm,
        cell_id: cell.cell_id,
        attempt,
        model: experiment.model,
        reasoning_effort: experiment.reasoning_effort,
        codex_version: experiment.codex_version,
    };
    for (const [key, expected] of Object.entries(expectedIdentity)) {
        if (result[key] !== expected) {
            fail(`resumable result mismatch for pair ${pair.pair_index} ${cell.arm}: ${key}`);
        }
    }
    if (typeof result.valid !== 'boolean' || !Array.isArray(result.invalid_reasons)
        || !Number.isSafeInteger(result.elapsed_ms) || result.elapsed_ms < 0) {
        fail(`resumable result has invalid status fields for pair ${pair.pair_index} ${cell.arm}`);
    }
    const artifacts = expectedArtifacts(pair, cell, result);
    if (stableJson(result.artifacts) !== stableJson(artifacts)) {
        fail(`resumable result has unexpected artifact paths for pair ${pair.pair_index} ${cell.arm}`);
    }
    const paths = [...Object.values(artifacts).filter(Boolean), join(
        'private',
        'runs',
        `${String(pair.pair_index).padStart(2, '0')}-${cell.cell_id}-a${attempt}`,
        'result.json',
    )];
    for (const artifact of paths) {
        const path = resolve(output, artifact);
        ensureInside(output, path);
        if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
            fail(`missing or unsafe resumable artifact: ${artifact}`);
        }
        ensureInside(realpathSync(output), realpathSync(path));
        if ((lstatSync(path).mode & 0o077) !== 0) fail(`resumable artifact is not private: ${artifact}`);
    }
    const actualHashes = Object.fromEntries(Object.entries(artifacts)
        .filter(([, path]) => path)
        .map(([key, path]) => [key, sha256(readFileSync(resolve(output, path)))]));
    if (stableJson(result.artifact_sha256) !== stableJson(actualHashes)) {
        fail(`resumable artifact content changed for pair ${pair.pair_index} ${cell.arm}`);
    }
    const resultPath = resolve(output, paths.at(-1));
    let persisted;
    try { persisted = JSON.parse(readFileSync(resultPath, 'utf8')); }
    catch (error) { fail(`invalid resumable result artifact ${relative(output, resultPath)}: ${error.message}`); }
    if (stableJson(persisted) !== stableJson(result)) {
        fail(`resumable result index disagrees with ${relative(output, resultPath)}`);
    }
}

export function validateExperimentProgress({ protocol, output, experiment, results }) {
    const schedule = buildSchedule(protocol);
    let cursor = 0;
    let completedPairs = 0;
    let terminalInvalidPair = null;
    for (const pair of schedule) {
        if (cursor === results.length) break;
        const first = results.slice(cursor, cursor + 2);
        if (first.length !== 2) fail(`resumable results split pair ${pair.pair_index}`);
        first.forEach((result, index) => validatePersistedResult({
            output,
            experiment,
            pair,
            cell: pair.cells[index],
            attempt: 1,
            result,
        }));
        cursor += 2;
        if (first.every((result) => result.valid)) {
            completedPairs += 1;
            continue;
        }
        const retry = results.slice(cursor, cursor + 2);
        if (retry.length !== 2) fail(`resumable results split retry for pair ${pair.pair_index}`);
        retry.forEach((result, index) => validatePersistedResult({
            output,
            experiment,
            pair,
            cell: pair.cells[index],
            attempt: 2,
            result,
        }));
        cursor += 2;
        if (retry.every((result) => result.valid)) completedPairs += 1;
        else terminalInvalidPair = pair.pair_index;
        if (terminalInvalidPair !== null) break;
    }
    if (cursor !== results.length) {
        fail('resumable results are not an exact completed prefix of the frozen schedule');
    }
    return {
        completedPairs,
        terminalInvalidPair,
        complete: completedPairs === schedule.length,
    };
}

function writeScoringArtifacts({ protocol, protocolPath, output, results }) {
    const latestValid = acceptedResults(protocol, results);
    if (latestValid.size !== 36) fail('cannot normalize an incomplete experiment');

    const scoringRoot = join(output, 'scoring');
    const fixtureRoot = join(scoringRoot, 'fixtures');
    const privateRoot = join(output, 'private');
    privateMkdir(fixtureRoot);
    privateMkdir(privateRoot);

    const fixtures = [];
    const packets = [];
    const blindingMap = [];
    const measures = [];
    for (const publicCase of protocol.cases) {
        const item = sourceCase(protocol, publicCase);
        const fixtureId = sha256(`${protocol.schedule.seed}\0fixture\0${publicCase.id}`).slice(0, 16);
        const caseResults = [...latestValid.values()].filter((result) => result.case_id === publicCase.id);
        const diffs = caseResults.map((result) => readFileSync(join(output, result.artifacts.candidate_diff)));
        const diffHashes = new Set(diffs.map(sha256));
        if (diffHashes.size !== 1) fail(`candidate diff drifted between cells for ${publicCase.id}`);
        const diffPath = join('fixtures', `${fixtureId}.diff`);
        privateWrite(join(scoringRoot, diffPath), diffs[0]);
        fixtures.push({
            fixture_id: fixtureId,
            expected_state: item.targetClean ? 'named-defect-repaired' : 'defect-present',
            task: readFileSync(resolveProtocolAsset(protocolPath, item.task_path), 'utf8'),
            candidate_diff: diffPath,
            candidate_diff_sha256: [...diffHashes][0],
            targets: item.targets.map((target, index) => ({
                target_label: `T${index + 1}`,
                credit: target.credit,
            })),
        });

        for (let repetition = 1; repetition <= protocol.schedule.repetitions; repetition += 1) {
            const pair = ['baseline', 'treatment'].map((arm) => latestValid.get(
                `${publicCase.id}:${repetition}:${arm}`,
            ));
            if (pair.some((result) => !result)) fail(`missing valid pair for ${publicCase.id}:${repetition}`);
            const ordered = pair.sort((a, b) => seededRank(
                protocol.schedule.seed,
                `blind:${publicCase.id}:${repetition}:${a.arm}`,
            ).localeCompare(seededRank(
                protocol.schedule.seed,
                `blind:${publicCase.id}:${repetition}:${b.arm}`,
            )));
            const packetId = sha256(
                `${protocol.schedule.seed}\0packet\0${publicCase.id}\0${repetition}`,
            ).slice(0, 16);
            const reviews = ordered.map((result, index) => {
                const outputLabel = String.fromCharCode(65 + index);
                const finalPath = result.artifacts.final && join(output, result.artifacts.final);
                if (!finalPath || !existsSync(finalPath)) fail(`missing final output for ${result.cell_id}`);
                const finalText = readFileSync(finalPath, 'utf8');
                const invalid = validateFindingsText(finalText);
                if (invalid) fail(`cannot normalize ${result.cell_id}: ${invalid}`);
                blindingMap.push({
                    packet_id: packetId,
                    fixture_id: fixtureId,
                    case_id: publicCase.id,
                    repetition,
                    output_label: outputLabel,
                    arm: result.arm,
                    cell_id: result.cell_id,
                    attempt: result.attempt,
                });
                measures.push({
                    case_id: publicCase.id,
                    repetition,
                    arm: result.arm,
                    cell_id: result.cell_id,
                    attempt: result.attempt,
                    elapsed_ms: result.elapsed_ms,
                    usage: result.usage,
                    lifecycle_evidence: {
                        treatment_guidance_read: result.treatment_guidance_read,
                        reviewer_count: protocol.execution.reviewers_per_arm,
                    },
                });
                return {
                    output_label: outputLabel,
                    findings: normalizedFindings(finalText),
                };
            });
            packets.push({ packet_id: packetId, fixture_id: fixtureId, trial: repetition, reviews });
        }
    }

    const scoringInput = {
        version: 1,
        instructions: {
            independence: 'Two scorers complete separate schema-valid files before adjudication.',
            recall: protocol.scoring.recall,
            actionability: protocol.scoring.actionability,
            unsupported_findings: protocol.scoring.unsupported_findings,
            controls: protocol.scoring.controls,
            composite_score: false,
        },
        fixtures,
        packets,
    };
    const scoringBytes = Buffer.from(`${JSON.stringify(scoringInput, null, 2)}\n`);
    privateWrite(join(scoringRoot, 'scoring-input.json'), scoringBytes);
    const scoreSchema = readFileSync(resolveProtocolAsset(protocolPath, protocol.scoring.schema_path));
    privateWrite(join(scoringRoot, 'score.schema.json'), scoreSchema);
    privateWrite(join(privateRoot, 'blinding-map.json'), `${JSON.stringify(blindingMap, null, 2)}\n`);
    privateWrite(
        join(privateRoot, 'measures.jsonl'),
        `${measures.map((measure) => JSON.stringify(measure)).join('\n')}\n`,
    );
    privateWrite(join(scoringRoot, 'manifest.json'), `${JSON.stringify({
        scoring_input_sha256: sha256(scoringBytes),
        score_schema_sha256: sha256(scoreSchema),
        fixture_diffs: fixtures.map((fixture) => ({
            fixture_id: fixture.fixture_id,
            sha256: fixture.candidate_diff_sha256,
        })),
        packet_count: packets.length,
        normalized_review_count: packets.length * 2,
    }, null, 2)}\n`);
}

function writeResults(output, results) {
    privateWrite(
        join(output, 'private', 'results.jsonl'),
        results.length ? `${results.map((result) => JSON.stringify(result)).join('\n')}\n` : '',
    );
}

function usageTotals(results) {
    const totals = {};
    for (const result of results) {
        if (!result.usage || typeof result.usage !== 'object' || Array.isArray(result.usage)) continue;
        for (const [key, value] of Object.entries(result.usage)) {
            if (typeof value === 'number' && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
        }
    }
    return totals;
}

function writeExperimentSummary({ protocol, output, results, progress }) {
    const latestValid = acceptedResults(protocol, results);
    const summary = {
        complete: progress.complete,
        completed_pairs: progress.completedPairs,
        total_pairs: buildSchedule(protocol).length,
        remaining_pairs: buildSchedule(protocol).length - progress.completedPairs,
        valid_cells: latestValid.size,
        attempts: results.length,
        invalid_attempts: results.filter((result) => !result.valid).length,
    };
    privateWrite(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
}

function runExperiment({
    protocol,
    protocolPath,
    source,
    output,
    codexBin,
    model,
    effort,
    timeoutMs,
    dryRun,
    codexHome,
    resume = false,
    maxPairs = Number.POSITIVE_INFINITY,
}) {
    const activePairPath = join(output, 'private', 'active-pair.json');
    if (existsSync(activePairPath)) {
        fail(`previous batch stopped mid-pair; inspect its private artifacts before removing ${activePairPath}`);
    }
    const reviewerHome = createReviewerHome({ codexHome, includeAuth: false, codexBin });
    const versionEnv = reviewerEnvironment({ reviewerHome, scratch: privateDirectory('cycle-review-version-') });
    let version;
    try { version = codexVersion(codexBin, versionEnv); }
    finally {
        rmSync(versionEnv.TMPDIR, { recursive: true, force: true });
        rmSync(reviewerHome, { recursive: true, force: true });
    }
    const schedule = buildSchedule(protocol);
    const experiment = {
        study_id: protocol.study_id,
        protocol_sha256: sha256(readFileSync(protocolPath)),
        mode: dryRun ? 'dry-run' : 'scored',
        model,
        reasoning_effort: effort,
        codex_version: version,
        schedule,
    };
    const experimentPath = join(output, 'private', 'experiment.json');
    const resultsPath = join(output, 'private', 'results.jsonl');
    let results;
    if (resume) {
        if (!existsSync(experimentPath)) fail(`missing resumable experiment: ${experimentPath}`);
        let persistedExperiment;
        try { persistedExperiment = JSON.parse(readFileSync(experimentPath, 'utf8')); }
        catch (error) { fail(`invalid resumable experiment: ${error.message}`); }
        if (stableJson(persistedExperiment) !== stableJson(experiment)) {
            fail('resumable experiment does not match the frozen protocol, model, effort, Codex version, or schedule');
        }
        results = readResults(resultsPath);
    } else {
        if (existsSync(experimentPath) || existsSync(resultsPath)) fail('new experiment output already contains state');
        privateWrite(experimentPath, `${JSON.stringify(experiment, null, 2)}\n`);
        results = [];
        writeResults(output, results);
    }
    let progress = validateExperimentProgress({ protocol, output, experiment, results });
    if (progress.terminalInvalidPair !== null) {
        fail(`experiment is terminally incomplete at pair ${progress.terminalInvalidPair}`);
    }
    if (progress.complete) fail('experiment is already complete');
    if (existsSync(join(output, 'scoring'))) fail('incomplete experiment unexpectedly contains scoring artifacts');
    const beforeCount = results.length;
    const invocationStarted = Date.now();
    const selectedPairs = schedule.slice(progress.completedPairs, progress.completedPairs + maxPairs);
    for (const pair of selectedPairs) {
        privateWrite(activePairPath, `${JSON.stringify({
            pair_index: pair.pair_index,
            started_at: new Date().toISOString(),
        }, null, 2)}\n`);
        let pairResults = pair.cells.map((cell) => executeCell({
            protocol,
            protocolPath,
            source,
            output,
            cell: { ...cell, pair_index: pair.pair_index },
            attempt: 1,
            codexBin,
            codexVersionValue: version,
            model,
            effort,
            timeoutMs,
            dryRun,
            codexHome,
        }));
        results.push(...pairResults);
        if (pairResults.some((result) => !result.valid)) {
            pairResults = pair.cells.map((cell) => executeCell({
                protocol,
                protocolPath,
                source,
                output,
                cell: { ...cell, pair_index: pair.pair_index },
                attempt: 2,
                codexBin,
                codexVersionValue: version,
                model,
                effort,
                timeoutMs,
                dryRun,
                codexHome,
            }));
            results.push(...pairResults);
        }
        writeResults(output, results);
        progress = validateExperimentProgress({ protocol, output, experiment, results });
        rmSync(activePairPath, { force: true });
        writeExperimentSummary({ protocol, output, results, progress });
        if (progress.terminalInvalidPair !== null) break;
    }
    progress = validateExperimentProgress({ protocol, output, experiment, results });
    const summary = writeExperimentSummary({ protocol, output, results, progress });
    const invocationResults = results.slice(beforeCount);
    const receipt = {
        pair_index: selectedPairs[0]?.pair_index ?? null,
        calls: invocationResults.length,
        invalid_attempts: invocationResults.filter((result) => !result.valid).length,
        token_usage: usageTotals(invocationResults),
        elapsed_ms: Date.now() - invocationStarted,
        completed_pairs: summary.completed_pairs,
        remaining_pairs: summary.remaining_pairs,
        complete: summary.complete,
    };
    if (progress.terminalInvalidPair !== null && !Number.isFinite(maxPairs)) {
        fail(`experiment stopped after the retry for pair ${progress.terminalInvalidPair} stayed invalid`);
    }
    if (progress.complete) writeScoringArtifacts({ protocol, protocolPath, output, results });
    return {
        results,
        receipt,
        terminalInvalidPair: progress.terminalInvalidPair,
    };
}

function runOracleCommands(workspace, commands) {
    const outputs = [];
    for (const command of commands) {
        const result = run('/bin/sh', ['-c', command], {
            cwd: workspace,
            timeout: 180_000,
            allowFailure: true,
        });
        outputs.push({ command, status: result.status, stdout: result.stdout, stderr: result.stderr });
        if (result.status !== 0) return { status: result.status, outputs };
    }
    return { status: 0, outputs };
}

function oracleFailure(result) {
    const failed = result.outputs.find((entry) => entry.status !== 0);
    if (!failed) return 'unknown oracle failure';
    return [
        `command: ${failed.command}`,
        failed.stderr?.trim(),
        failed.stdout?.trim(),
    ].filter(Boolean).join('\n');
}

function verifyOracle({ protocol, protocolPath, source, item }) {
    const privateRoot = privateDirectory(`cycle-review-oracle-${item.id}-`);
    const workspace = join(privateRoot, 'workspace');
    try {
        materializeFixture({ protocol, protocolPath, source, caseId: item.id, arm: 'baseline', destination: workspace });
        installOffline(workspace);
        const original = runOracleCommands(workspace, item.oracle_commands);
        if (original.status !== 0) {
            fail(`case ${item.id} original tests are red before hidden oracle\n${oracleFailure(original)}`);
        }
        const parent = repairParent(source, item.repair);
        applyPatch(workspace, patchBetween(source, parent, item.repair, item.oracle_paths));
        const flawed = runOracleCommands(workspace, item.oracle_commands);
        if (flawed.status === 0) fail(`case ${item.id} hidden oracle did not fail against flawed candidate`);
        applyPatch(workspace, patchBetween(source, parent, item.repair, item.repair_paths));
        const repaired = runOracleCommands(workspace, item.oracle_commands);
        if (repaired.status !== 0) {
            fail(`case ${item.id} hidden oracle stayed red after repair\n${oracleFailure(repaired)}`);
        }
        return {
            case_id: item.id,
            original_tests: 'pass',
            hidden_oracle_on_flawed: 'fail',
            hidden_oracle_after_repair: 'pass',
        };
    } finally {
        rmSync(privateRoot, { recursive: true, force: true });
    }
}

function verifyControl({ protocol, protocolPath, source, item }) {
    const privateRoot = privateDirectory(`cycle-review-control-${item.id}-`);
    const workspace = join(privateRoot, 'workspace');
    try {
        const fixture = materializeFixture({ protocol, protocolPath, source, caseId: item.id, arm: 'baseline', destination: workspace });
        installOffline(workspace);
        const parent = repairParent(source, fixture.item.repair);
        applyPatch(workspace, patchBetween(source, parent, fixture.item.repair, fixture.item.oracle_paths));
        const result = runOracleCommands(workspace, fixture.item.oracle_commands);
        if (result.status !== 0) {
            fail(`control ${item.id} is not target-clean\n${oracleFailure(result)}`);
        }
        return { case_id: item.id, hidden_oracle: 'pass' };
    } finally {
        rmSync(privateRoot, { recursive: true, force: true });
    }
}

export function probeIsolation(codexBin = 'codex') {
    const root = privateDirectory('cycle-review-isolation-');
    const workspace = join(root, 'workspace');
    const scratch = privateDirectory('cycle-review-isolation-tmp-');
    let reviewerHome;
    let loopback;
    try {
        mkdirSync(workspace, { recursive: true });
        reviewerHome = createReviewerHome({ includeAuth: false, codexBin, workspace });
        writeFileSync(join(workspace, 'allowed.txt'), 'allowed\n');
        const deniedNames = ['source', 'evaluator', 'sibling', 'memory', 'oracle'];
        const denied = deniedNames.map((name) => {
            const path = join(root, `${name}.sentinel`);
            writeFileSync(path, `${name}\n`);
            return path;
        });
        const authHomeSentinel = join(reviewerHome, 'auth-home.sentinel');
        writeFileSync(authHomeSentinel, 'auth-home\n', { mode: 0o600 });
        denied.push(authHomeSentinel);
        const env = reviewerEnvironment({ reviewerHome, scratch });
        loopback = startLoopbackProbe(root);
        const script = [
            'test -r allowed.txt || exit 10',
            'rg -q "^allowed$" allowed.txt || exit 11',
            'test "$(sed -n 1p allowed.txt)" = allowed || exit 12',
            'git --version >/dev/null || exit 13',
            `if /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/${loopback.port}' 2>/dev/null; then exit 30; fi`,
            'shift',
            'for path do test ! -r "$path" || exit 20; done',
        ].join('; ');
        const result = run(codexBin, [
            'sandbox', '--permission-profile', 'review-fixture', '--cd', workspace,
            '/bin/sh', '-c', script, 'probe', ...denied,
        ], { cwd: workspace, env, allowFailure: true, timeout: 30_000 });
        if (result.status !== 0) {
            fail(`Codex permission-profile isolation probe failed (${result.status})\n${result.stderr || result.stdout || ''}`.trimEnd());
        }
        return {
            allowed_fixture_read: true,
            required_review_tools: ['git', 'rg', 'sed'],
            denied_host_loopback_listener: true,
            denied_host_sentinels: [...deniedNames, 'auth-home'],
            command_network: false,
            filesystem_profile_sha256: sha256(reviewerConfig('/usr/bin:/bin', ['/fixture', '/runtime/codex'])),
        };
    } finally {
        if (loopback) loopback.stop();
        rmSync(root, { recursive: true, force: true });
        if (reviewerHome) rmSync(reviewerHome, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
    }
}

function preflight({ protocol, protocolPath, source, output, codexBin, skipOracles }) {
    assertArtifactLock(protocol, protocolPath, source);
    const reviewerConfigProbe = probeReviewerConfig(codexBin);
    const fixtures = [];
    for (const item of protocol.cases) {
        const root = privateDirectory(`cycle-review-preflight-${item.id}-`);
        try {
            const fixture = materializeFixture({
                protocol,
                protocolPath,
                source,
                caseId: item.id,
                arm: 'baseline',
                destination: join(root, 'workspace'),
            });
            fixtures.push({ case_id: item.id, ...fixture.history });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
    const isolation = probeIsolation(codexBin);
    const oracles = skipOracles ? null : [
        ...protocol.cases.filter((item) => !item.variant).map((item) => verifyOracle({
            protocol, protocolPath, source, item,
        })),
        ...protocol.cases.filter((item) => item.variant === 'target-clean').map((item) => verifyControl({
            protocol, protocolPath, source, item,
        })),
    ];
    const result = {
        study_id: protocol.study_id,
        protocol_sha256: sha256(readFileSync(protocolPath)),
        artifact_lock: 'pass',
        reviewer_config: reviewerConfigProbe,
        fixtures,
        isolation,
        oracles,
        scored_model_calls: 0,
    };
    privateWrite(join(output, 'preflight.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
}

function usage() {
    return `Usage:
  node eval/review/run.mjs lock --source <release-relay-checkout>
  node eval/review/run.mjs plan
  node eval/review/run.mjs fetch-cache --source <checkout> --allow-network
  node eval/review/run.mjs dry-run --output <new-directory>
  node eval/review/run.mjs dry-run-batch --output <new-or-resumable-directory>
  node eval/review/run.mjs preflight --source <checkout> --output <new-directory> [--skip-oracles]
  node eval/review/run.mjs run --source <checkout> --output <new-directory>
       --confirm-protocol-sha256 <sha256> [--codex-home <path>]
  node eval/review/run.mjs run-batch --source <checkout> --output <new-or-resumable-directory>
       --confirm-protocol-sha256 <sha256> [--codex-home <path>]

Options:
  --protocol <path>       Protocol file, default: eval/review/protocol.json
  --codex-bin <path>      Codex executable; dry-run defaults to the bundled fake
  --timeout-ms <number>   Dry-run override; scored runs must match the frozen protocol
`;
}

export function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            protocol: { type: 'string', default: DEFAULT_PROTOCOL },
            source: { type: 'string' },
            output: { type: 'string' },
            'codex-bin': { type: 'string' },
            'codex-home': { type: 'string' },
            'confirm-protocol-sha256': { type: 'string' },
            'timeout-ms': { type: 'string' },
            'skip-oracles': { type: 'boolean', default: false },
            'allow-network': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help || positionals.length !== 1) {
        console.log(usage());
        return values.help ? 0 : 2;
    }
    const command = positionals[0];
    const requireLock = command !== 'lock';
    const { protocol, protocolPath } = loadProtocol(values.protocol, { requireLock });
    if (command === 'lock') {
        if (!values.source) fail('lock requires --source');
        console.log(JSON.stringify(computeArtifactLock(protocol, protocolPath, values.source), null, 2));
        return 0;
    }
    if (command === 'plan') {
        console.log(JSON.stringify(buildSchedule(protocol), null, 2));
        return 0;
    }
    if (command === 'fetch-cache') {
        if (!values.source) fail('fetch-cache requires --source');
        if (!values['allow-network']) fail('fetch-cache requires explicit --allow-network');
        console.log(JSON.stringify(prepareOfflineCache({
            protocol,
            protocolPath,
            source: verifySource(values.source, protocol),
        }), null, 2));
        return 0;
    }
    const timeoutMs = Number(values['timeout-ms'] ?? protocol.execution.timeout_ms);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('--timeout-ms must be a positive integer');
    const experimentCommands = ['dry-run', 'dry-run-batch', 'preflight', 'run', 'run-batch'];
    if (!experimentCommands.includes(command)) fail(`unknown command: ${command}`);
    if (!values.output) fail(`${command} requires --output`);
    const batchCommand = command === 'dry-run-batch' || command === 'run-batch';
    const prepared = batchCommand
        ? prepareBatchOutput(values.output)
        : { output: ensureNewOutput(values.output), resume: false };
    const { output, resume } = prepared;
    if (command === 'dry-run') {
        runExperiment({
            protocol,
            protocolPath,
            output,
            codexBin: resolve(values['codex-bin'] ?? DEFAULT_FAKE_CODEX),
            model: 'fake-review-model',
            effort: protocol.execution.reasoning_effort,
            timeoutMs,
            dryRun: true,
        });
        return 0;
    }
    if (command === 'dry-run-batch') {
        return withBatchLock(output, () => {
            const result = runExperiment({
                protocol,
                protocolPath,
                output,
                codexBin: resolve(values['codex-bin'] ?? DEFAULT_FAKE_CODEX),
                model: 'fake-review-model',
                effort: protocol.execution.reasoning_effort,
                timeoutMs,
                dryRun: true,
                resume,
                maxPairs: protocol.schedule.pairs_per_batch,
            });
            console.log(JSON.stringify(result.receipt, null, 2));
            if (result.terminalInvalidPair !== null) {
                fail(`experiment stopped after the retry for pair ${result.terminalInvalidPair} stayed invalid`);
            }
            return 0;
        });
    }
    if (!values.source) fail(`${command} requires --source`);
    const source = verifySource(values.source, protocol);
    if (command === 'preflight') {
        preflight({
            protocol,
            protocolPath,
            source,
            output,
            codexBin: values['codex-bin'] ?? 'codex',
            skipOracles: values['skip-oracles'],
        });
        return 0;
    }
    if (command === 'run' || command === 'run-batch') {
        const expected = sha256(readFileSync(protocolPath));
        if (values['confirm-protocol-sha256'] !== expected) {
            fail(`${command} requires --confirm-protocol-sha256 ${expected}`);
        }
        if (timeoutMs !== protocol.execution.timeout_ms) {
            fail(`${command} timeout is frozen at ${protocol.execution.timeout_ms}ms`);
        }
        if (values['skip-oracles']) fail(`${command} cannot skip hidden-oracle preflight`);
        const execute = () => {
            preflight({
                protocol,
                protocolPath,
                source,
                output,
                codexBin: values['codex-bin'] ?? 'codex',
                skipOracles: false,
            });
            const result = runExperiment({
                protocol,
                protocolPath,
                source,
                output,
                codexBin: values['codex-bin'] ?? 'codex',
                model: protocol.execution.model,
                effort: protocol.execution.reasoning_effort,
                timeoutMs,
                dryRun: false,
                codexHome: values['codex-home'],
                resume,
                maxPairs: command === 'run-batch'
                    ? protocol.schedule.pairs_per_batch
                    : Number.POSITIVE_INFINITY,
            });
            if (command === 'run-batch') {
                console.log(JSON.stringify(result.receipt, null, 2));
                if (result.terminalInvalidPair !== null) {
                    fail(`experiment stopped after the retry for pair ${result.terminalInvalidPair} stayed invalid`);
                }
            }
            return 0;
        };
        return command === 'run-batch' ? withBatchLock(output, execute) : execute();
    }
    fail(`unhandled command: ${command}`);
}

function invokedDirectly() {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
    try {
        process.exitCode = main();
    } catch (error) {
        if (error instanceof ReviewEvalError) {
            console.error(error.message);
            process.exitCode = 2;
        } else {
            throw error;
        }
    }
}
