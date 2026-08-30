#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    unlinkSync,
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
const FAKE_BIN = join(HERE, 'bin');
const MAX_BUFFER = 128 * 1024 * 1024;
const MAX_CAPTURE_FILE = 16 * 1024 * 1024;
const MAX_GIT_CONTROL_ENTRIES = 100_000;
const TREE_CACHE = new Map();
const PATCH_CACHE = new Map();

export class PipelineEvalError extends Error {}

function fail(message) {
    throw new PipelineEvalError(message);
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
    if (result.error && !allowFailure) fail(`${command} failed to start: ${result.error.message}`);
    if (result.status !== 0 && !allowFailure) {
        const stderr = encoding === null ? result.stderr?.toString('utf8') : result.stderr;
        const stdout = encoding === null ? result.stdout?.toString('utf8') : result.stdout;
        fail(`${command} ${args.join(' ')} failed (${result.status})\n${stderr || stdout || ''}`.trimEnd());
    }
    return { ...result, elapsedMs };
}

function evaluatorGitEnvironment() {
    return {
        PATH: sanitizedPath(),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
    };
}

function git(source, args, options = {}) {
    const root = resolve(source);
    const safeConfig = [
        '-c', `core.worktree=${root}`,
        '-c', 'core.bare=false',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.attributesFile=/dev/null',
        '-c', 'core.excludesFile=/dev/null',
        '-c', 'commit.gpgSign=false',
        '-c', 'tag.gpgSign=false',
        '-c', 'protocol.file.allow=never',
    ];
    return run('/usr/bin/git', ['-C', root, ...safeConfig, ...args], {
        ...options,
        env: options.env ?? evaluatorGitEnvironment(),
    });
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

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function ensureInside(root, path) {
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) fail(`unsafe path outside ${root}: ${path}`);
}

function protocolAsset(protocolPath, rel) {
    if (!isNonEmptyString(rel) || rel.includes('\0')) fail(`invalid protocol asset path: ${rel}`);
    const root = dirname(protocolPath);
    const path = resolve(root, rel);
    ensureInside(root, path);
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        fail(`missing or unsafe protocol asset: ${rel}`);
    }
    return path;
}

export function validateProtocol(protocol, { requireLock = true } = {}) {
    if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) {
        fail('pipeline protocol must be an object');
    }
    if (protocol.version !== 1 || protocol.study_id !== 'songsiknow-full-pipeline-pilot-v1'
        || !isNonEmptyString(protocol.claim) || protocol.census_path !== 'CENSUS.md') {
        fail('pipeline protocol has an invalid identity');
    }
    const expectedArms = ['raw-direct', 'shaped-direct', 'full-cycle'];
    if (stableJson(protocol.arms?.map((arm) => arm.id)) !== stableJson(expectedArms)) {
        fail('pipeline protocol must freeze the three arms in order');
    }
    const schedule = protocol.schedule;
    if (!schedule || schedule.seed !== 'songsiknow-full-pipeline-pilot-v1-2026-08-30'
        || stableJson(schedule.case_order) !== stableJson(['sik-133', 'sik-131', 'sik-139', 'sik-123'])
        || schedule.arms_per_case !== 3 || schedule.cases_per_batch !== 1
        || schedule.invalid_case_retry_limit !== 1) {
        fail('pipeline protocol has an invalid frozen schedule');
    }
    const execution = protocol.execution;
    if (!execution || execution.model !== 'gpt-5.6-sol'
        || execution.reasoning_effort !== 'high'
        || execution.codex_version !== 'codex-cli 0.150.1'
        || !Number.isSafeInteger(execution.timeout_ms_per_turn)
        || execution.timeout_ms_per_turn < 1
        || execution.subagents !== false || execution.command_network !== false
        || stableJson(execution.full_cycle?.resumed_stages)
            !== stableJson(['implement', 'review', 'patch', 'done'])) {
        fail('pipeline protocol has an invalid execution contract');
    }
    if (!protocol.source || !/^[0-9a-f]{40}$/.test(protocol.source.pipeline_guidance_commit ?? '')
        || !Array.isArray(protocol.source.pipeline_guidance_paths)
        || !Array.isArray(protocol.source.excluded_fixture_paths)) {
        fail('pipeline protocol has an invalid source contract');
    }
    if (!protocol.prompts || !protocol.scoring || !protocol.privacy || !protocol.invalidation) {
        fail('pipeline protocol is missing prompt, scoring, privacy, or invalidation rules');
    }
    if (!Array.isArray(protocol.cases) || protocol.cases.length !== 4) {
        fail('pipeline protocol must freeze four cases');
    }
    const ids = new Set();
    for (const item of protocol.cases) {
        if (!isNonEmptyString(item.id) || ids.has(item.id)) fail(`invalid or duplicate case id: ${item.id}`);
        ids.add(item.id);
        if (!Number.isSafeInteger(item.issue)) fail(`case ${item.id} has an invalid issue number`);
        for (const key of ['base', 'repair']) {
            if (!/^[0-9a-f]{40}$/.test(item[key] ?? '')) fail(`case ${item.id} has invalid ${key}`);
        }
        for (const key of ['raw_prompt_path', 'canonical_issue_path', 'answer_sheet_path']) {
            if (!isNonEmptyString(item[key])) fail(`case ${item.id} is missing ${key}`);
        }
        if (!Array.isArray(item.repair_paths) || !item.repair_paths.length
            || !Array.isArray(item.oracle_paths) || !item.oracle_paths.length
            || !Array.isArray(item.oracle_commands) || !item.oracle_commands.length) {
            fail(`case ${item.id} is missing repair or oracle data`);
        }
    }
    if (stableJson([...ids]) !== stableJson(schedule.case_order)) {
        fail('pipeline case definitions must match the frozen case order');
    }
    if (!protocol.artifact_lock || typeof protocol.artifact_lock !== 'object') {
        fail('pipeline protocol is missing artifact_lock');
    }
    if (requireLock && stableJson(protocol.artifact_lock).includes('PENDING')) {
        fail('pipeline protocol artifact lock is not frozen');
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

function isExcluded(path, excluded) {
    return excluded.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function treeEntries(source, revision, excluded) {
    const key = stableJson([resolve(source), revision, excluded]);
    if (TREE_CACHE.has(key)) return TREE_CACHE.get(key);
    const listing = git(source, ['ls-tree', '-r', '-z', '--full-tree', revision]).stdout;
    const entries = [];
    for (const record of listing.split('\0').filter(Boolean)) {
        const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(record);
        if (!match) fail(`cannot parse source tree record at ${revision}`);
        const [, mode, type, object, path] = match;
        if (isExcluded(path, excluded)) continue;
        if (type !== 'blob' || mode === '120000') fail(`unsupported ${type} or symlink in source: ${path}`);
        const content = git(source, ['show', `${revision}:${path}`], { encoding: null }).stdout;
        entries.push({ mode, object, path, content });
    }
    TREE_CACHE.set(key, entries);
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

function patchBetween(source, from, to, paths) {
    const key = stableJson([resolve(source), from, to, paths]);
    if (PATCH_CACHE.has(key)) return PATCH_CACHE.get(key);
    const patch = git(source, [
        'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames',
        from, to, '--', ...paths,
    ], { encoding: null }).stdout;
    if (!patch.length) fail(`empty patch from ${from} to ${to} for ${paths.join(', ')}`);
    PATCH_CACHE.set(key, patch);
    return patch;
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

function repairParent(source, revision) {
    const parents = git(source, ['show', '-s', '--format=%P', revision]).stdout.trim().split(/\s+/).filter(Boolean);
    if (parents.length !== 1) fail(`repair ${revision} must have exactly one parent`);
    return parents[0];
}

export function verifySource(source, protocol) {
    const root = resolve(source);
    if (!existsSync(root) || !statSync(root).isDirectory()) fail(`source is not a directory: ${source}`);
    if (git(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).status !== 0) {
        fail(`source is not a Git repository: ${source}`);
    }
    const refs = new Set([
        protocol.source.pipeline_guidance_commit,
        ...protocol.cases.flatMap((item) => [item.base, item.repair]),
    ]);
    for (const revision of refs) {
        if (git(root, ['cat-file', '-e', `${revision}^{commit}`], { allowFailure: true }).status !== 0) {
            fail(`source is missing required commit ${revision}`);
        }
    }
    for (const item of protocol.cases) {
        if (repairParent(root, item.repair) !== item.base) {
            fail(`case ${item.id} repair is not a direct child of its frozen base`);
        }
    }
    const dependencies = join(root, 'node_modules');
    if (!existsSync(dependencies) || !lstatSync(dependencies).isDirectory()
        || lstatSync(dependencies).isSymbolicLink()) {
        fail(`source needs a physical node_modules tree: ${dependencies}`);
    }
    return root;
}

export function computeArtifactLock(protocol, protocolPath, source) {
    const root = verifySource(source, protocol);
    const lock = {
        runner_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
        fake_codex_sha256: sha256(readFileSync(DEFAULT_FAKE_CODEX)),
        fake_tracker_sha256: hashLocalFiles([join(FAKE_BIN, 'gh'), join(FAKE_BIN, 'fake-gh.cjs')]),
        fake_git_sha256: sha256(readFileSync(join(FAKE_BIN, 'git'))),
        census_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.census_path))),
        direct_prompt_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.prompts.direct_path))),
        stage_prompt_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.prompts.stage_path))),
        turn_schema_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.prompts.turn_schema_path))),
        score_schema_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.scoring.schema_path))),
        pipeline_guidance_sha256: hashNamedFiles(
            root,
            protocol.source.pipeline_guidance_commit,
            protocol.source.pipeline_guidance_paths,
        ),
        dependency_manifest_sha256: sha256(readFileSync(join(root, 'node_modules', '.package-lock.json'))),
        cases: {},
    };
    for (const item of protocol.cases) {
        const caseHash = createHash('sha256');
        const fields = {
            raw_prompt_sha256: sha256(readFileSync(protocolAsset(protocolPath, item.raw_prompt_path))),
            canonical_issue_sha256: sha256(readFileSync(protocolAsset(protocolPath, item.canonical_issue_path))),
            answer_sheet_sha256: sha256(readFileSync(protocolAsset(protocolPath, item.answer_sheet_path))),
            base_tree_sha256: treeDigest(treeEntries(root, item.base, protocol.source.excluded_fixture_paths)),
            repair_patch_sha256: sha256(patchBetween(root, item.base, item.repair, item.repair_paths)),
            oracle_patch_sha256: sha256(patchBetween(root, item.base, item.repair, item.oracle_paths)),
        };
        for (const [name, digest] of Object.entries(fields)) {
            caseHash.update(name);
            caseHash.update('\0');
            caseHash.update(digest);
            caseHash.update('\0');
        }
        lock.cases[item.id] = { ...fields, aggregate_sha256: caseHash.digest('hex') };
    }
    return lock;
}

function hashLocalFiles(paths) {
    const hash = createHash('sha256');
    for (const path of paths) {
        hash.update(relative(HERE, path));
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
    }
    return hash.digest('hex');
}

export function assertLocalArtifactLock(protocol, protocolPath) {
    const actual = {
        runner_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
        fake_codex_sha256: sha256(readFileSync(DEFAULT_FAKE_CODEX)),
        fake_tracker_sha256: hashLocalFiles([join(FAKE_BIN, 'gh'), join(FAKE_BIN, 'fake-gh.cjs')]),
        fake_git_sha256: sha256(readFileSync(join(FAKE_BIN, 'git'))),
        census_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.census_path))),
        direct_prompt_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.prompts.direct_path))),
        stage_prompt_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.prompts.stage_path))),
        turn_schema_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.prompts.turn_schema_path))),
        score_schema_sha256: sha256(readFileSync(protocolAsset(protocolPath, protocol.scoring.schema_path))),
    };
    for (const [key, digest] of Object.entries(actual)) {
        if (protocol.artifact_lock[key] !== digest) fail(`local artifact lock mismatch: ${key}`);
    }
    for (const item of protocol.cases) {
        const expected = protocol.artifact_lock.cases?.[item.id];
        const assets = {
            raw_prompt_sha256: sha256(readFileSync(protocolAsset(protocolPath, item.raw_prompt_path))),
            canonical_issue_sha256: sha256(readFileSync(protocolAsset(protocolPath, item.canonical_issue_path))),
            answer_sheet_sha256: sha256(readFileSync(protocolAsset(protocolPath, item.answer_sheet_path))),
        };
        for (const [key, digest] of Object.entries(assets)) {
            if (expected?.[key] !== digest) fail(`local artifact lock mismatch: ${item.id}.${key}`);
        }
    }
    return actual;
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

function writePipelineGuidance(destination, source, protocol) {
    for (const rel of protocol.source.pipeline_guidance_paths) {
        const path = resolve(destination, rel);
        ensureInside(destination, path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
            path,
            git(source, ['show', `${protocol.source.pipeline_guidance_commit}:${rel}`], { encoding: null }).stdout,
        );
    }
}

const NEUTRAL_AGENTS = `# Full-pipeline evaluation fixture

This is an isolated historical repository. Implement only the request supplied by the evaluator.
Do not use the network, inspect paths outside this repository, or invent a project workflow.
Run focused regression coverage and relevant local gates. Do not commit or push unless asked.
`;

function gitEnvironment(commitTime) {
    return {
        ...evaluatorGitEnvironment(),
        GIT_AUTHOR_NAME: 'Pipeline Fixture',
        GIT_AUTHOR_EMAIL: 'pipeline@example.invalid',
        GIT_COMMITTER_NAME: 'Pipeline Fixture',
        GIT_COMMITTER_EMAIL: 'pipeline@example.invalid',
        GIT_AUTHOR_DATE: commitTime,
        GIT_COMMITTER_DATE: commitTime,
    };
}

function initializeRepository(destination, commitTime) {
    const env = gitEnvironment(commitTime);
    const template = privateDirectory('cycle-pipeline-git-template-');
    try {
        run('/usr/bin/git', ['init', '-q', '--template', template, '-b', 'main'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'user.name', 'Pipeline Fixture'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'user.email', 'pipeline@example.invalid'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'core.logAllRefUpdates', 'false'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'core.hooksPath', '/dev/null'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'core.autocrlf', 'false'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'commit.gpgSign', 'false'], { cwd: destination, env });
        run('/usr/bin/git', ['add', '--', '.'], { cwd: destination, env });
        run('/usr/bin/git', ['commit', '-q', '--no-verify', '-m', 'fixture: frozen historical base'], {
            cwd: destination,
            env,
        });
        return git(destination, ['rev-parse', 'HEAD']).stdout.trim();
    } finally {
        rmSync(template, { recursive: true, force: true });
    }
}

function gitDirectoryIdentity(workspace) {
    const path = join(workspace, '.git');
    if (!existsSync(path)) fail('candidate repository lost its .git directory');
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail('candidate repository replaced its .git control directory');
    }
    return { dev: stat.dev, ino: stat.ino };
}

const SAFE_CANDIDATE_GIT_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = false
\thooksPath = /dev/null
\tautocrlf = false
[user]
\tname = Pipeline Candidate
\temail = candidate@example.invalid
[commit]
\tgpgSign = false
[tag]
\tgpgSign = false
`;

export function sanitizeCandidateRepository(workspace, expectedIdentity) {
    const gitDir = join(workspace, '.git');
    const actual = gitDirectoryIdentity(workspace);
    if (!expectedIdentity || actual.dev !== expectedIdentity.dev || actual.ino !== expectedIdentity.ino) {
        fail('candidate repository changed its .git control directory identity');
    }
    for (const rel of ['objects/info/alternates', 'info/grafts', 'shallow', 'logs']) {
        if (existsSync(join(gitDir, rel))) fail(`candidate repository created forbidden .git/${rel}`);
    }
    const queue = [gitDir];
    let entries = 0;
    while (queue.length) {
        const directory = queue.pop();
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            entries += 1;
            if (entries > MAX_GIT_CONTROL_ENTRIES) fail('candidate .git control tree is unexpectedly large');
            const path = join(directory, entry.name);
            if (entry.isDirectory()) queue.push(path);
            else if (entry.isFile()) {
                if (lstatSync(path).nlink !== 1) fail('candidate .git control tree contains a hard-linked file');
            } else {
                fail('candidate .git control tree contains a link or special file');
            }
        }
    }
    const config = join(gitDir, 'config');
    if (existsSync(config)) unlinkSync(config);
    writeFileSync(config, SAFE_CANDIDATE_GIT_CONFIG, { flag: 'wx', mode: 0o600 });
    return actual;
}

export function assertHistoryTruncated(workspace, forbiddenCommits = [], {
    expectedCommitCount = null,
    expectedRoot = null,
} = {}) {
    const commits = git(workspace, ['rev-list', '--all']).stdout.trim().split('\n').filter(Boolean);
    if (!commits.length) fail('fixture repository has no commit');
    if (expectedCommitCount !== null && commits.length !== expectedCommitCount) {
        fail(`fixture repository has ${commits.length} commits instead of ${expectedCommitCount}`);
    }
    const roots = git(workspace, ['rev-list', '--max-parents=0', '--all']).stdout.trim().split('\n').filter(Boolean);
    if (expectedRoot && stableJson(roots) !== stableJson([expectedRoot])) {
        fail('candidate history no longer has exactly the frozen base root');
    }
    if (git(workspace, ['remote']).stdout.trim()) fail('fixture repository has a remote');
    if (git(workspace, ['tag', '--list']).stdout.trim()) fail('fixture repository has tags');
    const refs = git(workspace, ['for-each-ref', '--format=%(refname)']).stdout.trim().split('\n').filter(Boolean);
    if (refs.some((ref) => !ref.startsWith('refs/heads/'))) fail('fixture repository has a non-local-branch ref');
    const alternates = join(workspace, '.git', 'objects', 'info', 'alternates');
    if (existsSync(alternates)) fail('fixture repository has object alternates');
    for (const rel of ['.git/shallow', '.git/logs']) {
        if (existsSync(join(workspace, rel))) fail(`fixture repository unexpectedly contains ${rel}`);
    }
    for (const revision of forbiddenCommits) {
        if (git(workspace, ['cat-file', '-e', `${revision}^{commit}`], { allowFailure: true }).status === 0) {
            fail(`fixture contains forbidden historical object ${revision}`);
        }
    }
    return { commits: commits.length, remotes: 0, tags: 0, alternates: false };
}

function writeFixtureMetadata(destination, protocol, protocolPath, mode) {
    mkdirSync(join(destination, '.pipeline-eval'), { recursive: true });
    writeFileSync(
        join(destination, '.pipeline-eval', 'turn.schema.json'),
        readFileSync(protocolAsset(protocolPath, protocol.prompts.turn_schema_path)),
    );
    if (mode === 'neutral') writeFileSync(join(destination, 'AGENTS.md'), NEUTRAL_AGENTS);
}

export function materializeFixture({
    protocol,
    protocolPath,
    source,
    caseId,
    mode,
    destination,
    dependencies = false,
}) {
    const item = protocol.cases.find((entry) => entry.id === caseId);
    if (!item) fail(`unknown case: ${caseId}`);
    mkdirSync(destination, { recursive: true });
    const entries = treeEntries(source, item.base, protocol.source.excluded_fixture_paths);
    writeTree(destination, entries);
    if (mode === 'pipeline') writePipelineGuidance(destination, source, protocol);
    writeFixtureMetadata(destination, protocol, protocolPath, mode);
    const initialCommit = initializeRepository(destination, protocol.execution.fixture_commit_time);
    const history = assertHistoryTruncated(
        destination,
        [item.repair, protocol.source.pipeline_guidance_commit],
        { expectedCommitCount: 1, expectedRoot: initialCommit },
    );
    const dependency = dependencies ? cloneDependencies(source, destination) : null;
    if (git(destination, ['status', '--porcelain=v1']).stdout.trim()) {
        fail(`fixture ${caseId} is dirty immediately after materialization`);
    }
    return {
        item,
        initial_commit: initialCommit,
        git_directory: gitDirectoryIdentity(destination),
        base_tree_sha256: treeDigest(entries),
        history,
        dependency,
    };
}

function cloneDependencies(source, destination) {
    const from = join(source, 'node_modules');
    const to = join(destination, 'node_modules');
    run('/bin/cp', ['-a', '--reflink=never', from, to]);
    const sourceStat = lstatSync(from);
    const targetStat = lstatSync(to);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()
        || (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)) {
        fail('dependency root is not physically isolated');
    }
    const sourceManifest = join(from, '.package-lock.json');
    const targetManifest = join(to, '.package-lock.json');
    if (!existsSync(sourceManifest) || !existsSync(targetManifest)) {
        fail('dependency tree is missing its npm lock manifest');
    }
    if (readlinkEscapes(to)) fail('dependency tree contains a symlink that escapes its physical root');
    return {
        method: 'full physical copy',
        source_manifest_sha256: sha256(readFileSync(sourceManifest)),
        target_manifest_sha256: sha256(readFileSync(targetManifest)),
        root_inode_distinct: true,
    };
}

function readlinkEscapes(root) {
    const queue = [root];
    const realRoot = realpathSync(root);
    while (queue.length) {
        const directory = queue.pop();
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) queue.push(path);
            else if (entry.isSymbolicLink()) {
                const target = resolve(dirname(path), readlinkSync(path));
                const rel = relative(realRoot, target);
                if (rel === '..' || rel.startsWith(`..${sep}`)) return true;
            }
        }
    }
    return false;
}

function materializeDryFixture({ protocol, protocolPath, caseId, mode, destination }) {
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'package.json'), `${JSON.stringify({
        name: `pipeline-dry-${caseId}`,
        private: true,
        scripts: { test: 'node --test test.mjs' },
    }, null, 2)}\n`);
    writeFileSync(join(destination, 'test.mjs'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('dry fixture', () => assert.equal(1, 1));",
        '',
    ].join('\n'));
    if (mode === 'pipeline') {
        writeFileSync(join(destination, 'AGENTS.md'), '# Dry full-pipeline fixture\nUse the frozen skills.\n');
        for (const stage of ['intake', 'implement', 'review', 'patch', 'done']) {
            const path = join(destination, '.agents', 'skills', stage, 'SKILL.md');
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, `# ${stage}\nDry lifecycle skill.\n`);
        }
    }
    writeFixtureMetadata(destination, protocol, protocolPath, mode);
    const initialCommit = initializeRepository(destination, protocol.execution.fixture_commit_time);
    return {
        item: protocol.cases.find((entry) => entry.id === caseId),
        initial_commit: initialCommit,
        git_directory: gitDirectoryIdentity(destination),
        base_tree_sha256: 'dry-fixture',
        history: assertHistoryTruncated(destination, [], {
            expectedCommitCount: 1,
            expectedRoot: initialCommit,
        }),
        dependency: null,
    };
}

function sanitizedPath(pathValue = process.env.PATH ?? '/usr/bin:/bin') {
    return pathValue.split(':').filter((entry) => entry && !entry.includes('\n') && !entry.includes('\0')).join(':');
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
    if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`private path is not a physical directory: ${path}`);
    } else {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`private path is not a physical directory: ${path}`);
    }
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
        // The full non-JSON auth file fingerprint remains protected.
    }
    for (const value of values) {
        const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
        if ([...fingerprints].some((fingerprint) => text.includes(fingerprint))) {
            fail('model output contained authentication material; raw output was not written');
        }
    }
}

export function pipelineConfig({
    workspace,
    codexBin,
    issueBody = '',
    issueTitle = '',
    pathValue = process.env.PATH,
}) {
    const workspacePath = existsSync(workspace) ? realpathSync(workspace) : resolve(workspace);
    const nodeExecutable = resolveExecutable('node', pathValue);
    const cellarMarker = `${sep}Cellar${sep}`;
    const nodeRuntimeRoot = nodeExecutable.includes(cellarMarker)
        ? nodeExecutable.slice(0, nodeExecutable.indexOf(cellarMarker))
        : nodeExecutable;
    const readable = [...new Set([
        resolveExecutable(codexBin),
        nodeRuntimeRoot,
        realpathSync(FAKE_BIN),
    ])].sort().map((path) => `${JSON.stringify(path)} = "read"`).join('\n');
    const commandPath = `${FAKE_BIN}:${sanitizedPath(pathValue)}`;
    const trackerEnvironment = issueBody || issueTitle ? [
        `CYCLE_PIPELINE_ISSUE_BODY_BASE64 = ${JSON.stringify(Buffer.from(issueBody).toString('base64'))}`,
        `CYCLE_PIPELINE_ISSUE_TITLE = ${JSON.stringify(issueTitle)}`,
        'CYCLE_PIPELINE_ISSUE_LABEL = "status:ready"',
        '',
    ].join('\n') : '';
    return `approval_policy = "never"
default_permissions = "pipeline-fixture"
allow_login_shell = false
web_search = "disabled"
check_for_update_on_startup = false
file_opener = "none"

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

[permissions.pipeline-fixture.filesystem]
":root" = "deny"
":minimal" = "read"
${JSON.stringify(workspacePath)} = "write"
${readable}

[permissions.pipeline-fixture.network]
enabled = false

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false

[shell_environment_policy.set]
HOME = "/nonexistent"
PATH = ${JSON.stringify(commandPath)}
LANG = "C.UTF-8"
LC_ALL = "C.UTF-8"
NO_COLOR = "1"
CI = "1"
GIT_CONFIG_NOSYSTEM = "1"
GIT_CONFIG_GLOBAL = "/dev/null"
GIT_AUTHOR_NAME = "Pipeline Candidate"
GIT_AUTHOR_EMAIL = "candidate@example.invalid"
GIT_COMMITTER_NAME = "Pipeline Candidate"
GIT_COMMITTER_EMAIL = "candidate@example.invalid"
${trackerEnvironment}
`;
}

export function createClientHome({
    codexHome,
    includeAuth,
    codexBin,
    workspace,
    issueBody,
    issueTitle,
}) {
    const home = privateDirectory('cycle-pipeline-codex-home-');
    writeFileSync(join(home, 'config.toml'), pipelineConfig({
        workspace,
        codexBin,
        issueBody,
        issueTitle,
    }), { mode: 0o600 });
    if (includeAuth) {
        const source = resolveAuthPath(codexHome);
        if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
            rmSync(home, { recursive: true, force: true });
            fail(`Codex authentication is unavailable at ${source}`);
        }
        symlinkSync(source, join(home, 'auth.json'));
    }
    return home;
}

export function clientEnvironment({
    clientHome,
    scratch,
    caseId,
    arm,
    stage,
    attempt,
    turn,
    sessionId,
    issueBody = '',
    issueTitle = '',
    canonicalIssue = '',
}, ambient = process.env) {
    const env = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
        if (ambient[key]) env[key] = ambient[key];
    }
    env.PATH = `${FAKE_BIN}:${sanitizedPath(env.PATH)}`;
    env.HOME = clientHome;
    env.CODEX_HOME = clientHome;
    env.TMPDIR = scratch;
    env.NO_COLOR = '1';
    env.CYCLE_PIPELINE_CASE = caseId;
    env.CYCLE_PIPELINE_ARM = arm;
    env.CYCLE_PIPELINE_STAGE = stage;
    env.CYCLE_PIPELINE_ATTEMPT = String(attempt);
    env.CYCLE_PIPELINE_TURN = String(turn);
    env.CYCLE_PIPELINE_SESSION_ID = sessionId;
    env.CYCLE_PIPELINE_ISSUE_BODY_BASE64 = Buffer.from(issueBody).toString('base64');
    env.CYCLE_PIPELINE_ISSUE_TITLE = issueTitle;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = '/dev/null';
    env.GIT_AUTHOR_NAME = 'Pipeline Candidate';
    env.GIT_AUTHOR_EMAIL = 'candidate@example.invalid';
    env.GIT_COMMITTER_NAME = 'Pipeline Candidate';
    env.GIT_COMMITTER_EMAIL = 'candidate@example.invalid';
    if (canonicalIssue) env.CYCLE_PIPELINE_CANONICAL_ISSUE_BASE64 = Buffer.from(canonicalIssue).toString('base64');
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

function finalAgentText(events) {
    return events.findLast((event) => event.type === 'item.completed'
        && event.item?.type === 'agent_message' && typeof event.item.text === 'string')?.item.text ?? null;
}

export function validateTurnText(text) {
    if (!text) return { invalid: 'missing final structured response', value: null };
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        return { invalid: 'final response is not JSON', value: null };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || stableJson(Object.keys(value).sort()) !== stableJson(['question', 'status', 'summary'])
        || !['needs-input', 'complete'].includes(value.status)
        || typeof value.question !== 'string' || typeof value.summary !== 'string'
        || (value.status === 'needs-input' && !value.question.trim())
        || (value.status === 'complete' && value.question !== '')) {
        return { invalid: 'final response does not match turn.schema.json', value: null };
    }
    return { invalid: null, value };
}

function usageSum(turns) {
    const totals = {};
    let reportedTurns = 0;
    for (const turn of turns) {
        if (!turn.usage || typeof turn.usage !== 'object') continue;
        reportedTurns += 1;
        for (const [key, value] of Object.entries(turn.usage)) {
            if (typeof value === 'number' && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
        }
    }
    return { reported_turns: reportedTurns, totals };
}

function answerSheet(protocolPath, item) {
    let sheet;
    try {
        sheet = JSON.parse(readFileSync(protocolAsset(protocolPath, item.answer_sheet_path), 'utf8'));
    } catch (error) {
        fail(`invalid answer sheet for ${item.id}: ${error.message}`);
    }
    if (sheet.case_id !== item.id || !Number.isSafeInteger(sheet.max_followups_per_stage)
        || sheet.max_followups_per_stage < 0 || !Array.isArray(sheet.rules)
        || typeof sheet.default_answer !== 'string') {
        fail(`answer sheet for ${item.id} has an invalid shape`);
    }
    return sheet;
}

export function scriptedAnswer(sheet, question) {
    for (const rule of sheet.rules) {
        if (!isNonEmptyString(rule.id) || !isNonEmptyString(rule.question_regex)
            || typeof rule.answer !== 'string') fail(`invalid answer rule in ${sheet.case_id}`);
        let expression;
        try { expression = new RegExp(rule.question_regex, 'i'); }
        catch { fail(`invalid question regex ${rule.id} in ${sheet.case_id}`); }
        if (expression.test(question)) return { rule_id: rule.id, answer: rule.answer };
    }
    if (sheet.default_answer) return { rule_id: 'default', answer: sheet.default_answer };
    return null;
}

function decodeTrackerField(encoded, label) {
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
        fail(`fake tracker returned an invalid ${label} marker`);
    }
    return decoded.toString('utf8');
}

export function trackerCreates(turns) {
    const creates = [];
    for (const turn of turns) {
        for (const event of turn.events) {
            if (event.type !== 'item.completed' || event.item?.type !== 'command_execution') continue;
            const output = String(event.item.aggregated_output ?? '');
            let pending = null;
            for (const line of output.split('\n')) {
                if (line.startsWith('CYCLE_PIPELINE_TRACKER_CREATE:')) {
                    if (pending !== null) creates.push(pending);
                    pending = { body: decodeTrackerField(
                        line.slice('CYCLE_PIPELINE_TRACKER_CREATE:'.length),
                        'issue-body',
                    ), title: null };
                }
                if (line.startsWith('CYCLE_PIPELINE_TRACKER_TITLE:')) {
                    const title = decodeTrackerField(
                        line.slice('CYCLE_PIPELINE_TRACKER_TITLE:'.length),
                        'issue-title',
                    );
                    if (pending === null || pending.title !== null) creates.push({ body: null, title });
                    else pending.title = title;
                }
            }
            if (pending !== null) creates.push(pending);
        }
    }
    return creates;
}

function issueEnvelope(title, body) {
    return `Issue title:\n${title}\n\nIssue body:\n${body}`;
}

function issueEnvelopeHash(title, body) {
    return sha256(Buffer.concat([Buffer.from(title), Buffer.from([0]), Buffer.from(body)]));
}

function commandEvidence(turns, workspace) {
    return turns.flatMap((turn) => turn.events
        .filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution')
        .map((event) => ({
            stage: turn.stage,
            command: String(event.item.command ?? '').split(workspace).join('<workspace>'),
            exit_code: event.item.exit_code ?? null,
        })));
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

export function runStrictConfigProbe({ codexBin, clientHome, workspace, scratch }) {
    const result = run(codexBin, ['app-server', '--strict-config', '--listen', 'off'], {
        cwd: workspace,
        env: {
            PATH: sanitizedPath(),
            LANG: 'C.UTF-8',
            HOME: clientHome,
            CODEX_HOME: clientHome,
            TMPDIR: scratch,
        },
        allowFailure: true,
        timeout: 30_000,
    });
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status !== 1 || !/no transport configured/i.test(combined)) {
        fail(`strict pipeline-config probe failed (${result.status})\n${combined}`.trimEnd());
    }
    return { strict_config: 'pass', authentication: 'absent', model_calls: 0 };
}

export function probePipelineConfig(codexBin = 'codex') {
    const root = privateDirectory('cycle-pipeline-config-probe-');
    const workspace = join(root, 'workspace');
    const scratch = join(root, 'scratch');
    mkdirSync(workspace);
    mkdirSync(scratch);
    let clientHome;
    try {
        clientHome = createClientHome({
            includeAuth: false,
            codexBin,
            workspace,
            issueBody: '',
            issueTitle: 'Probe',
        });
        if (existsSync(join(clientHome, 'auth.json'))) fail('config probe unexpectedly contains authentication');
        return runStrictConfigProbe({ codexBin, clientHome, workspace, scratch });
    } finally {
        if (clientHome) rmSync(clientHome, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
}

export function probeIsolation(codexBin = 'codex') {
    const root = privateDirectory('cycle-pipeline-isolation-');
    const workspace = join(root, 'workspace');
    const scratch = privateDirectory('cycle-pipeline-isolation-tmp-');
    let clientHome;
    let loopback;
    try {
        mkdirSync(workspace);
        writeFileSync(join(workspace, 'allowed.txt'), 'allowed\n');
        clientHome = createClientHome({
            includeAuth: false,
            codexBin,
            workspace,
            issueBody: 'probe body',
            issueTitle: 'Probe',
        });
        const deniedNames = ['source', 'evaluator', 'sibling', 'oracle'];
        const denied = deniedNames.map((name) => {
            const path = join(root, `${name}.sentinel`);
            writeFileSync(path, `${name}\n`);
            return path;
        });
        const homeSentinel = join(clientHome, 'client-home.sentinel');
        writeFileSync(homeSentinel, 'client-home\n', { mode: 0o600 });
        denied.push(homeSentinel);
        loopback = startLoopbackProbe(root);
        const fakeWrite = join(FAKE_BIN, '.pipeline-write-probe');
        const script = [
            'test -r allowed.txt || exit 10',
            'printf changed > allowed.txt || exit 11',
            'test "$(cat allowed.txt)" = changed || exit 12',
            'git --version >/dev/null || exit 13',
            'gh --version >/dev/null || exit 14',
            `if printf denied > ${JSON.stringify(fakeWrite)} 2>/dev/null; then exit 15; fi`,
            `if /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/${loopback.port}' 2>/dev/null; then exit 30; fi`,
            'shift',
            'for path do test ! -r "$path" || exit 20; done',
        ].join('; ');
        const env = {
            PATH: `${FAKE_BIN}:${sanitizedPath()}`,
            LANG: 'C.UTF-8',
            HOME: clientHome,
            CODEX_HOME: clientHome,
            TMPDIR: scratch,
        };
        const result = run(codexBin, [
            'sandbox', '--permission-profile', 'pipeline-fixture', '--cd', workspace,
            '/bin/sh', '-c', script, 'probe', ...denied,
        ], { cwd: workspace, env, allowFailure: true, timeout: 30_000 });
        if (existsSync(fakeWrite)) {
            unlinkSync(fakeWrite);
            fail('pipeline isolation probe wrote to evaluator assets');
        }
        if (result.status !== 0) {
            fail(`Codex pipeline isolation probe failed (${result.status})\n${result.stderr || result.stdout || ''}`.trimEnd());
        }
        return {
            candidate_workspace_read_write: true,
            evaluator_assets_read_only: true,
            denied_host_loopback_listener: true,
            denied_host_sentinels: [...deniedNames, 'client-home'],
            command_network: false,
            filesystem_profile_sha256: sha256(pipelineConfig({
                workspace: '/fixture',
                codexBin: resolveExecutable(codexBin),
                issueBody: '',
                issueTitle: 'Probe',
            })
                .replaceAll(realpathSync(FAKE_BIN), '/evaluator/bin')
                .replaceAll(workspace, '/fixture')),
        };
    } finally {
        if (loopback) loopback.stop();
        if (clientHome) rmSync(clientHome, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
    }
}

function turnPrompt(protocol, protocolPath, { stage, rawRequest, shapedIssue }) {
    if (stage === 'intake') {
        return [
            `$intake ${rawRequest.trim()}`,
            '',
            'This is a frozen evaluation session. Interview one question at a time, draft an actionable',
            'issue, and file exactly one issue through gh when approved. Return only the requested',
            'structured status object at the end of each turn.',
        ].join('\n');
    }
    if (stage === 'direct') {
        const common = readFileSync(protocolAsset(protocolPath, protocol.prompts.direct_path), 'utf8').trim();
        return `${common}\n\nUser request:\n${shapedIssue ?? rawRequest}`;
    }
    const common = readFileSync(protocolAsset(protocolPath, protocol.prompts.stage_path), 'utf8').trim();
    const invocation = stage === 'implement' ? '$implement #1'
        : stage === 'done' ? '$done #1'
            : `$${stage}`;
    return `${invocation}\n\n${common}\n\nRequested stage: ${stage}`;
}

function invokeTurn({
    protocol,
    output,
    workspace,
    runDir,
    codexBin,
    model,
    effort,
    timeoutMs,
    clientHome,
    scratch,
    authPath,
    caseId,
    arm,
    stage,
    attempt,
    turn,
    sessionId,
    threadId,
    prompt,
    issueBody,
    issueTitle,
    canonicalIssue,
}) {
    const schema = join(workspace, '.pipeline-eval', 'turn.schema.json');
    const common = [
        '--json', '--strict-config', '--ignore-rules',
        '--model', model,
        '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
        '--output-schema', schema,
    ];
    const args = threadId
        ? ['exec', 'resume', ...common, threadId, prompt]
        : ['exec', ...common, '--cd', workspace, prompt];
    const env = clientEnvironment({
        clientHome,
        scratch,
        caseId,
        arm,
        stage,
        attempt,
        turn,
        sessionId,
        issueBody,
        issueTitle,
        canonicalIssue,
    });
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
    assertNoCredentialMaterial([stdout, stderr], authPath);
    const turnName = `${stage}-${String(turn).padStart(2, '0')}`;
    const turnDir = join(runDir, 'turns', arm, turnName);
    privateWrite(join(turnDir, 'events.jsonl'), stdout);
    privateWrite(join(turnDir, 'stderr.txt'), stderr);
    const parsed = parseExecEvents(stdout);
    const finalText = finalAgentText(parsed.events);
    if (finalText !== null) privateWrite(join(turnDir, 'final.json'), `${finalText}\n`);
    const structured = validateTurnText(finalText);
    const invalid = [];
    if (processResult.status !== 0) invalid.push(`Codex exited ${processResult.status}`);
    if (parsed.invalid) invalid.push(parsed.invalid);
    const started = parsed.events.some((event) => event.type === 'turn.started');
    const completed = parsed.events.some((event) => event.type === 'turn.completed');
    if (!started) invalid.push('missing turn.started');
    if (!completed) invalid.push('missing turn.completed');
    if (structured.invalid) invalid.push(structured.invalid);
    const eventThreadIds = parsed.events
        .filter((event) => event.type === 'thread.started' && isNonEmptyString(event.thread_id))
        .map((event) => event.thread_id);
    const actualThreadId = eventThreadIds[0] ?? threadId;
    if (!actualThreadId) invalid.push('missing thread.started thread id');
    if (threadId && eventThreadIds.some((value) => value !== threadId)) invalid.push('resumed thread id changed');
    return {
        stage,
        turn,
        thread_id: actualThreadId ?? null,
        started_at: startedAt,
        finished_at: finishedAt,
        elapsed_ms: processResult.elapsedMs,
        exit_code: processResult.status,
        model_turn_started: started,
        model_turn_completed: completed,
        usage: parsed.usage,
        response: structured.value,
        invalid_reasons: invalid,
        events: parsed.events,
        artifacts: {
            events: relative(output, join(turnDir, 'events.jsonl')),
            stderr: relative(output, join(turnDir, 'stderr.txt')),
            final: finalText === null ? null : relative(output, join(turnDir, 'final.json')),
        },
    };
}

function runLifecycle({
    protocol,
    protocolPath,
    output,
    item,
    workspace,
    runDir,
    codexBin,
    model,
    effort,
    timeoutMs,
    codexHome,
    dryRun,
    arm,
    stage,
    attempt,
    prompt,
    issueBody = '',
    issueTitle = '',
    canonicalIssue = '',
    threadId = null,
    sessionId,
    sessionContext = null,
}) {
    const ownsSession = sessionContext === null;
    const scratch = sessionContext?.scratch ?? privateDirectory('cycle-pipeline-client-tmp-');
    const authPath = sessionContext?.authPath ?? (dryRun ? null : resolveAuthPath(codexHome));
    const clientHome = sessionContext?.clientHome ?? createClientHome({
        codexHome, includeAuth: !dryRun, codexBin, workspace, issueBody, issueTitle,
    });
    const sheet = answerSheet(protocolPath, item);
    const turns = [];
    let currentPrompt = prompt;
    let currentThread = threadId;
    try {
        for (let turn = 1; turn <= sheet.max_followups_per_stage + 1; turn += 1) {
            const result = invokeTurn({
                protocol,
                output,
                workspace,
                runDir,
                codexBin,
                model,
                effort,
                timeoutMs,
                clientHome,
                scratch,
                authPath,
                caseId: item.id,
                arm,
                stage,
                attempt,
                turn,
                sessionId,
                threadId: currentThread,
                prompt: currentPrompt,
                issueBody,
                issueTitle,
                canonicalIssue: dryRun ? canonicalIssue : '',
            });
            turns.push(result);
            if (result.invalid_reasons.length) break;
            if (!currentThread) currentThread = result.thread_id;
            if (result.response.status === 'complete') break;
            if (turn > sheet.max_followups_per_stage) {
                result.invalid_reasons.push('follow-up limit exceeded');
                break;
            }
            const selected = scriptedAnswer(sheet, result.response.question);
            if (!selected) {
                result.invalid_reasons.push('question did not match the frozen answer sheet');
                break;
            }
            result.answer_rule = selected.rule_id;
            currentPrompt = selected.answer;
        }
    } finally {
        if (ownsSession) {
            rmSync(clientHome, { recursive: true, force: true });
            rmSync(scratch, { recursive: true, force: true });
        }
    }
    if (turns.length && !turns.some((turn) => turn.invalid_reasons.length)
        && turns.at(-1).response?.status !== 'complete') {
        turns.at(-1).invalid_reasons.push('stage did not complete');
    }
    return {
        stage,
        thread_id: currentThread,
        turns,
        valid: turns.length > 0 && turns.every((turn) => turn.invalid_reasons.length === 0)
            && turns.at(-1).response?.status === 'complete',
        usage: usageSum(turns),
    };
}

function untrackedPaths(workspace) {
    return git(workspace, ['ls-files', '--others', '--exclude-standard', '-z']).stdout
        .split('\0').filter(Boolean).sort();
}

function combinedDiff(workspace, initialCommit) {
    const tracked = git(workspace, [
        'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', initialCommit,
    ], { encoding: null }).stdout;
    const chunks = [tracked];
    for (const rel of untrackedPaths(workspace)) {
        const path = resolve(workspace, rel);
        ensureInside(workspace, path);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`candidate created an unsafe untracked path: ${rel}`);
        if (stat.size > MAX_CAPTURE_FILE) fail(`candidate untracked file is too large to capture: ${rel}`);
        const result = run('/usr/bin/git', [
            'diff', '--no-index', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
            '--no-renames', '/dev/null', rel,
        ], {
            cwd: workspace,
            encoding: null,
            allowFailure: true,
            env: evaluatorGitEnvironment(),
        });
        if (result.status !== 1) fail(`cannot capture untracked candidate file: ${rel}`);
        chunks.push(result.stdout);
    }
    return Buffer.concat(chunks);
}

function changedPaths(workspace, initialCommit) {
    const tracked = git(workspace, ['diff', '--name-only', '-z', initialCommit]).stdout
        .split('\0').filter(Boolean);
    return [...new Set([...tracked, ...untrackedPaths(workspace)])].sort();
}

function snapshotWorkspace({ output, runDir, workspace, fixture, arm, stage }) {
    sanitizeCandidateRepository(workspace, fixture.git_directory);
    const path = join(runDir, 'snapshots', arm, `${stage}.diff`);
    const diff = combinedDiff(workspace, fixture.initial_commit);
    privateWrite(path, diff);
    return {
        stage,
        diff: relative(output, path),
        diff_sha256: sha256(diff),
        changed_paths: changedPaths(workspace, fixture.initial_commit),
    };
}

function applySourceFiles(source, revision, paths, destination) {
    for (const rel of paths) {
        const exists = git(source, ['cat-file', '-e', `${revision}:${rel}`], { allowFailure: true }).status === 0;
        const path = resolve(destination, rel);
        ensureInside(destination, path);
        if (!exists) {
            rmSync(path, { recursive: true, force: true });
            continue;
        }
        const mode = git(source, ['ls-tree', revision, '--', rel]).stdout.trim().split(/\s+/)[0];
        if (!['100644', '100755'].includes(mode)) fail(`unsupported verifier source mode for ${rel}`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, git(source, ['show', `${revision}:${rel}`], { encoding: null }).stdout);
        chmodSync(path, mode === '100755' ? 0o755 : 0o644);
    }
}

function candidateFiles(workspace) {
    return git(workspace, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).stdout
        .split('\0').filter(Boolean).sort();
}

const VERIFIER_EXCLUDES = [
    '.agents', '.claude', '.codex', '.cycle', '.git', '.pipeline-eval',
    'AGENTS.md', 'CLAUDE.md', 'node_modules',
];

const VERIFIER_CONTROL_PATHS = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vitest.config.ts',
];

function copyCandidateSource(workspace, destination) {
    mkdirSync(destination, { recursive: true });
    for (const rel of candidateFiles(workspace)) {
        if (isExcluded(rel, VERIFIER_EXCLUDES)) continue;
        const sourcePath = resolve(workspace, rel);
        ensureInside(workspace, sourcePath);
        const stat = lstatSync(sourcePath);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`candidate source contains an unsafe path: ${rel}`);
        if (stat.size > MAX_CAPTURE_FILE) fail(`candidate source file is too large for verifier: ${rel}`);
        const target = resolve(destination, rel);
        ensureInside(destination, target);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(sourcePath));
        chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
    }
}

function restoreVerifierControls(source, base, destination) {
    for (const entry of readdirSync(destination)) {
        if (/^(?:vite|vitest)\.config\.(?:js|cjs|mjs|ts|cts|mts)$/.test(entry)) {
            rmSync(join(destination, entry), { recursive: true, force: true });
        }
    }
    applySourceFiles(source, base, VERIFIER_CONTROL_PATHS, destination);
}

function sandboxedCommand({ codexBin, workspace, command, timeoutMs }) {
    const scratch = privateDirectory('cycle-pipeline-verifier-tmp-');
    const clientHome = createClientHome({
        includeAuth: false,
        codexBin,
        workspace,
        issueBody: '',
        issueTitle: 'Hidden verifier',
    });
    try {
        const env = {
            PATH: `${FAKE_BIN}:${sanitizedPath()}`,
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            HOME: clientHome,
            CODEX_HOME: clientHome,
            TMPDIR: scratch,
            NO_COLOR: '1',
        };
        return run(codexBin, [
            'sandbox', '--permission-profile', 'pipeline-fixture', '--cd', workspace,
            '/bin/sh', '-c', command,
        ], { cwd: workspace, env, allowFailure: true, timeout: timeoutMs });
    } finally {
        rmSync(clientHome, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
    }
}

function runOracleCommands({ codexBin, workspace, commands, timeoutMs }) {
    const records = [];
    let status = 0;
    for (const command of commands) {
        const result = sandboxedCommand({ codexBin, workspace, command, timeoutMs });
        records.push({
            command,
            status: result.status,
            elapsed_ms: result.elapsedMs,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
        });
        if (result.status !== 0) {
            status = result.status ?? 2;
            break;
        }
    }
    return { status, records };
}

function oracleFailure(result) {
    const failed = result.records.find((record) => record.status !== 0) ?? result.records.at(-1);
    if (!failed) return 'no oracle command ran';
    return `${failed.command} (${failed.status})\n${failed.stderr || failed.stdout || ''}`.trimEnd();
}

function verifyFrozenOracle({ protocol, protocolPath, source, item, codexBin }) {
    const root = privateDirectory(`cycle-pipeline-oracle-${item.id}-`);
    const workspace = join(root, 'workspace');
    try {
        materializeFixture({
            protocol,
            protocolPath,
            source,
            caseId: item.id,
            mode: 'neutral',
            destination: workspace,
            dependencies: true,
        });
        applySourceFiles(source, item.repair, item.oracle_paths, workspace);
        const base = runOracleCommands({
            codexBin,
            workspace,
            commands: item.oracle_commands,
            timeoutMs: protocol.execution.timeout_ms_per_turn,
        });
        if (base.status === 0) fail(`case ${item.id} hidden oracle unexpectedly passed on the base`);
        applySourceFiles(source, item.repair, item.repair_paths, workspace);
        const repaired = runOracleCommands({
            codexBin,
            workspace,
            commands: item.oracle_commands,
            timeoutMs: protocol.execution.timeout_ms_per_turn,
        });
        if (repaired.status !== 0) {
            fail(`case ${item.id} hidden oracle stayed red after repair\n${oracleFailure(repaired)}`);
        }
        applySourceFiles(source, item.base, item.repair_paths, workspace);
        const mutation = runOracleCommands({
            codexBin,
            workspace,
            commands: item.oracle_commands,
            timeoutMs: protocol.execution.timeout_ms_per_turn,
        });
        if (mutation.status === 0) fail(`case ${item.id} mutation proof did not turn the hidden oracle red`);
        return {
            case_id: item.id,
            hidden_oracle_on_base: 'fail',
            hidden_oracle_after_repair: 'pass',
            accepted_repair_removed_mutation: 'fail',
        };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function verifyCandidate({ protocol, source, item, workspace, codexBin }) {
    const root = privateDirectory(`cycle-pipeline-candidate-verifier-${item.id}-`);
    const verifier = join(root, 'workspace');
    try {
        copyCandidateSource(workspace, verifier);
        restoreVerifierControls(source, item.base, verifier);
        cloneDependencies(source, verifier);
        applySourceFiles(source, item.repair, item.oracle_paths, verifier);
        const result = runOracleCommands({
            codexBin,
            workspace: verifier,
            commands: item.oracle_commands,
            timeoutMs: protocol.execution.timeout_ms_per_turn,
        });
        return {
            status: result.status === 0 ? 'pass' : 'fail',
            commands: result.records.map((record) => ({
                command: record.command,
                status: record.status,
                elapsed_ms: record.elapsed_ms,
            })),
            private_output: result.records.map((record) => ({
                command: record.command,
                stdout: record.stdout,
                stderr: record.stderr,
            })),
        };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function scanChangedFilesForCredentials(workspace, initialCommit, authPath) {
    if (!authPath) return;
    const values = [];
    for (const rel of changedPaths(workspace, initialCommit)) {
        const path = resolve(workspace, rel);
        ensureInside(workspace, path);
        if (!existsSync(path)) continue;
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`candidate changed an unsafe path: ${rel}`);
        if (stat.size <= MAX_CAPTURE_FILE) values.push(readFileSync(path));
    }
    const newObjects = git(workspace, [
        'rev-list', '--objects', '--all', '--not', initialCommit,
    ]).stdout.trim().split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
    for (const object of new Set(newObjects)) {
        if (git(workspace, ['cat-file', '-t', object]).stdout.trim() !== 'blob') continue;
        const size = Number(git(workspace, ['cat-file', '-s', object]).stdout.trim());
        if (Number.isSafeInteger(size) && size <= MAX_CAPTURE_FILE) {
            values.push(git(workspace, ['cat-file', 'blob', object], { encoding: null }).stdout);
        }
    }
    assertNoCredentialMaterial(values, authPath);
}

function verifyCandidateBoundary({ workspace, source, item, protocol, initialCommit, authPath }) {
    const history = assertHistoryTruncated(
        workspace,
        [item.repair, protocol.source.pipeline_guidance_commit],
        { expectedRoot: initialCommit },
    );
    const dependencyRoot = join(workspace, 'node_modules');
    const sourceDependencyRoot = join(source, 'node_modules');
    if (!existsSync(dependencyRoot) || !lstatSync(dependencyRoot).isDirectory()
        || lstatSync(dependencyRoot).isSymbolicLink()) fail('candidate dependency root is not a physical directory');
    const candidateStat = lstatSync(dependencyRoot);
    const sourceStat = lstatSync(sourceDependencyRoot);
    if (candidateStat.dev === sourceStat.dev && candidateStat.ino === sourceStat.ino) {
        fail('candidate dependency root aliases the evaluator source tree');
    }
    for (const rel of changedPaths(workspace, initialCommit)) {
        const path = resolve(workspace, rel);
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail(`candidate changed a symlink path: ${rel}`);
        if (/^(?:\.env(?:\.|$)|auth\.json$|.*credentials)/i.test(rel)) {
            fail(`candidate created a credential-shaped path: ${rel}`);
        }
    }
    scanChangedFilesForCredentials(workspace, initialCommit, authPath);
    return { ...history, dependency_root_inode_distinct: true, credential_scan: 'pass' };
}

function codexVersion(codexBin) {
    return run(codexBin, ['--version'], {
        env: { PATH: sanitizedPath(), LANG: 'C.UTF-8', HOME: '/nonexistent' },
    }).stdout.trim();
}

function preflight({ protocol, protocolPath, source, output, codexBin, skipOracles = false }) {
    assertArtifactLock(protocol, protocolPath, source);
    const version = codexVersion(codexBin);
    if (version !== protocol.execution.codex_version) {
        fail(`Codex version mismatch: expected ${protocol.execution.codex_version}, got ${version}`);
    }
    const config = probePipelineConfig(codexBin);
    const fixtures = [];
    for (const item of protocol.cases) {
        const root = privateDirectory(`cycle-pipeline-preflight-${item.id}-`);
        try {
            const fixture = materializeFixture({
                protocol,
                protocolPath,
                source,
                caseId: item.id,
                mode: 'neutral',
                destination: join(root, 'workspace'),
                dependencies: false,
            });
            fixtures.push({
                case_id: item.id,
                base_tree_sha256: fixture.base_tree_sha256,
                history: fixture.history,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
    const isolation = probeIsolation(codexBin);
    const oracles = skipOracles ? null : protocol.cases.map((item) => verifyFrozenOracle({
        protocol, protocolPath, source, item, codexBin,
    }));
    const result = {
        study_id: protocol.study_id,
        protocol_sha256: sha256(readFileSync(protocolPath)),
        artifact_lock: 'pass',
        codex_version: version,
        config,
        fixtures,
        isolation,
        oracles,
        scored_model_calls: 0,
    };
    privateWrite(join(output, 'preflight.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
}

function persistentSession({ codexHome, dryRun, codexBin, workspace, issueBody, issueTitle }) {
    const scratch = privateDirectory('cycle-pipeline-client-tmp-');
    const clientHome = createClientHome({
        codexHome,
        includeAuth: !dryRun,
        codexBin,
        workspace,
        issueBody,
        issueTitle,
    });
    return {
        clientHome,
        scratch,
        authPath: dryRun ? null : resolveAuthPath(codexHome),
        cleanup() {
            rmSync(clientHome, { recursive: true, force: true });
            rmSync(scratch, { recursive: true, force: true });
        },
    };
}

function lifecycleSummary(lifecycle) {
    return {
        stage: lifecycle.stage,
        thread_id: lifecycle.thread_id,
        valid: lifecycle.valid,
        usage: lifecycle.usage,
        turns: lifecycle.turns.map((turn) => ({
            stage: turn.stage,
            turn: turn.turn,
            thread_id: turn.thread_id,
            started_at: turn.started_at,
            finished_at: turn.finished_at,
            elapsed_ms: turn.elapsed_ms,
            exit_code: turn.exit_code,
            model_turn_started: turn.model_turn_started,
            model_turn_completed: turn.model_turn_completed,
            usage: turn.usage,
            response: turn.response,
            invalid_reasons: turn.invalid_reasons,
            answer_rule: turn.answer_rule ?? null,
            artifacts: turn.artifacts,
        })),
    };
}

function lifecycleInvalid(lifecycle) {
    return lifecycle.turns.flatMap((turn) => turn.invalid_reasons
        .map((reason) => `${lifecycle.stage} turn ${turn.turn}: ${reason}`));
}

function recursiveFiles(root) {
    const files = [];
    const queue = [root];
    while (queue.length) {
        const directory = queue.pop();
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) queue.push(path);
            else if (entry.isFile()) files.push(path);
            else fail(`private artifact tree contains a special file: ${path}`);
        }
    }
    return files.sort();
}

function artifactManifest(output, runDir) {
    return Object.fromEntries(recursiveFiles(runDir)
        .filter((path) => !path.endsWith(`${sep}result.json`))
        .map((path) => [relative(output, path), sha256(readFileSync(path))]));
}

function createFixture({
    protocol, protocolPath, source, item, mode, destination, dryRun, dependencies = true,
}) {
    return dryRun
        ? materializeDryFixture({ protocol, protocolPath, caseId: item.id, mode, destination })
        : materializeFixture({
            protocol,
            protocolPath,
            source,
            caseId: item.id,
            mode,
            destination,
            dependencies,
        });
}

function finalizeArm({
    protocol,
    output,
    runDir,
    source,
    item,
    workspace,
    fixture,
    codexBin,
    dryRun,
    codexHome,
    arm,
    snapshots,
    lifecycles,
}) {
    const authPath = dryRun ? null : resolveAuthPath(codexHome);
    const boundary = dryRun
        ? assertHistoryTruncated(workspace, [], { expectedRoot: fixture.initial_commit })
        : verifyCandidateBoundary({
            workspace,
            source,
            item,
            protocol,
            initialCommit: fixture.initial_commit,
            authPath,
        });
    const oracle = dryRun
        ? { status: 'not-run', commands: [], private_output: [] }
        : verifyCandidate({ protocol, source, item, workspace, codexBin });
    if (!dryRun) {
        assertNoCredentialMaterial(
            oracle.private_output.flatMap((record) => [record.stdout, record.stderr]),
            authPath,
        );
    }
    const oraclePath = join(runDir, 'oracles', `${arm}.json`);
    privateWrite(oraclePath, `${JSON.stringify(oracle.private_output, null, 2)}\n`);
    const allTurns = lifecycles.flatMap((lifecycle) => lifecycle.turns);
    const final = snapshots.at(-1);
    return {
        arm,
        input_sha256: null,
        valid: lifecycles.every((lifecycle) => lifecycle.valid),
        lifecycle: lifecycles.map(lifecycleSummary),
        usage: usageSum(allTurns),
        model_turns_started: allTurns.filter((turn) => turn.model_turn_started).length,
        model_turns_completed: allTurns.filter((turn) => turn.model_turn_completed).length,
        command_evidence: commandEvidence(allTurns, workspace),
        snapshots,
        final_diff: final.diff,
        final_diff_sha256: final.diff_sha256,
        changed_paths: final.changed_paths,
        boundary,
        hidden_oracle: {
            status: oracle.status,
            commands: oracle.commands,
            private_output: relative(output, oraclePath),
        },
    };
}

function executeCaseAttempt({
    protocol,
    protocolPath,
    source,
    output,
    item,
    caseIndex,
    attempt,
    codexBin,
    model,
    effort,
    timeoutMs,
    dryRun,
    codexHome,
    codexVersionValue,
}) {
    const privateRoot = privateDirectory(`cycle-pipeline-case-${item.id}-`);
    const runName = `${String(caseIndex).padStart(2, '0')}-${item.id}-a${attempt}`;
    const runDir = join(output, 'private', 'runs', runName);
    privateMkdir(runDir);
    const rawRequest = readFileSync(protocolAsset(protocolPath, item.raw_prompt_path), 'utf8');
    const canonicalIssue = readFileSync(protocolAsset(protocolPath, item.canonical_issue_path), 'utf8');
    const invalid = [];
    const arms = [];
    const attemptedLifecycles = [];
    let shapedIssue = null;
    let shapedTitle = null;
    let intakeIssueCount = 0;
    try {
        const intakeWorkspace = join(privateRoot, 'intake');
        createFixture({
            protocol,
            protocolPath,
            source,
            item,
            mode: 'pipeline',
            destination: intakeWorkspace,
            dryRun,
            dependencies: false,
        });
        const intake = runLifecycle({
            protocol,
            protocolPath,
            output,
            item,
            workspace: intakeWorkspace,
            runDir,
            codexBin,
            model,
            effort,
            timeoutMs,
            codexHome,
            dryRun,
            arm: 'intake',
            stage: 'intake',
            attempt,
            prompt: turnPrompt(protocol, protocolPath, { stage: 'intake', rawRequest }),
            canonicalIssue,
            sessionId: `${item.id}-intake-a${attempt}`,
        });
        attemptedLifecycles.push(intake);
        invalid.push(...lifecycleInvalid(intake));
        const created = trackerCreates(intake.turns);
        intakeIssueCount = created.length;
        if (created.length !== 1) invalid.push(`intake created ${created.length} issues instead of exactly one`);
        else if (!isNonEmptyString(created[0].title) || !isNonEmptyString(created[0].body)) {
            invalid.push('intake created an issue without a non-empty title and body');
        } else {
            shapedIssue = created[0].body;
            shapedTitle = created[0].title;
        }
        privateWrite(join(runDir, 'intake', 'lifecycle.json'), `${JSON.stringify(lifecycleSummary(intake), null, 2)}\n`);
        if (shapedIssue !== null) privateWrite(join(runDir, 'intake', 'created-issue.md'), shapedIssue);
        if (shapedTitle !== null) privateWrite(join(runDir, 'intake', 'created-title.txt'), `${shapedTitle}\n`);
        rmSync(intakeWorkspace, { recursive: true, force: true });

        if (!invalid.length) {
            for (const arm of ['raw-direct', 'shaped-direct']) {
                const workspace = join(privateRoot, arm);
                try {
                    const fixture = createFixture({
                        protocol, protocolPath, source, item, mode: 'neutral', destination: workspace, dryRun,
                    });
                    const input = arm === 'raw-direct'
                        ? rawRequest
                        : issueEnvelope(shapedTitle, shapedIssue);
                    const lifecycle = runLifecycle({
                        protocol,
                        protocolPath,
                        output,
                        item,
                        workspace,
                        runDir,
                        codexBin,
                        model,
                        effort,
                        timeoutMs,
                        codexHome,
                        dryRun,
                        arm,
                        stage: 'direct',
                        attempt,
                        prompt: turnPrompt(protocol, protocolPath, {
                            stage: 'direct',
                            rawRequest,
                            shapedIssue: arm === 'shaped-direct'
                                ? issueEnvelope(shapedTitle, shapedIssue)
                                : null,
                        }),
                        sessionId: `${item.id}-${arm}-a${attempt}`,
                    });
                    attemptedLifecycles.push(lifecycle);
                    invalid.push(...lifecycleInvalid(lifecycle).map((reason) => `${arm}: ${reason}`));
                    if (!lifecycle.valid) break;
                    const snapshot = snapshotWorkspace({
                        output, runDir, workspace, fixture, arm, stage: 'final',
                    });
                    const result = finalizeArm({
                        protocol,
                        output,
                        runDir,
                        source,
                        item,
                        workspace,
                        fixture,
                        codexBin,
                        dryRun,
                        codexHome,
                        arm,
                        snapshots: [snapshot],
                        lifecycles: [lifecycle],
                    });
                    result.input_sha256 = arm === 'raw-direct'
                        ? sha256(input)
                        : issueEnvelopeHash(shapedTitle, shapedIssue);
                    arms.push(result);
                } finally {
                    rmSync(workspace, { recursive: true, force: true });
                }
            }
        }

        if (!invalid.length) {
            const arm = 'full-cycle';
            const workspace = join(privateRoot, arm);
            const fixture = createFixture({
                protocol, protocolPath, source, item, mode: 'pipeline', destination: workspace, dryRun,
            });
            const session = persistentSession({
                codexHome,
                dryRun,
                codexBin,
                workspace,
                issueBody: shapedIssue,
                issueTitle: shapedTitle,
            });
            const lifecycles = [];
            const snapshots = [];
            let threadId = null;
            try {
                for (const stage of protocol.execution.full_cycle.resumed_stages) {
                    const lifecycle = runLifecycle({
                        protocol,
                        protocolPath,
                        output,
                        item,
                        workspace,
                        runDir,
                        codexBin,
                        model,
                        effort,
                        timeoutMs,
                        codexHome,
                        dryRun,
                        arm,
                        stage,
                        attempt,
                        prompt: turnPrompt(protocol, protocolPath, { stage }),
                        issueBody: shapedIssue,
                        issueTitle: shapedTitle,
                        threadId,
                        sessionId: `${item.id}-${arm}-a${attempt}`,
                        sessionContext: session,
                    });
                    lifecycles.push(lifecycle);
                    attemptedLifecycles.push(lifecycle);
                    invalid.push(...lifecycleInvalid(lifecycle).map((reason) => `${arm}: ${reason}`));
                    if (!lifecycle.valid) break;
                    if (threadId && lifecycle.thread_id !== threadId) {
                        invalid.push('full-cycle changed Codex thread between stages');
                        break;
                    }
                    threadId = lifecycle.thread_id;
                    snapshots.push(snapshotWorkspace({
                        output,
                        runDir,
                        workspace,
                        fixture,
                        arm,
                        stage,
                    }));
                }
            } finally {
                session.cleanup();
            }
            if (!invalid.length && snapshots.length === 4) {
                const result = finalizeArm({
                    protocol,
                    output,
                    runDir,
                    source,
                    item,
                    workspace,
                    fixture,
                    codexBin,
                    dryRun,
                    codexHome,
                    arm,
                    snapshots,
                    lifecycles,
                });
                result.input_sha256 = issueEnvelopeHash(shapedTitle, shapedIssue);
                arms.push(result);
            } else if (!invalid.length) {
                invalid.push(`full-cycle captured ${snapshots.length} stage snapshots instead of four`);
            }
        }

        if (!invalid.length) {
            const shapedHash = issueEnvelopeHash(shapedTitle, shapedIssue);
            const shapedDirect = arms.find((arm) => arm.arm === 'shaped-direct');
            const fullCycle = arms.find((arm) => arm.arm === 'full-cycle');
            if (!shapedDirect || !fullCycle || shapedDirect.input_sha256 !== shapedHash
                || fullCycle.input_sha256 !== shapedHash) {
                invalid.push('shaped-direct and full-cycle did not receive byte-identical issue title and body text');
            }
            if (arms.length !== 3) invalid.push(`captured ${arms.length} arms instead of three`);
        }

        const result = {
            study_id: protocol.study_id,
            case_id: item.id,
            case_index: caseIndex,
            attempt,
            valid: invalid.length === 0,
            invalid_reasons: invalid,
            model,
            reasoning_effort: effort,
            codex_version: codexVersionValue,
            raw_request_sha256: sha256(rawRequest),
            shaped_issue_sha256: shapedIssue === null ? null : sha256(shapedIssue),
            shaped_issue_title_sha256: shapedTitle === null ? null : sha256(shapedTitle),
            shaped_issue_envelope_sha256: shapedIssue === null || shapedTitle === null
                ? null
                : issueEnvelopeHash(shapedTitle, shapedIssue),
            canonical_issue_sha256: sha256(canonicalIssue),
            intake_issue_count: intakeIssueCount,
            lifecycle: attemptedLifecycles.map(lifecycleSummary),
            usage: usageSum(attemptedLifecycles.flatMap((lifecycle) => lifecycle.turns)),
            model_turns_started: attemptedLifecycles.flatMap((lifecycle) => lifecycle.turns)
                .filter((turn) => turn.model_turn_started).length,
            model_turns_completed: attemptedLifecycles.flatMap((lifecycle) => lifecycle.turns)
                .filter((turn) => turn.model_turn_completed).length,
            arms,
        };
        result.artifacts = artifactManifest(output, runDir);
        privateWrite(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
        return result;
    } finally {
        rmSync(privateRoot, { recursive: true, force: true });
    }
}

function ensureNewOutput(path) {
    const output = resolve(path);
    if (existsSync(output)) fail(`output already exists: ${output}`);
    privateMkdir(output);
    privateMkdir(join(output, 'private'));
    return realpathSync(output);
}

function prepareBatchOutput(path) {
    let output = resolve(path);
    if (!existsSync(output)) return { output: ensureNewOutput(output), resume: false };
    if (!statSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) {
        fail(`batch output is not a safe directory: ${output}`);
    }
    output = realpathSync(output);
    recursiveFiles(output);
    chmodSync(output, 0o700);
    privateMkdir(join(output, 'private'));
    return { output, resume: true };
}

function resultIndexPath(output) {
    return join(output, 'private', 'results.jsonl');
}

function readResults(output) {
    const path = resultIndexPath(output);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8').trim();
    if (!text) return [];
    return text.split('\n').map((line, index) => {
        try { return JSON.parse(line); }
        catch (error) { fail(`invalid resumable result at line ${index + 1}: ${error.message}`); }
    });
}

function appendResult(output, result) {
    const path = resultIndexPath(output);
    privateMkdir(dirname(path));
    writeFileSync(path, `${JSON.stringify(result)}\n`, { flag: 'a', mode: 0o600 });
    chmodSync(path, 0o600);
}

function experimentPath(output) {
    return join(output, 'private', 'experiment.json');
}

function experimentRecord({ protocol, protocolPath, model, effort, codexVersionValue, dryRun }) {
    return {
        study_id: protocol.study_id,
        protocol_sha256: sha256(readFileSync(protocolPath)),
        model,
        reasoning_effort: effort,
        codex_version: codexVersionValue,
        dry_run: dryRun,
        case_order: protocol.schedule.case_order,
        arms: protocol.arms.map((arm) => arm.id),
        cases_per_batch: protocol.schedule.cases_per_batch,
    };
}

function loadOrCreateExperiment({ protocol, protocolPath, output, model, effort, codexVersionValue, dryRun }) {
    const expected = experimentRecord({ protocol, protocolPath, model, effort, codexVersionValue, dryRun });
    const path = experimentPath(output);
    if (!existsSync(path)) {
        privateWrite(path, `${JSON.stringify(expected, null, 2)}\n`);
        return expected;
    }
    let actual;
    try { actual = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { fail(`invalid resumable experiment record: ${error.message}`); }
    if (stableJson(actual) !== stableJson(expected)) fail('resumable experiment identity changed');
    return actual;
}

function validateArtifactFile(output, rel, expectedHash) {
    const path = resolve(output, rel);
    ensureInside(output, path);
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        fail(`missing or unsafe resumable artifact: ${rel}`);
    }
    if ((lstatSync(path).mode & 0o077) !== 0) fail(`resumable artifact is not private: ${rel}`);
    if (sha256(readFileSync(path)) !== expectedHash) fail(`resumable artifact content changed: ${rel}`);
}

function validatePersistedResult({ protocol, output, experiment, result, expectedItem, expectedIndex, expectedAttempt }) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('resumable result is not an object');
    const identity = {
        study_id: protocol.study_id,
        case_id: expectedItem.id,
        case_index: expectedIndex,
        attempt: expectedAttempt,
        model: experiment.model,
        reasoning_effort: experiment.reasoning_effort,
        codex_version: experiment.codex_version,
    };
    for (const [key, value] of Object.entries(identity)) {
        if (result[key] !== value) fail(`resumable result identity mismatch: ${key}`);
    }
    if (typeof result.valid !== 'boolean' || !Array.isArray(result.invalid_reasons)
        || !result.artifacts || typeof result.artifacts !== 'object') {
        fail(`resumable result for ${expectedItem.id} has invalid status fields`);
    }
    const runName = `${String(expectedIndex).padStart(2, '0')}-${expectedItem.id}-a${expectedAttempt}`;
    const expectedPrefix = `private/runs/${runName}/`;
    for (const [rel, digest] of Object.entries(result.artifacts)) {
        if (!rel.startsWith(expectedPrefix) || rel.endsWith('/result.json')) {
            fail(`resumable result has an unexpected artifact path: ${rel}`);
        }
        validateArtifactFile(output, rel, digest);
    }
    const resultPath = join(output, 'private', 'runs', runName, 'result.json');
    if (!existsSync(resultPath) || (lstatSync(resultPath).mode & 0o077) !== 0) {
        fail(`missing private result artifact for ${expectedItem.id} attempt ${expectedAttempt}`);
    }
    let persisted;
    try { persisted = JSON.parse(readFileSync(resultPath, 'utf8')); }
    catch (error) { fail(`invalid private result artifact for ${expectedItem.id}: ${error.message}`); }
    if (stableJson(persisted) !== stableJson(result)) {
        fail(`resumable result index disagrees with ${relative(output, resultPath)}`);
    }
}

export function validateProgress({ protocol, output, experiment, results }) {
    let cursor = 0;
    let completedCases = 0;
    let terminalInvalidCase = null;
    for (let index = 0; index < protocol.cases.length; index += 1) {
        const item = protocol.cases[index];
        const caseIndex = index + 1;
        if (cursor === results.length) break;
        const first = results[cursor];
        validatePersistedResult({
            protocol,
            output,
            experiment,
            result: first,
            expectedItem: item,
            expectedIndex: caseIndex,
            expectedAttempt: 1,
        });
        cursor += 1;
        if (first.valid) {
            completedCases += 1;
            continue;
        }
        if (cursor === results.length) break;
        const retry = results[cursor];
        validatePersistedResult({
            protocol,
            output,
            experiment,
            result: retry,
            expectedItem: item,
            expectedIndex: caseIndex,
            expectedAttempt: 2,
        });
        cursor += 1;
        if (retry.valid) completedCases += 1;
        else terminalInvalidCase = item.id;
        if (terminalInvalidCase) break;
    }
    if (cursor !== results.length) fail('resumable results are not an exact prefix of the frozen schedule');
    return {
        completedCases,
        terminalInvalidCase,
        complete: completedCases === protocol.cases.length,
        nextCase: terminalInvalidCase ? null : protocol.cases[completedCases] ?? null,
    };
}

function acceptedResults(protocol, results) {
    const accepted = new Map();
    for (const item of protocol.cases) {
        const attempts = results.filter((result) => result.case_id === item.id);
        const latest = attempts.at(-1);
        if (latest?.valid) accepted.set(item.id, latest);
    }
    return accepted;
}

function seededRank(seed, value) {
    return sha256(`${seed}\0${value}`);
}

function resultCreatedIssuePath(result) {
    return Object.keys(result.artifacts).find((path) => path.endsWith('/intake/created-issue.md')) ?? null;
}

function resultCreatedTitlePath(result) {
    return Object.keys(result.artifacts).find((path) => path.endsWith('/intake/created-title.txt')) ?? null;
}

function normalizedGateEvidence(arm) {
    return arm.command_evidence
        .filter((record) => /(?:^|\s)(?:npm|npx|node) (?:test|run|--test|vitest|tsc|lint|build|check)/.test(record.command))
        .map((record) => ({ command: normalizePublicText(record.command), exit_code: record.exit_code }));
}

function normalizePublicText(value) {
    return String(value)
        .replace(/file:\/\/\/(?:home|tmp)\/[^\s"'`<>]+/g, '<host-path>')
        .replace(/(?:\/home\/[^/\s]+|\/tmp)\/[^\s"'`<>]+/g, '<host-path>');
}

function writeScoringArtifacts({ protocol, protocolPath, output, results }) {
    const accepted = acceptedResults(protocol, results);
    if (accepted.size !== protocol.cases.length) fail('cannot normalize an incomplete pipeline experiment');
    const scoringRoot = join(output, 'scoring');
    const fixtureRoot = join(scoringRoot, 'fixtures');
    privateMkdir(fixtureRoot);
    const packets = [];
    const map = [];
    for (const item of protocol.cases) {
        const result = accepted.get(item.id);
        const packetId = sha256(`${protocol.schedule.seed}\0packet\0${item.id}`).slice(0, 16);
        const issuePath = resultCreatedIssuePath(result);
        const titlePath = resultCreatedTitlePath(result);
        if (!issuePath || !titlePath) fail(`missing intake issue artifact for ${item.id}`);
        const shapedIssue = normalizePublicText(readFileSync(join(output, issuePath), 'utf8'));
        const shapedTitle = normalizePublicText(readFileSync(join(output, titlePath), 'utf8').trimEnd());
        const ordered = [...result.arms].sort((a, b) => seededRank(
            protocol.schedule.seed,
            `${item.id}:${a.arm}`,
        ).localeCompare(seededRank(protocol.schedule.seed, `${item.id}:${b.arm}`)));
        const outputs = ordered.map((arm, index) => {
            const label = String.fromCharCode(65 + index);
            const destination = join('fixtures', `${packetId}-${label}.diff`);
            const rawDiff = readFileSync(join(output, arm.final_diff));
            if (rawDiff.includes(Buffer.from('GIT binary patch'))) {
                fail(`cannot publish a binary scoring diff for ${item.id}`);
            }
            const bytes = Buffer.from(normalizePublicText(rawDiff.toString('utf8')));
            privateWrite(join(scoringRoot, destination), bytes);
            map.push({ packet_id: packetId, output_label: label, case_id: item.id, arm: arm.arm });
            return {
                output_label: label,
                final_diff: destination,
                final_diff_sha256: sha256(bytes),
                changed_paths: arm.changed_paths,
                hidden_oracle: arm.hidden_oracle.status,
                gate_evidence: normalizedGateEvidence(arm),
            };
        });
        packets.push({
            packet_id: packetId,
            raw_request: normalizePublicText(
                readFileSync(protocolAsset(protocolPath, item.raw_prompt_path), 'utf8'),
            ),
            historical_reference_title: item.title,
            historical_reference_issue: normalizePublicText(readFileSync(
                protocolAsset(protocolPath, item.canonical_issue_path), 'utf8',
            )),
            intake_produced_title: shapedTitle,
            intake_produced_issue: shapedIssue,
            outputs,
        });
    }
    const scoringInput = {
        version: 1,
        study_id: protocol.study_id,
        instructions: {
            primary: protocol.scoring.primary,
            process_quality: protocol.scoring.process_quality,
            analysis: protocol.scoring.analysis,
            independence: 'Two scorers lock separate schema-valid files before the arm map is revealed.',
        },
        packets,
    };
    const scoringBytes = Buffer.from(`${JSON.stringify(scoringInput, null, 2)}\n`);
    const scoreSchema = readFileSync(protocolAsset(protocolPath, protocol.scoring.schema_path));
    privateWrite(join(scoringRoot, 'scoring-input.json'), scoringBytes);
    privateWrite(join(scoringRoot, 'score.schema.json'), scoreSchema);
    const blindingBytes = Buffer.from(`${JSON.stringify(map, null, 2)}\n`);
    privateWrite(join(output, 'private', 'blinding-map.json'), blindingBytes);
    privateWrite(join(scoringRoot, 'manifest.json'), `${JSON.stringify({
        scoring_input_sha256: sha256(scoringBytes),
        score_schema_sha256: sha256(scoreSchema),
        blinding_map_sha256: sha256(blindingBytes),
        packet_count: packets.length,
        output_count: packets.length * 3,
        fixture_diffs: packets.flatMap((packet) => packet.outputs.map((arm) => ({
            packet_id: packet.packet_id,
            output_label: arm.output_label,
            sha256: arm.final_diff_sha256,
        }))),
    }, null, 2)}\n`);
}

function validateScoringArtifacts(output) {
    const manifestPath = join(output, 'scoring', 'manifest.json');
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (error) { fail(`invalid resumable scoring manifest: ${error.message}`); }
    const fixed = [
        ['scoring/scoring-input.json', manifest.scoring_input_sha256],
        ['scoring/score.schema.json', manifest.score_schema_sha256],
        ['private/blinding-map.json', manifest.blinding_map_sha256],
    ];
    for (const [rel, digest] of fixed) validateArtifactFile(output, rel, digest);
    if (!Array.isArray(manifest.fixture_diffs) || manifest.fixture_diffs.length !== 12) {
        fail('resumable scoring manifest has an invalid fixture list');
    }
    for (const fixture of manifest.fixture_diffs) {
        if (!isNonEmptyString(fixture.packet_id) || !/^[ABC]$/.test(fixture.output_label ?? '')
            || !/^[0-9a-f]{64}$/.test(fixture.sha256 ?? '')) {
            fail('resumable scoring manifest has an invalid fixture record');
        }
        validateArtifactFile(
            output,
            `scoring/fixtures/${fixture.packet_id}-${fixture.output_label}.diff`,
            fixture.sha256,
        );
    }
    return manifest;
}

function summarize(protocol, results) {
    const valid = acceptedResults(protocol, results);
    const allTurns = results.flatMap((result) => result.lifecycle.flatMap((stage) => stage.turns));
    return {
        complete: valid.size === protocol.cases.length,
        completed_cases: valid.size,
        total_cases: protocol.cases.length,
        remaining_cases: protocol.cases.length - valid.size,
        attempts: results.length,
        invalid_attempts: results.filter((result) => !result.valid).length,
        model_turns_started: allTurns.filter((turn) => turn.model_turn_started).length,
        model_turns_completed: allTurns.filter((turn) => turn.model_turn_completed).length,
        usage: usageSum(allTurns),
    };
}

function withBatchLock(output, callback) {
    const lock = join(output, '.batch.lock');
    let descriptor;
    try {
        descriptor = openSync(lock, 'wx', 0o600);
    } catch (error) {
        fail(`cannot acquire batch lock ${lock}: ${error.message}`);
    }
    closeSync(descriptor);
    try { return callback(); }
    finally { rmSync(lock, { force: true }); }
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
    maxCases = Number.POSITIVE_INFINITY,
}) {
    const version = codexVersion(codexBin);
    const experiment = loadOrCreateExperiment({
        protocol,
        protocolPath,
        output,
        model,
        effort,
        codexVersionValue: version,
        dryRun,
    });
    let results = readResults(output);
    let progress = validateProgress({ protocol, output, experiment, results });
    const active = join(output, 'private', 'active-case.json');
    if (existsSync(active)) fail(`stale active-case marker requires inspection: ${active}`);
    const scoringExists = existsSync(join(output, 'scoring'));
    if (!progress.complete && scoringExists) fail('scoring artifacts exist before the experiment is complete');
    if (progress.complete && scoringExists) validateScoringArtifacts(output);
    if (progress.terminalInvalidCase) fail(`experiment stopped at invalid case ${progress.terminalInvalidCase}`);
    let processed = 0;
    while (!progress.complete && processed < maxCases) {
        const item = progress.nextCase;
        const caseIndex = protocol.cases.findIndex((entry) => entry.id === item.id) + 1;
        privateWrite(active, `${JSON.stringify({ case_id: item.id, case_index: caseIndex, attempt: 1 }, null, 2)}\n`);
        let accepted = false;
        let caseCheckpointed = false;
        try {
            for (let attempt = 1; attempt <= protocol.schedule.invalid_case_retry_limit + 1; attempt += 1) {
                privateWrite(active, `${JSON.stringify({ case_id: item.id, case_index: caseIndex, attempt }, null, 2)}\n`);
                const result = executeCaseAttempt({
                    protocol,
                    protocolPath,
                    source,
                    output,
                    item,
                    caseIndex,
                    attempt,
                    codexBin,
                    model,
                    effort,
                    timeoutMs,
                    dryRun,
                    codexHome,
                    codexVersionValue: version,
                });
                appendResult(output, result);
                results.push(result);
                if (result.valid) {
                    accepted = true;
                    break;
                }
            }
            caseCheckpointed = true;
        } finally {
            if (caseCheckpointed) rmSync(active, { force: true });
        }
        processed += 1;
        progress = validateProgress({ protocol, output, experiment, results });
        if (!accepted || progress.terminalInvalidCase) break;
    }
    const summary = summarize(protocol, results);
    privateWrite(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    if (summary.complete) {
        if (!existsSync(join(output, 'scoring', 'scoring-input.json'))) {
            writeScoringArtifacts({ protocol, protocolPath, output, results });
        } else {
            validateScoringArtifacts(output);
        }
    }
    const receipt = {
        completed_cases: summary.completed_cases,
        total_cases: summary.total_cases,
        remaining_cases: summary.remaining_cases,
        attempts: summary.attempts,
        invalid_attempts: summary.invalid_attempts,
        model_turns_started: summary.model_turns_started,
        model_turns_completed: summary.model_turns_completed,
        reported_token_usage: summary.usage,
        complete: summary.complete,
    };
    return { summary, receipt, terminalInvalidCase: progress.terminalInvalidCase };
}

export function buildPlan(protocol) {
    return {
        study_id: protocol.study_id,
        model: protocol.execution.model,
        reasoning_effort: protocol.execution.reasoning_effort,
        cases_per_batch: protocol.schedule.cases_per_batch,
        case_order: protocol.schedule.case_order,
        arm_order_within_case: protocol.arms.map((arm) => arm.id),
        lifecycle_per_case: {
            common_intake: ['intake'],
            raw_direct: ['direct'],
            shaped_direct: ['direct'],
            full_cycle: protocol.execution.full_cycle.resumed_stages,
        },
        minimum_model_turns_per_valid_case: 7,
        maximum_model_turns_per_attempt: 28,
        whole_case_retry_limit: protocol.schedule.invalid_case_retry_limit,
        scored_model_calls_in_setup_issue: 0,
    };
}

function usage() {
    return `Usage:
  node eval/pipeline/run.mjs lock --source <songsiknow-checkout>
  node eval/pipeline/run.mjs plan
  node eval/pipeline/run.mjs dry-run --output <new-directory>
  node eval/pipeline/run.mjs dry-run-batch --output <new-or-resumable-directory>
  node eval/pipeline/run.mjs preflight --source <songsiknow-checkout> --output <new-directory>
       [--skip-oracles]
  node eval/pipeline/run.mjs run --source <songsiknow-checkout> --output <new-directory>
       --confirm-protocol-sha256 <sha256> [--codex-home <path>]
  node eval/pipeline/run.mjs run-batch --source <songsiknow-checkout>
       --output <new-or-resumable-directory> --confirm-protocol-sha256 <sha256>
       [--codex-home <path>]

Options:
  --protocol <path>       Protocol file, default: eval/pipeline/protocol.json
  --codex-bin <path>      Codex executable; dry runs default to the bundled fake
  --timeout-ms <number>   Dry-run override; scored runs use the frozen timeout
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
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help || positionals.length !== 1) {
        console.log(usage());
        return values.help ? 0 : 2;
    }
    const command = positionals[0];
    const { protocol, protocolPath } = loadProtocol(values.protocol, { requireLock: command !== 'lock' });
    if (command === 'lock') {
        if (!values.source) fail('lock requires --source');
        console.log(JSON.stringify(computeArtifactLock(protocol, protocolPath, values.source), null, 2));
        return 0;
    }
    if (command === 'plan') {
        assertLocalArtifactLock(protocol, protocolPath);
        console.log(JSON.stringify({
            ...buildPlan(protocol),
            protocol_sha256: sha256(readFileSync(protocolPath)),
        }, null, 2));
        return 0;
    }
    const commands = ['dry-run', 'dry-run-batch', 'preflight', 'run', 'run-batch'];
    if (!commands.includes(command)) fail(`unknown command: ${command}`);
    if (!values.output) fail(`${command} requires --output`);
    const timeoutMs = Number(values['timeout-ms'] ?? protocol.execution.timeout_ms_per_turn);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('--timeout-ms must be a positive integer');
    const batch = command === 'dry-run-batch' || command === 'run-batch';
    const prepared = batch
        ? prepareBatchOutput(values.output)
        : { output: ensureNewOutput(values.output), resume: false };
    const { output } = prepared;

    if (command === 'dry-run' || command === 'dry-run-batch') {
        assertLocalArtifactLock(protocol, protocolPath);
        const codexBin = resolve(values['codex-bin'] ?? DEFAULT_FAKE_CODEX);
        const config = probePipelineConfig(codexBin);
        privateWrite(join(output, 'dry-preflight.json'), `${JSON.stringify({
            study_id: protocol.study_id,
            strict_config: config,
            scored_model_calls: 0,
        }, null, 2)}\n`);
        const execute = () => runExperiment({
            protocol,
            protocolPath,
            output,
            codexBin,
            model: 'fake-pipeline-model',
            effort: protocol.execution.reasoning_effort,
            timeoutMs,
            dryRun: true,
            maxCases: command === 'dry-run-batch' ? protocol.schedule.cases_per_batch : Number.POSITIVE_INFINITY,
        });
        const result = batch ? withBatchLock(output, execute) : execute();
        console.log(JSON.stringify(result.receipt, null, 2));
        if (result.terminalInvalidCase) fail(`experiment stopped at invalid case ${result.terminalInvalidCase}`);
        return 0;
    }

    if (!values.source) fail(`${command} requires --source`);
    const source = verifySource(values.source, protocol);
    const codexBin = resolveExecutable(values['codex-bin'] ?? 'codex');
    if (command === 'preflight') {
        preflight({
            protocol,
            protocolPath,
            source,
            output,
            codexBin,
            skipOracles: values['skip-oracles'],
        });
        return 0;
    }
    const expected = sha256(readFileSync(protocolPath));
    if (values['confirm-protocol-sha256'] !== expected) {
        fail(`${command} requires --confirm-protocol-sha256 ${expected}`);
    }
    if (timeoutMs !== protocol.execution.timeout_ms_per_turn) {
        fail(`${command} timeout is frozen at ${protocol.execution.timeout_ms_per_turn}ms`);
    }
    if (values['skip-oracles']) fail(`${command} cannot skip hidden-oracle preflight`);
    const execute = () => {
        preflight({ protocol, protocolPath, source, output, codexBin, skipOracles: false });
        const result = runExperiment({
            protocol,
            protocolPath,
            source,
            output,
            codexBin,
            model: protocol.execution.model,
            effort: protocol.execution.reasoning_effort,
            timeoutMs,
            dryRun: false,
            codexHome: values['codex-home'],
            maxCases: command === 'run-batch'
                ? protocol.schedule.cases_per_batch
                : Number.POSITIVE_INFINITY,
        });
        if (command === 'run-batch') console.log(JSON.stringify(result.receipt, null, 2));
        if (result.terminalInvalidCase) fail(`experiment stopped at invalid case ${result.terminalInvalidCase}`);
        return 0;
    };
    return batch ? withBatchLock(output, execute) : execute();
}

function invokedDirectly() {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
    try {
        process.exitCode = main();
    } catch (error) {
        if (error instanceof PipelineEvalError) {
            console.error(error.message);
            process.exitCode = 2;
        } else {
            throw error;
        }
    }
}
