#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
    assertNoCredentialMaterial,
    changedPaths,
    classifyAttemptInvalidation,
    commandEvidence,
    ensureNewOutput,
    issueEnvelope,
    issueEnvelopeHash,
    lifecycleInvalid,
    lifecycleSummary,
    PipelineEvalError,
    prepareBatchOutput,
    persistentSession,
    probeIsolation,
    probePipelineConfig,
    recursiveFiles,
    runLifecycle,
    sanitizeCandidateRepository,
    sha256,
    snapshotWorkspace,
    trackerCreates,
    turnPrompt,
    validateArtifactFile,
    withBatchLock,
} from '../pipeline/run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DEFAULT_PROTOCOL = join(HERE, 'protocol.json');
const DEFAULT_FAKE_CODEX = join(ROOT, 'eval', 'pipeline', 'fake-codex.cjs');
const PIPELINE_BIN = join(ROOT, 'eval', 'pipeline', 'bin');
const NEXT_FONT_MOCKS = join(HERE, 'next-font-mocks.cjs');
const CONTROL = '.pipeline-eval';
const CONTROL_TMP = join(CONTROL, 'tmp');
const CONTROL_IGNORE = join(CONTROL, 'frozen-ignore');
const PNPM_RUNTIME_STORE = join(CONTROL_TMP, 'pnpm-store', 'v11');
const MAX_BUFFER = 128 * 1024 * 1024;
const MAX_CAPTURE_FILE = 16 * 1024 * 1024;

export class ModelLiftError extends Error {}

function fail(message) {
    throw new ModelLiftError(message);
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

function run(command, args, {
    cwd = ROOT,
    env = process.env,
    encoding = 'utf8',
    input,
    timeout,
    allowFailure = false,
} = {}) {
    const started = Date.now();
    const result = spawnSync(command, args, {
        cwd,
        env,
        encoding,
        input,
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

function sanitizedPath(pathValue = process.env.PATH) {
    const parts = String(pathValue ?? '').split(':').filter(Boolean);
    return [...new Set(['/usr/local/bin', '/usr/bin', '/bin', ...parts])].join(':');
}

function gitEnvironment(commitTime = null) {
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
        GIT_AUTHOR_NAME: 'Model Lift Fixture',
        GIT_AUTHOR_EMAIL: 'model-lift@example.invalid',
        GIT_COMMITTER_NAME: 'Model Lift Fixture',
        GIT_COMMITTER_EMAIL: 'model-lift@example.invalid',
        ...(commitTime ? {
            GIT_AUTHOR_DATE: commitTime,
            GIT_COMMITTER_DATE: commitTime,
        } : {}),
    };
}

function git(source, args, options = {}) {
    const root = resolve(source);
    return run('/usr/bin/git', [
        '-C', root,
        '-c', `core.worktree=${root}`,
        '-c', 'core.bare=false',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.attributesFile=/dev/null',
        '-c', 'core.excludesFile=/dev/null',
        '-c', 'commit.gpgSign=false',
        '-c', 'tag.gpgSign=false',
        '-c', 'protocol.file.allow=never',
        ...args,
    ], { ...options, env: options.env ?? gitEnvironment() });
}

function privateDirectory(prefix) {
    const path = mkdtempSync(join(tmpdir(), prefix));
    chmodSync(path, 0o700);
    return realpathSync(path);
}

function privateMkdir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
}

function privateWrite(path, value) {
    privateMkdir(dirname(path));
    writeFileSync(path, value, { mode: 0o600 });
    chmodSync(path, 0o600);
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
    if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)
        || protocol.version !== 1
        || protocol.study_id !== 'release-relay-sol-luna-model-lift-v1') {
        fail('model-lift protocol has an invalid identity');
    }
    if (!protocol.source || !/^[0-9a-f]{40}$/.test(protocol.source.base ?? '')
        || !/^[0-9a-f]{40}$/.test(protocol.source.repair ?? '')
        || !/^[0-9a-f]{40}$/.test(protocol.source.pipeline_bindings_commit ?? '')
        || !/^[0-9a-f]{40}$/.test(protocol.source.pipeline_renderer_commit ?? '')
        || !Array.isArray(protocol.source.pipeline_binding_paths)
        || !Array.isArray(protocol.source.pipeline_renderer_support_paths)
        || !Array.isArray(protocol.source.repository_guidance_paths)
        || !Array.isArray(protocol.source.pipeline_guidance_paths)
        || !Array.isArray(protocol.source.excluded_fixture_paths)) {
        fail('model-lift protocol has an invalid source definition');
    }
    if (protocol.task?.id !== 'rr-76'
        || protocol.task?.title !== 'Reject excluded candidate citations in OpenAI draft validation'
        || !Array.isArray(protocol.task?.repair_paths)
        || protocol.task?.oracle_destination !== 'packages/openai-integration/src/model-lift-oracle.test.ts') {
        fail('model-lift protocol has an invalid task');
    }
    const models = protocol.models?.map((entry) => [entry.id, entry.model]);
    if (stableJson(models) !== stableJson([
        ['luna', 'gpt-5.6-luna'],
        ['sol', 'gpt-5.6-sol'],
    ])) fail('model-lift protocol must freeze Luna then Sol');
    if (stableJson(protocol.arms?.map((arm) => arm.id))
        !== stableJson(['raw-direct', 'shaped-direct', 'full-cycle'])) {
        fail('model-lift protocol must freeze the three arms');
    }
    if (stableJson(protocol.schedule?.model_order) !== stableJson(['luna', 'sol'])
        || protocol.schedule?.models_per_batch !== 1
        || stableJson(protocol.schedule?.retry_limits) !== stableJson({
            behavioral: 1,
            infrastructure: 1,
            max_attempts_per_model: 3,
        })) fail('model-lift protocol has an invalid schedule');
    if (protocol.execution?.reasoning_effort !== 'high'
        || protocol.execution?.codex_version !== 'codex-cli 0.151.0'
        || protocol.execution?.node_version !== 'v26.8.1'
        || protocol.execution?.pnpm_version !== '11.24.0'
        || protocol.execution?.verifier_sandbox !== 'bubblewrap 0.12.0'
        || stableJson(protocol.execution?.package_manager_policy)
            !== stableJson([
                'pmOnFail: ignore',
                'trustLockfile: true',
                'storeDir: fixture-private scratch index',
            ])
        || protocol.execution?.timeout_ms_per_turn !== 1_800_000
        || protocol.execution?.subagents !== false
        || protocol.execution?.command_network !== false
        || stableJson(protocol.execution?.inner_gate_matrix) !== stableJson([
            'pnpm format:check',
            'pnpm lint',
            'pnpm typecheck',
            'pnpm build',
            'pnpm --filter @release-relay/openai-integration test',
        ])
        || stableJson(protocol.execution?.full_cycle?.resumed_stages)
            !== stableJson(['implement', 'review', 'patch', 'review', 'done'])
        || stableJson(protocol.execution?.full_cycle?.snapshot_labels)
            !== stableJson(['implement', 'review', 'patch', 'finding-closure', 'done'])) {
        fail('model-lift protocol has an invalid execution contract');
    }
    const assetPaths = [
        protocol.task.raw_prompt_path,
        protocol.task.canonical_issue_path,
        protocol.task.answer_sheet_path,
        protocol.task.oracle_path,
        protocol.task.alternative_patch_path,
        protocol.prompts?.direct_path,
        protocol.prompts?.stage_path,
        protocol.prompts?.turn_schema_path,
        protocol.scoring?.schema_path,
    ];
    if (assetPaths.some((path) => !isNonEmptyString(path))) fail('model-lift protocol is missing assets');
    if (!Array.isArray(protocol.gates?.hidden_oracle)
        || protocol.gates.hidden_oracle.length !== 3
        || stableJson(protocol.gates?.candidate_matrix)
            !== stableJson(['pnpm check', 'pnpm build'])) {
        fail('model-lift protocol has an invalid gate matrix');
    }
    if (requireLock && (!protocol.artifact_lock || Object.keys(protocol.artifact_lock).length === 0)) {
        fail('model-lift protocol is not artifact-locked');
    }
    return protocol;
}

export function loadProtocol(path = DEFAULT_PROTOCOL, options = {}) {
    const protocolPath = realpathSync(resolve(path));
    let protocol;
    try { protocol = JSON.parse(readFileSync(protocolPath, 'utf8')); }
    catch (error) { fail(`invalid model-lift protocol JSON: ${error.message}`); }
    validateProtocol(protocol, options);
    for (const rel of [
        protocol.task.raw_prompt_path,
        protocol.task.canonical_issue_path,
        protocol.task.answer_sheet_path,
        protocol.task.oracle_path,
        protocol.task.alternative_patch_path,
        protocol.prompts.direct_path,
        protocol.prompts.stage_path,
        protocol.prompts.turn_schema_path,
        protocol.scoring.schema_path,
    ]) protocolAsset(protocolPath, rel);
    return { protocol, protocolPath };
}

function isExcluded(path, excluded) {
    return excluded.some((entry) => path === entry || path.startsWith(`${entry}/`)
        || path.split('/').includes(entry));
}

function treeEntries(source, revision, excluded) {
    const listing = git(source, ['ls-tree', '-r', '-z', '--full-tree', revision]).stdout;
    const entries = [];
    for (const record of listing.split('\0').filter(Boolean)) {
        const match = record.match(/^(\d+) (\S+) ([0-9a-f]+)\t(.+)$/s);
        if (!match) fail(`cannot parse Git tree entry: ${record}`);
        const [, mode, type, , path] = match;
        if (isExcluded(path, excluded)) continue;
        if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
            fail(`unsupported source entry ${mode} ${type}: ${path}`);
        }
        entries.push({
            path,
            mode,
            content: git(source, ['show', `${revision}:${path}`], { encoding: null }).stdout,
        });
    }
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

function writeTree(destination, entries) {
    for (const entry of entries) {
        const path = resolve(destination, entry.path);
        ensureInside(destination, path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, entry.content);
        chmodSync(path, entry.mode === '100755' ? 0o755 : 0o644);
    }
}

function applyOfflinePackageManagerOverlay(destination, storePath = null) {
    const path = join(destination, 'pnpm-workspace.yaml');
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        fail('fixture is missing a safe pnpm-workspace.yaml');
    }
    const source = readFileSync(path, 'utf8');
    if (/^pmOnFail\s*:/m.test(source)) fail('frozen workspace already defines pmOnFail');
    const store = storePath ? `storeDir: ${JSON.stringify(storePath)}\n` : '';
    writeFileSync(path, `${source.trimEnd()}\n\npmOnFail: ignore\ntrustLockfile: true\n${store}`);
}

function patchBetween(source, from, to, paths) {
    return git(source, [
        'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames',
        from, to, '--', ...paths,
    ], { encoding: null }).stdout;
}

function repairParent(source, revision) {
    const parents = git(source, ['show', '-s', '--format=%P', revision]).stdout.trim().split(/\s+/).filter(Boolean);
    if (parents.length !== 1) fail(`repair ${revision} must have exactly one parent`);
    return parents[0];
}

function verifySource(source, protocol) {
    const root = realpathSync(resolve(source));
    if (!statSync(root).isDirectory()
        || git(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).status !== 0) {
        fail(`source is not a Git repository: ${source}`);
    }
    for (const revision of [
        protocol.source.base,
        protocol.source.repair,
        protocol.source.pipeline_bindings_commit,
    ]) {
        if (git(root, ['cat-file', '-e', `${revision}^{commit}`], { allowFailure: true }).status !== 0) {
            fail(`source is missing required commit ${revision}`);
        }
    }
    if (repairParent(root, protocol.source.repair) !== protocol.source.base) {
        fail('accepted repair is not a direct child of the frozen base');
    }
    return root;
}

function hashNamedFiles(source, revision, paths) {
    const hash = createHash('sha256');
    for (const path of [...paths].sort()) {
        hash.update(path);
        hash.update('\0');
        hash.update(git(source, ['show', `${revision}:${path}`], { encoding: null }).stdout);
        hash.update('\0');
    }
    return hash.digest('hex');
}

function renderGuidance(source, protocol) {
    const root = privateDirectory('cycle-model-lift-guidance-');
    const template = privateDirectory('cycle-model-lift-guidance-git-template-');
    try {
        run('/usr/bin/git', ['init', '-q', '--template', template, '-b', 'main'], {
            cwd: root,
            env: gitEnvironment(protocol.execution.fixture_commit_time),
        });
        for (const rel of protocol.source.pipeline_binding_paths) {
            const path = resolve(root, rel);
            ensureInside(root, path);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(
                path,
                git(source, ['show', `${protocol.source.pipeline_bindings_commit}:${rel}`], { encoding: null }).stdout,
            );
        }
        for (const rel of protocol.source.pipeline_renderer_support_paths) {
            const path = resolve(root, rel);
            ensureInside(root, path);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(
                path,
                git(source, ['show', `${protocol.source.pipeline_bindings_commit}:${rel}`], { encoding: null }).stdout,
            );
        }
        const rendered = run(process.execPath, [join(ROOT, 'bin', 'cycle.mjs'), 'update'], {
            cwd: root,
            env: { PATH: sanitizedPath(), LANG: 'C.UTF-8', HOME: '/nonexistent' },
        });
        if (!/Updated|Installed|up to date/i.test(`${rendered.stdout}\n${rendered.stderr}`)) {
            fail('current pipeline renderer did not report a completed update');
        }
        return Object.fromEntries(protocol.source.pipeline_guidance_paths.map((rel) => {
            const path = resolve(root, rel);
            ensureInside(root, path);
            if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
                fail(`current renderer did not produce ${rel}`);
            }
            return [rel, readFileSync(path)];
        }));
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(template, { recursive: true, force: true });
    }
}

function guidanceDigest(guidance) {
    const hash = createHash('sha256');
    for (const [path, content] of Object.entries(guidance).sort(([left], [right]) =>
        left.localeCompare(right))) {
        hash.update(path);
        hash.update('\0');
        hash.update(content);
        hash.update('\0');
    }
    return hash.digest('hex');
}

function localAssetLock(protocol, protocolPath) {
    const assets = {
        shared_runner_sha256: sha256(readFileSync(join(ROOT, 'eval', 'pipeline', 'run.mjs'))),
        runner_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
        fake_codex_sha256: sha256(readFileSync(DEFAULT_FAKE_CODEX)),
        fake_tracker_sha256: sha256(Buffer.concat([
            readFileSync(join(PIPELINE_BIN, 'gh')),
            readFileSync(join(PIPELINE_BIN, 'fake-gh.cjs')),
        ])),
        fake_git_sha256: sha256(readFileSync(join(PIPELINE_BIN, 'git'))),
        next_font_mocks_sha256: sha256(readFileSync(NEXT_FONT_MOCKS)),
    };
    for (const [name, rel] of Object.entries({
        raw_prompt_sha256: protocol.task.raw_prompt_path,
        canonical_issue_sha256: protocol.task.canonical_issue_path,
        answer_sheet_sha256: protocol.task.answer_sheet_path,
        oracle_sha256: protocol.task.oracle_path,
        alternative_patch_sha256: protocol.task.alternative_patch_path,
        direct_prompt_sha256: protocol.prompts.direct_path,
        stage_prompt_sha256: protocol.prompts.stage_path,
        turn_schema_sha256: protocol.prompts.turn_schema_path,
        score_schema_sha256: protocol.scoring.schema_path,
    })) assets[name] = sha256(readFileSync(protocolAsset(protocolPath, rel)));
    return assets;
}

export function computeArtifactLock(protocol, protocolPath, source) {
    const root = verifySource(source, protocol);
    return {
        ...localAssetLock(protocol, protocolPath),
        base_tree_sha256: treeDigest(treeEntries(
            root,
            protocol.source.base,
            protocol.source.excluded_fixture_paths,
        )),
        repair_patch_sha256: sha256(patchBetween(
            root,
            protocol.source.base,
            protocol.source.repair,
            protocol.task.repair_paths,
        )),
        historical_test_patch_sha256: sha256(patchBetween(
            root,
            protocol.source.base,
            protocol.source.repair,
            protocol.task.historical_test_paths,
        )),
        pipeline_bindings_sha256: hashNamedFiles(
            root,
            protocol.source.pipeline_bindings_commit,
            [
                ...protocol.source.pipeline_binding_paths,
                ...protocol.source.pipeline_renderer_support_paths,
                ...protocol.source.repository_guidance_paths,
            ],
        ),
        pipeline_guidance_sha256: guidanceDigest(renderGuidance(root, protocol)),
        source_dependency_lock_sha256: sha256(git(root, [
            'show', `${protocol.source.base}:pnpm-lock.yaml`,
        ], { encoding: null }).stdout),
    };
}

function assertLocalArtifactLock(protocol, protocolPath) {
    const actual = localAssetLock(protocol, protocolPath);
    for (const [key, digest] of Object.entries(actual)) {
        if (protocol.artifact_lock[key] !== digest) fail(`local artifact lock mismatch: ${key}`);
    }
    return actual;
}

function assertArtifactLock(protocol, protocolPath, source) {
    const actual = computeArtifactLock(protocol, protocolPath, source);
    if (stableJson(actual) !== stableJson(protocol.artifact_lock)) {
        fail(`artifact lock mismatch\nexpected ${stableJson(protocol.artifact_lock)}\nactual   ${stableJson(actual)}`);
    }
    return actual;
}

const EVALUATION_GATE_NOTE = `## Evaluation-only gate handoff

The inner Codex command sandbox for this frozen run cannot execute Node.js
\`child_process.spawnSync\`, which the unrelated coverage-oracle tests use. Do not run
\`pnpm check\` inside a model turn. Run these subprocess-safe preliminary gates instead:

\`\`\`sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm --filter @release-relay/openai-integration test
\`\`\`

The evaluator independently reruns the exact \`pnpm check\` and \`pnpm build\` commands in a
fresh networkless Bubblewrap verifier. Treat the preliminary commands above as the stage gate;
do not weaken, rewrite, or skip tests to work around the sandbox limitation.
`;

const NEUTRAL_AGENTS = `# Model-lift evaluation fixture

Implement only the evaluator-supplied request. Work entirely inside this isolated repository.
Do not use the network, credentials, live providers, deployment, or a real tracker. Make the
smallest behaviorally complete change, add focused tests, and run relevant local gates. Do not
commit or push unless explicitly asked.

${EVALUATION_GATE_NOTE}
`;

function initializeRepository(destination, commitTime) {
    const template = privateDirectory('cycle-model-lift-git-template-');
    const env = gitEnvironment(commitTime);
    try {
        run('/usr/bin/git', ['init', '-q', '--template', template, '-b', 'main'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'user.name', 'Model Lift Fixture'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'user.email', 'model-lift@example.invalid'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'core.logAllRefUpdates', 'false'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'core.hooksPath', '/dev/null'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'core.autocrlf', 'false'], { cwd: destination, env });
        run('/usr/bin/git', ['config', 'commit.gpgSign', 'false'], { cwd: destination, env });
        privateWrite(join(destination, '.git', 'info', 'exclude'), `/${CONTROL}/\n/node_modules/\n`);
        run('/usr/bin/git', ['add', '--', '.'], { cwd: destination, env });
        run('/usr/bin/git', ['commit', '-q', '--no-verify', '-m', 'fixture: frozen Release Relay base'], {
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
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('candidate repository has an unsafe .git');
    return { dev: stat.dev, ino: stat.ino };
}

function writeGuidance(destination, source, protocol) {
    for (const rel of [
        ...protocol.source.pipeline_binding_paths,
        ...protocol.source.repository_guidance_paths,
    ]) {
        const path = resolve(destination, rel);
        ensureInside(destination, path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
            path,
            git(source, ['show', `${protocol.source.pipeline_bindings_commit}:${rel}`], { encoding: null }).stdout,
        );
    }
    const guidance = renderGuidance(source, protocol);
    for (const [rel, content] of Object.entries(guidance)) {
        const path = resolve(destination, rel);
        ensureInside(destination, path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
    const agentsPath = join(destination, 'AGENTS.md');
    writeFileSync(
        agentsPath,
        `${EVALUATION_GATE_NOTE}\n${readFileSync(agentsPath, 'utf8')}`,
    );
}

function writeControlAssets(destination, protocol, protocolPath) {
    privateMkdir(join(destination, CONTROL_TMP));
    writeFileSync(join(destination, CONTROL, 'next-font-mocks.cjs'), readFileSync(NEXT_FONT_MOCKS));
    writeFileSync(
        join(destination, CONTROL, 'turn.schema.json'),
        readFileSync(protocolAsset(protocolPath, protocol.prompts.turn_schema_path)),
    );
    const sourceIgnore = join(destination, '.gitignore');
    const ignore = existsSync(sourceIgnore) ? readFileSync(sourceIgnore, 'utf8').trimEnd() : '';
    const frozenIgnore = `${ignore}\n/${CONTROL}/\n`;
    writeFileSync(sourceIgnore, frozenIgnore);
    writeFileSync(join(destination, CONTROL_IGNORE), frozenIgnore);
}

function discoverDependencyRoots(source) {
    const roots = [join(source, 'node_modules')];
    const queue = [join(source, 'packages'), join(source, 'scenarios')].filter(existsSync);
    while (queue.length) {
        const directory = queue.pop();
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const path = join(directory, entry.name);
            if (entry.name === 'node_modules') roots.push(path);
            else if (!['dist', '.git'].includes(entry.name)) queue.push(path);
        }
    }
    return [...new Set(roots)].sort();
}

function cloneDependencies(source, destination) {
    const copied = [];
    for (const from of discoverDependencyRoots(source)) {
        const rel = relative(source, from);
        const parent = dirname(join(destination, rel));
        if (!existsSync(parent)) continue;
        const to = join(destination, rel);
        run('/bin/cp', ['-a', '--reflink=never', from, to]);
        const fromStat = lstatSync(from);
        const toStat = lstatSync(to);
        if (!toStat.isDirectory() || toStat.isSymbolicLink()
            || (fromStat.dev === toStat.dev && fromStat.ino === toStat.ino)) {
            fail(`dependency root is not physically isolated: ${rel}`);
        }
        copied.push({ rel, dev: toStat.dev, ino: toStat.ino });
    }
    if (!copied.some((entry) => entry.rel === 'node_modules')) fail('root dependency tree was not copied');
    return copied;
}

function preparePnpmRuntime(destination, dependencyStore) {
    if (!dependencyStore) fail('pnpm runtime requires the evaluator dependency store');
    const sourceIndex = join(dependencyStore, 'index.db');
    if (!existsSync(sourceIndex) || !lstatSync(sourceIndex).isFile()
        || lstatSync(sourceIndex).isSymbolicLink()) {
        fail(`pnpm store is missing a safe index: ${sourceIndex}`);
    }
    const runtimeStore = join(destination, PNPM_RUNTIME_STORE);
    privateMkdir(runtimeStore);
    privateWrite(join(runtimeStore, 'index.db'), readFileSync(sourceIndex));
    const modulesPath = join(destination, 'node_modules', '.modules.yaml');
    let modules;
    try { modules = JSON.parse(readFileSync(modulesPath, 'utf8')); }
    catch (error) { fail(`invalid pnpm modules metadata: ${error.message}`); }
    modules.storeDir = runtimeStore;
    writeFileSync(modulesPath, JSON.stringify(modules, null, 2));
    const packageMap = join(destination, 'node_modules', '.package-map.json');
    if (!existsSync(packageMap) || !lstatSync(packageMap).isFile()
        || lstatSync(packageMap).isSymbolicLink()) {
        fail('historical dependency snapshot is missing a safe package map');
    }
    return { runtimeStore, writablePaths: [join(destination, 'node_modules')] };
}

function pnpmStorePath() {
    const path = run('pnpm', ['--pm-on-fail=ignore', 'store', 'path'], {
        cwd: ROOT,
        env: { PATH: sanitizedPath(), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: homedir() },
    }).stdout.trim();
    if (!path.startsWith(sep) || !existsSync(path) || !lstatSync(path).isDirectory()
        || lstatSync(path).isSymbolicLink()) {
        fail(`pnpm returned an unsafe store path: ${path}`);
    }
    return realpathSync(path);
}

function packageManagerEnvironment(home, scratch) {
    return {
        PATH: sanitizedPath(),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        HOME: home,
        TMPDIR: scratch,
        XDG_CACHE_HOME: join(home, 'cache'),
        NO_COLOR: '1',
        CI: '1',
        npm_config_registry: 'https://registry.npmjs.org/',
        npm_config_userconfig: '/dev/null',
    };
}

function assertDependencyLinksContained(workspace) {
    const roots = discoverDependencyRoots(workspace);
    const queue = [...roots];
    let entries = 0;
    while (queue.length) {
        const directory = queue.pop();
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            entries += 1;
            if (entries > 500_000) fail('historical dependency tree is unexpectedly large');
            const path = join(directory, entry.name);
            if (entry.isDirectory()) queue.push(path);
            else if (entry.isSymbolicLink()) {
                const target = resolve(dirname(path), readlinkSync(path));
                ensureInside(workspace, target);
                if (!existsSync(target)) fail(`historical dependency link is broken: ${path}`);
            } else if (!entry.isFile()) {
                fail(`historical dependency tree contains a special file: ${path}`);
            }
        }
    }
    return roots.length;
}

export function prepareDependencySnapshot({ protocol, source }) {
    const root = privateDirectory('cycle-model-lift-dependencies-');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const scratch = join(root, 'tmp');
    try {
        privateMkdir(workspace);
        privateMkdir(home);
        privateMkdir(scratch);
        const store = pnpmStorePath();
        writeTree(workspace, treeEntries(
            source,
            protocol.source.base,
            protocol.source.excluded_fixture_paths,
        ));
        applyOfflinePackageManagerOverlay(workspace, store);
        const env = packageManagerEnvironment(home, scratch);
        const version = run('pnpm', ['--pm-on-fail=ignore', '--version'], {
            cwd: workspace,
            env,
        }).stdout.trim();
        if (version !== protocol.execution.pnpm_version) {
            fail(`pnpm version mismatch: expected ${protocol.execution.pnpm_version}, got ${version}`);
        }
        run('pnpm', [
            '--pm-on-fail=ignore',
            'install',
            '--offline',
            '--frozen-lockfile',
            '--ignore-scripts',
            '--package-import-method=copy',
            '--store-dir', store,
        ], { cwd: workspace, env, timeout: 180_000 });
        const dependencyRoots = assertDependencyLinksContained(workspace);
        if (!existsSync(join(workspace, 'node_modules')) || dependencyRoots < 1) {
            fail('historical dependency snapshot has no root dependency tree');
        }
        return {
            workspace,
            store,
            dependency_roots: dependencyRoots,
            cleanup() { rmSync(root, { recursive: true, force: true }); },
        };
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
}

function fetchDependencyCache({ protocol, source }) {
    const root = privateDirectory('cycle-model-lift-fetch-');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const scratch = join(root, 'tmp');
    try {
        privateMkdir(workspace);
        privateMkdir(home);
        privateMkdir(scratch);
        const store = pnpmStorePath();
        writeTree(workspace, treeEntries(
            source,
            protocol.source.base,
            protocol.source.excluded_fixture_paths,
        ));
        applyOfflinePackageManagerOverlay(workspace, store);
        const env = packageManagerEnvironment(home, scratch);
        run('pnpm', [
            '--pm-on-fail=ignore',
            'fetch',
            '--store-dir', store,
        ], { cwd: workspace, env, timeout: 180_000 });
        return {
            store,
            base_lock_sha256: sha256(git(source, [
                'show', `${protocol.source.base}:pnpm-lock.yaml`,
            ], { encoding: null }).stdout),
            lifecycle_scripts: 'not-run',
        };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

export function materializeFixture({
    protocol,
    protocolPath,
    source,
    dependencySource = source,
    dependencyStore = null,
    mode,
    destination,
    dryRun,
    dependencies = true,
}) {
    privateMkdir(destination);
    if (dryRun) {
        writeFileSync(join(destination, 'package.json'), JSON.stringify({
            name: 'model-lift-dry-fixture',
            private: true,
            scripts: { test: 'node -e "process.exit(0)"' },
        }, null, 2));
        writeFileSync(join(destination, '.gitignore'), 'node_modules\n.pipeline-eval\n');
        writeFileSync(join(destination, 'AGENTS.md'), mode === 'neutral' ? NEUTRAL_AGENTS : '# Dry pipeline fixture\n');
    } else {
        writeTree(destination, treeEntries(
            source,
            protocol.source.base,
            protocol.source.excluded_fixture_paths,
        ));
        applyOfflinePackageManagerOverlay(destination, PNPM_RUNTIME_STORE);
        if (mode === 'pipeline') writeGuidance(destination, source, protocol);
        else writeFileSync(join(destination, 'AGENTS.md'), NEUTRAL_AGENTS);
    }
    writeControlAssets(destination, protocol, protocolPath);
    const initialCommit = initializeRepository(destination, protocol.execution.fixture_commit_time);
    const dependencyRoots = !dryRun && dependencies ? cloneDependencies(dependencySource, destination) : [];
    const packageManagerRuntime = !dryRun && dependencies
        ? preparePnpmRuntime(destination, dependencyStore)
        : null;
    if (git(destination, ['status', '--porcelain=v1']).stdout.trim()) {
        fail('fixture is dirty immediately after materialization');
    }
    return {
        initial_commit: initialCommit,
        git_directory: gitDirectoryIdentity(destination),
        dependency_roots: dependencyRoots,
        package_manager_runtime: packageManagerRuntime,
    };
}

function resolveAuthPath(codexHome) {
    return resolve(codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
}

function scanCandidateCredentials(workspace, initialCommit, authPath) {
    if (!authPath || !existsSync(authPath)) return;
    const values = [];
    for (const rel of changedPaths(workspace, initialCommit)) {
        const path = resolve(workspace, rel);
        ensureInside(workspace, path);
        if (!existsSync(path)) continue;
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`candidate changed an unsafe path: ${rel}`);
        if (stat.size <= MAX_CAPTURE_FILE) values.push(readFileSync(path));
    }
    const objects = git(workspace, ['rev-list', '--objects', '--all', '--not', initialCommit]).stdout
        .trim().split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
    for (const object of new Set(objects)) {
        if (git(workspace, ['cat-file', '-t', object]).stdout.trim() !== 'blob') continue;
        const size = Number(git(workspace, ['cat-file', '-s', object]).stdout.trim());
        if (Number.isSafeInteger(size) && size <= MAX_CAPTURE_FILE) {
            values.push(git(workspace, ['cat-file', 'blob', object], { encoding: null }).stdout);
        }
    }
    assertNoCredentialMaterial(values, authPath);
}

function verifyCandidateBoundary({ workspace, fixture, authPath }) {
    sanitizeCandidateRepository(workspace, fixture.git_directory);
    const roots = git(workspace, ['rev-list', '--max-parents=0', '--all']).stdout
        .trim().split('\n').filter(Boolean);
    if (stableJson(roots) !== stableJson([fixture.initial_commit])) {
        fail('candidate history no longer has exactly the frozen root');
    }
    if (git(workspace, ['remote']).stdout.trim()) fail('candidate created a Git remote');
    if (git(workspace, ['tag', '--list']).stdout.trim()) fail('candidate created a Git tag');
    const rootDependencies = join(workspace, 'node_modules');
    const expected = fixture.dependency_roots.find((entry) => entry.rel === 'node_modules');
    if (expected) {
        const actual = lstatSync(rootDependencies);
        if (!actual.isDirectory() || actual.isSymbolicLink()
            || actual.dev !== expected.dev || actual.ino !== expected.ino) {
            fail('candidate replaced its physical root dependency tree');
        }
    }
    const paths = changedPaths(workspace, fixture.initial_commit);
    for (const rel of paths) {
        const path = resolve(workspace, rel);
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
            fail(`candidate changed a symlink path: ${rel}`);
        }
        if (/^(?:\.env(?:\.|$)|auth\.json$|.*credentials)/i.test(rel)) {
            fail(`candidate created a credential-shaped path: ${rel}`);
        }
        if (/(^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.[^/]*)?\.json|biome\.jsonc?)$/.test(rel)) {
            fail(`candidate changed an evaluator-owned gate control: ${rel}`);
        }
    }
    scanCandidateCredentials(workspace, fixture.initial_commit, authPath);
    return {
        root_commit: fixture.initial_commit,
        changed_paths: paths,
        remotes: 0,
        tags: 0,
        dependency_root_preserved: Boolean(expected),
        credential_scan: 'pass',
    };
}

function applySourceFiles(source, revision, paths, destination) {
    for (const rel of paths) {
        const target = resolve(destination, rel);
        ensureInside(destination, target);
        const exists = git(source, ['cat-file', '-e', `${revision}:${rel}`], { allowFailure: true }).status === 0;
        if (!exists) {
            rmSync(target, { recursive: true, force: true });
            continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, git(source, ['show', `${revision}:${rel}`], { encoding: null }).stdout);
    }
}

function applyPatch(workspace, patch) {
    const result = run('/usr/bin/git', ['apply', '--whitespace=nowarn', '-'], {
        cwd: workspace,
        input: patch,
        encoding: null,
        allowFailure: true,
    });
    if (result.status !== 0) {
        fail(`cannot apply frozen alternative patch\n${result.stderr?.toString('utf8') ?? ''}`.trimEnd());
    }
}

function copyCandidateDelta(workspace, initialCommit, destination) {
    for (const rel of changedPaths(workspace, initialCommit)) {
        if (isExcluded(rel, [
            '.agents', '.claude', '.codex', '.cycle', '.git', CONTROL,
            'AGENTS.md', 'CLAUDE.md', 'node_modules',
        ])) continue;
        const sourcePath = resolve(workspace, rel);
        const target = resolve(destination, rel);
        ensureInside(workspace, sourcePath);
        ensureInside(destination, target);
        if (!existsSync(sourcePath)) {
            rmSync(target, { recursive: true, force: true });
            continue;
        }
        const stat = lstatSync(sourcePath);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`candidate delta contains an unsafe path: ${rel}`);
        if (stat.size > MAX_CAPTURE_FILE) fail(`candidate delta file is too large: ${rel}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(sourcePath));
        chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
    }
}

export function prepareVerifier({
    protocol,
    protocolPath,
    source,
    dependencySource = source,
    dependencyStore = null,
    destination,
    candidate = null,
    fixture = null,
}) {
    privateMkdir(destination);
    writeTree(destination, treeEntries(
        source,
        protocol.source.base,
        protocol.source.excluded_fixture_paths,
    ));
    applyOfflinePackageManagerOverlay(destination, PNPM_RUNTIME_STORE);
    writeGuidance(destination, source, protocol);
    if (candidate && fixture) copyCandidateDelta(candidate, fixture.initial_commit, destination);
    const oracleTarget = resolve(destination, protocol.task.oracle_destination);
    ensureInside(destination, oracleTarget);
    mkdirSync(dirname(oracleTarget), { recursive: true });
    writeFileSync(oracleTarget, readFileSync(protocolAsset(protocolPath, protocol.task.oracle_path)));
    writeControlAssets(destination, protocol, protocolPath);
    cloneDependencies(dependencySource, destination);
    preparePnpmRuntime(destination, dependencyStore);
    return destination;
}

function executablePath(command) {
    for (const directory of sanitizedPath().split(':')) {
        const path = resolve(directory, command);
        if (!existsSync(path)) continue;
        const target = realpathSync(path);
        if (statSync(target).isFile()) return target;
    }
    fail(`cannot resolve verifier executable: ${command}`);
}

function runtimeRoot(executable) {
    if (executable === '/usr/bin' || executable.startsWith('/usr/')) return null;
    const marker = `${sep}Cellar${sep}`;
    if (executable.includes(marker)) return executable.slice(0, executable.indexOf(marker));
    fail(`unsupported verifier runtime path: ${executable}`);
}

function bwrapDirectoryArgs(path) {
    const parent = dirname(path);
    const directories = [];
    let current = parent;
    while (current !== sep) {
        directories.unshift(current);
        current = dirname(current);
    }
    return directories.flatMap((directory) => ['--dir', directory]);
}

export function verifierSandboxArgs(workspace, command) {
    const workspacePath = realpathSync(workspace);
    ensureInside(realpathSync(tmpdir()), workspacePath);
    const node = executablePath('node');
    const pnpm = executablePath('pnpm');
    const runtimeRoots = [...new Set([runtimeRoot(node), runtimeRoot(pnpm)].filter(Boolean))];
    const scratch = join(workspacePath, CONTROL_TMP);
    const args = [
        '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session',
        '--cap-drop', 'ALL',
        '--ro-bind', '/usr', '/usr',
        '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64',
    ];
    for (const root of runtimeRoots) {
        args.push(...bwrapDirectoryArgs(root), '--ro-bind', root, root);
    }
    args.push(
        '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
        '--bind', workspacePath, workspacePath,
        '--chdir', workspacePath,
        '--clearenv',
        '--setenv', 'HOME', '/nonexistent',
        '--setenv', 'PATH', [
            ...runtimeRoots.map((root) => join(root, 'bin')),
            '/usr/bin', '/bin',
        ].join(':'),
        '--setenv', 'TMPDIR', scratch,
        '--setenv', 'NPM_CONFIG_CACHE', join(scratch, 'npm-cache'),
        '--setenv', 'XDG_CACHE_HOME', join(scratch, 'xdg-cache'),
        '--setenv', 'LANG', 'C.UTF-8',
        '--setenv', 'LC_ALL', 'C.UTF-8',
        '--setenv', 'NO_COLOR', '1',
        '--setenv', 'CI', '1',
        '--setenv', 'NEXT_TELEMETRY_DISABLED', '1',
        '--setenv', 'NEXT_FONT_GOOGLE_MOCKED_RESPONSES', join(workspacePath, CONTROL, 'next-font-mocks.cjs'),
        '--setenv', 'GIT_CONFIG_NOSYSTEM', '1',
        '--setenv', 'GIT_CONFIG_GLOBAL', '/dev/null',
        '--setenv', 'GIT_AUTHOR_NAME', 'Pipeline Verifier',
        '--setenv', 'GIT_AUTHOR_EMAIL', 'verifier@example.invalid',
        '--setenv', 'GIT_COMMITTER_NAME', 'Pipeline Verifier',
        '--setenv', 'GIT_COMMITTER_EMAIL', 'verifier@example.invalid',
        '/bin/sh', '-c', command,
    );
    return args;
}

export function verifierCommand({ protocol, workspace, command }) {
    const bwrap = executablePath('bwrap');
    const result = run(bwrap, verifierSandboxArgs(workspace, command), {
        cwd: workspace,
        env: { PATH: sanitizedPath(), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        timeout: protocol.execution.timeout_ms_per_turn,
        allowFailure: true,
    });
    return {
        command,
        status: result.status ?? 2,
        signal: result.signal ?? null,
        error: result.error ? {
            code: result.error.code ?? null,
            message: result.error.message,
        } : null,
        elapsed_ms: result.elapsedMs,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
}

function runCommands({ protocol, workspace, commands, stopOnFailure }) {
    const records = [];
    for (const command of commands) {
        const record = verifierCommand({ protocol, workspace, command });
        records.push(record);
        if (stopOnFailure && record.status !== 0) break;
    }
    return {
        status: records.every((record) => record.status === 0) ? 'pass' : 'fail',
        records,
    };
}

function verifyCandidate({
    protocol, protocolPath, source, dependencySource, dependencyStore, candidate, fixture,
}) {
    const root = privateDirectory('cycle-model-lift-candidate-verifier-');
    const workspace = join(root, 'workspace');
    try {
        prepareVerifier({
            protocol,
            protocolPath,
            source,
            dependencySource,
            dependencyStore,
            destination: workspace,
            candidate,
            fixture,
        });
        const hidden = runCommands({
            protocol,
            workspace,
            commands: protocol.gates.hidden_oracle,
            stopOnFailure: true,
        });
        const gates = runCommands({
            protocol,
            workspace,
            commands: protocol.gates.candidate_matrix,
            stopOnFailure: false,
        });
        return { hidden_oracle: hidden, gate_matrix: gates };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function oracleFailure(result) {
    const failed = result.records.find((record) => record.status !== 0) ?? result.records.at(-1);
    if (!failed) return 'no command ran';
    const output = [failed.stderr, failed.stdout]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .join('\n');
    const termination = failed.error
        ? `\nspawn error ${failed.error.code ?? 'unknown'}: ${failed.error.message}`
        : failed.signal ? `\nsignal: ${failed.signal}` : '';
    return `${failed.command} (${failed.status})${termination}${output ? `\n${output}` : ''}`;
}

function verifyFrozenOracle({
    protocol, protocolPath, source, dependencySource, dependencyStore,
}) {
    const runVariant = (kind, setup) => {
        const root = privateDirectory(`cycle-model-lift-oracle-${kind}-`);
        const workspace = join(root, 'workspace');
        try {
            prepareVerifier({
                protocol,
                protocolPath,
                source,
                dependencySource,
                dependencyStore,
                destination: workspace,
            });
            setup(workspace);
            return runCommands({
                protocol,
                workspace,
                commands: protocol.gates.hidden_oracle,
                stopOnFailure: true,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    };
    const base = runVariant('base', () => {});
    if (base.status !== 'fail') fail('hidden oracle unexpectedly passed on the frozen base');
    const repaired = runVariant('historical-repair', (workspace) => {
        applySourceFiles(source, protocol.source.repair, protocol.task.repair_paths, workspace);
    });
    if (repaired.status !== 'pass') fail(`hidden oracle failed on the accepted repair\n${oracleFailure(repaired)}`);
    const alternative = runVariant('alternative-repair', (workspace) => {
        applyPatch(workspace, readFileSync(protocolAsset(protocolPath, protocol.task.alternative_patch_path)));
    });
    if (alternative.status !== 'pass') fail(`hidden oracle failed on the alternative repair\n${oracleFailure(alternative)}`);
    const mutation = runVariant('repair-removed', (workspace) => {
        applySourceFiles(source, protocol.source.repair, protocol.task.repair_paths, workspace);
        applySourceFiles(source, protocol.source.base, protocol.task.repair_paths, workspace);
    });
    if (mutation.status !== 'fail') fail('repair-removal mutation did not turn the hidden oracle red');
    return {
        base: 'fail',
        historical_repair: 'pass',
        independently_structured_repair: 'pass',
        accepted_repair_removed: 'fail',
    };
}

function usageSum(lifecycles) {
    const totals = {};
    let reportedTurns = 0;
    for (const turn of lifecycles.flatMap((lifecycle) => lifecycle.turns)) {
        if (!turn.usage || typeof turn.usage !== 'object') continue;
        reportedTurns += 1;
        for (const [key, value] of Object.entries(turn.usage)) {
            if (typeof value === 'number' && Number.isFinite(value)) {
                totals[key] = (totals[key] ?? 0) + value;
            }
        }
    }
    return { reported_turns: reportedTurns, totals };
}

function artifactManifest(output, runDir) {
    const files = [];
    const queue = [runDir];
    while (queue.length) {
        const directory = queue.pop();
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) queue.push(path);
            else if (entry.isFile() && entry.name !== 'result.json') files.push(path);
            else if (!entry.isFile()) fail(`private artifact tree contains a special file: ${path}`);
        }
    }
    return Object.fromEntries(files.sort().map((path) => [relative(output, path), sha256(readFileSync(path))]));
}

function normalizeVerification(verification, output, runDir, arm) {
    const path = join(runDir, 'verification', `${arm}.json`);
    const privateValue = {
        hidden_oracle: verification.hidden_oracle.records,
        gate_matrix: verification.gate_matrix.records,
    };
    privateWrite(path, `${JSON.stringify(privateValue, null, 2)}\n`);
    return {
        hidden_oracle: verification.hidden_oracle.status,
        gate_matrix: verification.gate_matrix.records.map((record) => ({
            command: record.command,
            status: record.status,
            elapsed_ms: record.elapsed_ms,
        })),
        private_output: relative(output, path),
    };
}

function executeModelAttempt({
    protocol,
    protocolPath,
    source,
    dependencySource,
    dependencyStore,
    output,
    modelEntry,
    attempt,
    codexBin,
    codexHome,
    dryRun,
}) {
    const privateRoot = privateDirectory(`cycle-model-lift-${modelEntry.id}-`);
    const runName = `${modelEntry.id}-a${attempt}`;
    const runDir = join(output, 'private', 'runs', runName);
    privateMkdir(runDir);
    const rawRequest = readFileSync(protocolAsset(protocolPath, protocol.task.raw_prompt_path), 'utf8');
    const issueBody = readFileSync(protocolAsset(protocolPath, protocol.task.canonical_issue_path), 'utf8');
    const issueTitle = protocol.task.title;
    const lifecycles = [];
    const arms = [];
    const invalid = [];
    let intakeArtifact = null;
    try {
        const intakeWorkspace = join(privateRoot, 'intake-only');
        materializeFixture({
            protocol, protocolPath, source, dependencySource, dependencyStore,
            mode: 'pipeline', destination: intakeWorkspace,
            dryRun, dependencies: false,
        });
        const intake = runLifecycle({
            protocol,
            protocolPath,
            output,
            item: protocol.task,
            workspace: intakeWorkspace,
            runDir,
            codexBin,
            model: modelEntry.model,
            effort: protocol.execution.reasoning_effort,
            timeoutMs: protocol.execution.timeout_ms_per_turn,
            codexHome,
            dryRun,
            arm: 'intake-only',
            stage: 'intake',
            attempt,
            prompt: turnPrompt(protocol, protocolPath, { stage: 'intake', rawRequest }),
            canonicalIssue: issueBody,
            sessionId: `${protocol.task.id}-${modelEntry.id}-intake-a${attempt}`,
        });
        lifecycles.push(intake);
        invalid.push(...lifecycleInvalid(intake).map((reason) => `intake-only: ${reason}`));
        const creates = trackerCreates(intake.turns);
        if (creates.length !== 1 || !isNonEmptyString(creates[0].title) || !isNonEmptyString(creates[0].body)) {
            invalid.push(`intake-only created ${creates.length} complete issues instead of exactly one`);
        } else {
            const titlePath = join(runDir, 'intake', 'title.txt');
            const bodyPath = join(runDir, 'intake', 'body.md');
            privateWrite(titlePath, `${creates[0].title}\n`);
            privateWrite(bodyPath, creates[0].body);
            intakeArtifact = {
                title: relative(output, titlePath),
                body: relative(output, bodyPath),
                title_sha256: sha256(creates[0].title),
                body_sha256: sha256(creates[0].body),
            };
        }
        rmSync(intakeWorkspace, { recursive: true, force: true });

        for (const arm of ['raw-direct', 'shaped-direct']) {
            if (invalid.length) break;
            const workspace = join(privateRoot, arm);
            const fixture = materializeFixture({
                protocol, protocolPath, source, dependencySource, dependencyStore,
                mode: 'neutral', destination: workspace, dryRun,
            });
            const shaped = arm === 'shaped-direct' ? issueEnvelope(issueTitle, issueBody) : null;
            const lifecycle = runLifecycle({
                protocol,
                protocolPath,
                output,
                item: protocol.task,
                workspace,
                runDir,
                codexBin,
                model: modelEntry.model,
                effort: protocol.execution.reasoning_effort,
                timeoutMs: protocol.execution.timeout_ms_per_turn,
                codexHome,
                dryRun,
                arm,
                stage: 'direct',
                attempt,
                prompt: turnPrompt(protocol, protocolPath, {
                    stage: 'direct',
                    rawRequest,
                    shapedIssue: shaped,
                }),
                sessionId: `${protocol.task.id}-${modelEntry.id}-${arm}-a${attempt}`,
                writablePaths: fixture.package_manager_runtime?.writablePaths ?? [],
            });
            lifecycles.push(lifecycle);
            invalid.push(...lifecycleInvalid(lifecycle).map((reason) => `${arm}: ${reason}`));
            if (!lifecycle.valid) {
                rmSync(workspace, { recursive: true, force: true });
                break;
            }
            const snapshot = snapshotWorkspace({
                output, runDir, workspace, fixture, arm, stage: 'final',
            });
            const authPath = dryRun ? null : resolveAuthPath(codexHome);
            const boundary = dryRun
                ? { status: 'not-run' }
                : verifyCandidateBoundary({ workspace, fixture, authPath });
            const verification = dryRun
                ? { hidden_oracle: { status: 'not-run', records: [] }, gate_matrix: { status: 'not-run', records: [] } }
                : verifyCandidate({
                    protocol, protocolPath, source, dependencySource, dependencyStore,
                    candidate: workspace, fixture,
                });
            arms.push({
                arm,
                input_sha256: arm === 'raw-direct' ? sha256(rawRequest) : issueEnvelopeHash(issueTitle, issueBody),
                lifecycle: [lifecycleSummary(lifecycle)],
                usage: usageSum([lifecycle]),
                command_evidence: commandEvidence(lifecycle.turns, workspace),
                snapshots: [snapshot],
                final_diff: snapshot.diff,
                final_diff_sha256: snapshot.diff_sha256,
                changed_paths: snapshot.changed_paths,
                boundary,
                verification: normalizeVerification(verification, output, runDir, arm),
            });
            rmSync(workspace, { recursive: true, force: true });
        }

        if (!invalid.length) {
            const arm = 'full-cycle';
            const workspace = join(privateRoot, arm);
            const fixture = materializeFixture({
                protocol, protocolPath, source, dependencySource, dependencyStore,
                mode: 'pipeline', destination: workspace, dryRun,
            });
            const session = persistentSession({
                codexHome,
                dryRun,
                codexBin,
                workspace,
                issueBody,
                issueTitle,
                writablePaths: fixture.package_manager_runtime?.writablePaths ?? [],
            });
            const armLifecycles = [];
            const snapshots = [];
            let threadId = null;
            try {
                for (const [index, stage] of protocol.execution.full_cycle.resumed_stages.entries()) {
                    const lifecycle = runLifecycle({
                        protocol,
                        protocolPath,
                        output,
                        item: protocol.task,
                        workspace,
                        runDir,
                        codexBin,
                        model: modelEntry.model,
                        effort: protocol.execution.reasoning_effort,
                        timeoutMs: protocol.execution.timeout_ms_per_turn,
                        codexHome,
                        dryRun,
                        arm,
                        stage,
                        attempt,
                        prompt: turnPrompt(protocol, protocolPath, { stage }),
                        issueBody,
                        issueTitle,
                        threadId,
                        sessionId: `${protocol.task.id}-${modelEntry.id}-${arm}-a${attempt}`,
                        sessionContext: session,
                    });
                    armLifecycles.push(lifecycle);
                    lifecycles.push(lifecycle);
                    invalid.push(...lifecycleInvalid(lifecycle).map((reason) => `${arm}/${stage}: ${reason}`));
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
                        stage: protocol.execution.full_cycle.snapshot_labels[index],
                    }));
                }
            } finally {
                session.cleanup();
            }
            if (!invalid.length && snapshots.length === 5) {
                const authPath = dryRun ? null : resolveAuthPath(codexHome);
                const boundary = dryRun
                    ? { status: 'not-run' }
                    : verifyCandidateBoundary({ workspace, fixture, authPath });
                const verification = dryRun
                    ? { hidden_oracle: { status: 'not-run', records: [] }, gate_matrix: { status: 'not-run', records: [] } }
                    : verifyCandidate({
                        protocol, protocolPath, source, dependencySource, dependencyStore,
                        candidate: workspace, fixture,
                    });
                arms.push({
                    arm,
                    input_sha256: issueEnvelopeHash(issueTitle, issueBody),
                    lifecycle: armLifecycles.map(lifecycleSummary),
                    usage: usageSum(armLifecycles),
                    command_evidence: commandEvidence(
                        armLifecycles.flatMap((lifecycle) => lifecycle.turns),
                        workspace,
                    ),
                    snapshots,
                    final_diff: snapshots.at(-1).diff,
                    final_diff_sha256: snapshots.at(-1).diff_sha256,
                    changed_paths: snapshots.at(-1).changed_paths,
                    boundary,
                    verification: normalizeVerification(verification, output, runDir, arm),
                });
            } else if (!invalid.length) {
                invalid.push(`full-cycle captured ${snapshots.length} snapshots instead of five`);
            }
            rmSync(workspace, { recursive: true, force: true });
        }

        if (!invalid.length) {
            if (arms.length !== 3) invalid.push(`captured ${arms.length} implementation arms instead of three`);
            const expected = issueEnvelopeHash(issueTitle, issueBody);
            for (const arm of arms.filter((entry) => entry.arm !== 'raw-direct')) {
                if (arm.input_sha256 !== expected) invalid.push(`${arm.arm} did not receive the canonical issue bytes`);
            }
        }
        const turns = lifecycles.flatMap((lifecycle) => lifecycle.turns);
        const invalidationClass = invalid.length === 0 ? null
            : turns.some((turn) => turn.infrastructure_failure) ? 'infrastructure' : 'behavioral';
        const result = {
            study_id: protocol.study_id,
            model_id: modelEntry.id,
            model: modelEntry.model,
            reasoning_effort: protocol.execution.reasoning_effort,
            attempt,
            valid: invalid.length === 0,
            invalidation_class: invalidationClass,
            invalid_reasons: invalid,
            raw_request_sha256: sha256(rawRequest),
            canonical_issue_sha256: sha256(issueBody),
            canonical_issue_envelope_sha256: issueEnvelopeHash(issueTitle, issueBody),
            intake: intakeArtifact,
            lifecycle: lifecycles.map(lifecycleSummary),
            usage: usageSum(lifecycles),
            model_turns_started: turns.filter((turn) => turn.model_turn_started).length,
            model_turns_completed: turns.filter((turn) => turn.model_turn_completed).length,
            arms,
        };
        result.artifacts = artifactManifest(output, runDir);
        privateWrite(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
        return result;
    } finally {
        rmSync(privateRoot, { recursive: true, force: true });
    }
}

function codexVersion(codexBin) {
    return run(codexBin, ['--version'], {
        env: { PATH: sanitizedPath(), LANG: 'C.UTF-8', HOME: '/nonexistent' },
    }).stdout.trim();
}

function verifierRuntime(protocol) {
    const node = run(executablePath('node'), ['--version'], {
        env: { PATH: sanitizedPath(), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    }).stdout.trim();
    const sandbox = run(executablePath('bwrap'), ['--version'], {
        env: { PATH: sanitizedPath(), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    }).stdout.trim();
    if (node !== protocol.execution.node_version) {
        fail(`Node version mismatch: expected ${protocol.execution.node_version}, got ${node}`);
    }
    if (sandbox !== protocol.execution.verifier_sandbox) {
        fail(`verifier sandbox mismatch: expected ${protocol.execution.verifier_sandbox}, got ${sandbox}`);
    }
    return { node_version: node, sandbox, network: 'unshared', host_home: 'not-mounted' };
}

function preflight({
    protocol, protocolPath, source, dependencySource, dependencyStore, output, codexBin,
}) {
    assertArtifactLock(protocol, protocolPath, source);
    const version = codexVersion(codexBin);
    if (version !== protocol.execution.codex_version) {
        fail(`Codex version mismatch: expected ${protocol.execution.codex_version}, got ${version}`);
    }
    const verifier = verifierRuntime(protocol);
    const config = probePipelineConfig(codexBin);
    const isolation = probeIsolation(codexBin, { writableDependencies: true });
    const oracle = verifyFrozenOracle({
        protocol, protocolPath, source, dependencySource, dependencyStore,
    });
    const fixtureRoot = privateDirectory('cycle-model-lift-runtime-');
    let fixture;
    let gateMatrix;
    try {
        const workspace = join(fixtureRoot, 'workspace');
        fixture = materializeFixture({
            protocol,
            protocolPath,
            source,
            dependencySource,
            dependencyStore,
            mode: 'pipeline',
            destination: workspace,
            dryRun: false,
        });
        const packageManager = verifierCommand({
            protocol,
            workspace,
            command: 'pnpm --version',
        });
        if (packageManager.status !== 0) {
            fail(`pnpm version preflight failed\n${oracleFailure({ records: [packageManager] })}`);
        }
        gateMatrix = runCommands({
            protocol,
            workspace,
            commands: protocol.gates.candidate_matrix,
            stopOnFailure: false,
        });
        if (gateMatrix.status !== 'pass') {
            fail(`candidate gate preflight failed\n${oracleFailure(gateMatrix)}`);
        }
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
    const result = {
        study_id: protocol.study_id,
        protocol_sha256: sha256(readFileSync(protocolPath)),
        artifact_lock: 'pass',
        codex_version: version,
        verifier,
        config,
        isolation,
        fixture: {
            history_roots: 1,
            remote_count: 0,
            physical_dependency_roots: fixture.dependency_roots.length,
        },
        pnpm_version: protocol.execution.pnpm_version,
        oracle,
        candidate_gate_matrix: gateMatrix.records.map((record) => ({
            command: record.command,
            status: record.status,
            elapsed_ms: record.elapsed_ms,
        })),
        scored_model_calls: 0,
    };
    privateWrite(join(output, 'preflight.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
}

function resultIndexPath(output) {
    return join(output, 'private', 'results.json');
}

function readResults(output) {
    const path = resultIndexPath(output);
    if (!existsSync(path)) return [];
    let results;
    try { results = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { fail(`invalid resumable result index: ${error.message}`); }
    if (!Array.isArray(results)) fail('resumable result index must be an array');
    return results;
}

function writeResults(output, results) {
    privateWrite(resultIndexPath(output), `${JSON.stringify(results, null, 2)}\n`);
}

function validatePersistedResult(protocol, output, result, expectedModel, expectedAttempt) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        fail('resumable result is not an object');
    }
    const identity = {
        study_id: protocol.study_id,
        model_id: expectedModel.id,
        model: expectedModel.model,
        reasoning_effort: protocol.execution.reasoning_effort,
        attempt: expectedAttempt,
    };
    for (const [key, value] of Object.entries(identity)) {
        if (result[key] !== value) fail(`resumable result identity mismatch: ${key}`);
    }
    if (typeof result.valid !== 'boolean'
        || !Array.isArray(result.invalid_reasons)
        || !Array.isArray(result.lifecycle)
        || !result.artifacts || typeof result.artifacts !== 'object') {
        fail(`resumable result for ${expectedModel.id} has invalid status fields`);
    }
    if (result.valid !== (result.invalid_reasons.length === 0)
        || result.invalidation_class !== classifyAttemptInvalidation({
            valid: result.valid,
            lifecycles: result.lifecycle,
        })) {
        fail(`resumable result for ${expectedModel.id} has inconsistent invalidation fields`);
    }
    if (result.valid && (result.arms?.length !== 3 || !result.intake)) {
        fail(`valid resumable result for ${expectedModel.id} is missing arms or intake`);
    }
    const runName = `${expectedModel.id}-a${expectedAttempt}`;
    const expectedPrefix = `private/runs/${runName}/`;
    for (const [rel, digest] of Object.entries(result.artifacts)) {
        if (!rel.startsWith(expectedPrefix) || rel.endsWith('/result.json')) {
            fail(`resumable result has an unexpected artifact path: ${rel}`);
        }
        validateArtifactFile(output, rel, digest);
    }
    const resultPath = join(output, expectedPrefix, 'result.json');
    if (!existsSync(resultPath) || !lstatSync(resultPath).isFile()
        || lstatSync(resultPath).isSymbolicLink() || (lstatSync(resultPath).mode & 0o077) !== 0) {
        fail(`missing private result artifact for ${expectedModel.id} attempt ${expectedAttempt}`);
    }
    let persisted;
    try { persisted = JSON.parse(readFileSync(resultPath, 'utf8')); }
    catch (error) { fail(`invalid private result artifact for ${expectedModel.id}: ${error.message}`); }
    if (stableJson(persisted) !== stableJson(result)) {
        fail(`resumable result index disagrees with ${relative(output, resultPath)}`);
    }
}

function progress(protocol, output, results) {
    let cursor = 0;
    const accepted = new Map();
    models:
    for (const modelId of protocol.schedule.model_order) {
        const model = protocol.models.find((entry) => entry.id === modelId);
        const attempts = [];
        for (let attempt = 1;
            attempt <= protocol.schedule.retry_limits.max_attempts_per_model;
            attempt += 1) {
            if (cursor === results.length) {
                return { accepted, next: model, terminal: null, complete: false };
            }
            const result = results[cursor];
            validatePersistedResult(protocol, output, result, model, attempt);
            cursor += 1;
            attempts.push(result);
            if (result.valid) {
                accepted.set(modelId, result);
                continue models;
            }
            const failuresOfClass = attempts.filter((entry) =>
                entry.invalidation_class === result.invalidation_class).length;
            if (attempts.length >= protocol.schedule.retry_limits.max_attempts_per_model
                || failuresOfClass > protocol.schedule.retry_limits[result.invalidation_class]) {
                if (cursor !== results.length) {
                    fail('resumable results continue after a terminal invalid model');
                }
                return { accepted, next: null, terminal: modelId, complete: false };
            }
        }
    }
    if (cursor !== results.length) fail('resumable results are not an exact prefix of the frozen model order');
    return { accepted, next: null, terminal: null, complete: accepted.size === protocol.models.length };
}

function copyPrivateArtifact(output, rel, target) {
    const source = resolve(output, rel);
    ensureInside(output, source);
    if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
        fail(`missing private scoring source: ${rel}`);
    }
    privateWrite(target, readFileSync(source));
}

function writeScoringArtifacts({ protocol, protocolPath, output, accepted }) {
    const root = join(output, 'scoring');
    if (existsSync(root)) fail('scoring artifacts already exist');
    privateMkdir(root);
    const candidates = [];
    for (const modelId of protocol.schedule.model_order) {
        const result = accepted.get(modelId);
        for (const arm of result.arms) candidates.push({ modelId, result, arm });
    }
    candidates.sort((left, right) => sha256(
        `${protocol.schedule.seed}:${left.modelId}:${left.arm.arm}`,
    ).localeCompare(sha256(`${protocol.schedule.seed}:${right.modelId}:${right.arm.arm}`)));
    const map = { outputs: [], intake: [] };
    const outputs = candidates.map((candidate, index) => {
        const label = `O${index + 1}`;
        const diffPath = join(root, 'diffs', `${label}.diff`);
        copyPrivateArtifact(output, candidate.arm.final_diff, diffPath);
        const snapshotPaths = {};
        if (candidate.arm.arm === 'full-cycle') {
            for (const snapshot of candidate.arm.snapshots.filter((entry) =>
                ['implement', 'patch', 'finding-closure'].includes(entry.stage))) {
                const target = join(root, 'snapshots', `${label}-${snapshot.stage}.diff`);
                copyPrivateArtifact(output, snapshot.diff, target);
                snapshotPaths[snapshot.stage] = relative(output, target);
            }
        }
        map.outputs.push({ label, model_id: candidate.modelId, arm: candidate.arm.arm });
        return {
            label,
            diff: relative(output, diffPath),
            changed_paths: candidate.arm.changed_paths,
            hidden_oracle: candidate.arm.verification.hidden_oracle,
            gate_matrix: candidate.arm.verification.gate_matrix,
            command_evidence: candidate.arm.command_evidence,
            snapshots: snapshotPaths,
        };
    });
    const intakeCandidates = protocol.schedule.model_order.map((modelId) => ({
        modelId,
        result: accepted.get(modelId),
    })).sort((left, right) => sha256(
        `${protocol.schedule.seed}:intake:${left.modelId}`,
    ).localeCompare(sha256(`${protocol.schedule.seed}:intake:${right.modelId}`)));
    const intake = intakeCandidates.map((candidate, index) => {
        const label = `I${index + 1}`;
        const titlePath = join(root, 'intake', `${label}-title.txt`);
        const bodyPath = join(root, 'intake', `${label}-body.md`);
        copyPrivateArtifact(output, candidate.result.intake.title, titlePath);
        copyPrivateArtifact(output, candidate.result.intake.body, bodyPath);
        map.intake.push({ label, model_id: candidate.modelId });
        return {
            label,
            title: relative(output, titlePath),
            body: relative(output, bodyPath),
        };
    });
    const packet = {
        version: 1,
        packet_id: sha256(`${protocol.study_id}:${sha256(readFileSync(protocolPath))}`).slice(0, 16),
        task: {
            title: protocol.task.title,
            canonical_issue: readFileSync(protocolAsset(protocolPath, protocol.task.canonical_issue_path), 'utf8'),
        },
        rubric: {
            primary: protocol.scoring.primary,
            implementation_dimensions: protocol.scoring.implementation_dimensions,
            intake_dimensions: protocol.scoring.intake_dimensions,
        },
        outputs,
        intake,
    };
    privateWrite(join(root, 'scoring-input.json'), `${JSON.stringify(packet, null, 2)}\n`);
    const blindingBytes = Buffer.from(`${JSON.stringify(map, null, 2)}\n`);
    privateWrite(join(output, 'private', 'blinding-map.json'), blindingBytes);
    privateWrite(join(root, 'score.schema.json'), readFileSync(protocolAsset(protocolPath, protocol.scoring.schema_path)));
    const files = recursiveFiles(root).map((path) => ({
        path: relative(output, path),
        sha256: sha256(readFileSync(path)),
    }));
    privateWrite(join(root, 'manifest.json'), `${JSON.stringify({
        output_count: outputs.length,
        intake_count: intake.length,
        blinding_map_sha256: sha256(blindingBytes),
        files,
    }, null, 2)}\n`);
    return packet;
}

function validateScoringArtifacts(output) {
    const manifestPath = join(output, 'scoring', 'manifest.json');
    if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()
        || lstatSync(manifestPath).isSymbolicLink() || (lstatSync(manifestPath).mode & 0o077) !== 0) {
        fail('missing or unsafe resumable scoring manifest');
    }
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (error) { fail(`invalid resumable scoring manifest: ${error.message}`); }
    if (manifest.output_count !== 6 || manifest.intake_count !== 2
        || !Array.isArray(manifest.files) || !/^[0-9a-f]{64}$/.test(manifest.blinding_map_sha256 ?? '')) {
        fail('resumable scoring manifest has invalid counts or hashes');
    }
    const expectedPaths = [];
    for (const entry of manifest.files) {
        if (!isNonEmptyString(entry?.path) || !entry.path.startsWith('scoring/')
            || entry.path === 'scoring/manifest.json' || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
            fail('resumable scoring manifest has an invalid file record');
        }
        expectedPaths.push(entry.path);
        validateArtifactFile(output, entry.path, entry.sha256);
    }
    if (new Set(expectedPaths).size !== expectedPaths.length) {
        fail('resumable scoring manifest contains duplicate paths');
    }
    validateArtifactFile(output, 'private/blinding-map.json', manifest.blinding_map_sha256);
    const actualPaths = recursiveFiles(join(output, 'scoring'))
        .map((path) => relative(output, path))
        .filter((path) => path !== 'scoring/manifest.json')
        .sort();
    if (stableJson(actualPaths) !== stableJson(expectedPaths.sort())) {
        fail('resumable scoring files disagree with the manifest');
    }
    return manifest;
}

function experimentRecord({ protocol, protocolPath, dryRun, codexVersionValue }) {
    return {
        study_id: protocol.study_id,
        protocol_sha256: sha256(readFileSync(protocolPath)),
        dry_run: dryRun,
        codex_version: codexVersionValue,
        model_order: protocol.schedule.model_order,
        reasoning_effort: protocol.execution.reasoning_effort,
    };
}

function loadOrCreateExperiment({ protocol, protocolPath, output, dryRun, codexVersionValue }) {
    const path = join(output, 'private', 'experiment.json');
    const expected = experimentRecord({ protocol, protocolPath, dryRun, codexVersionValue });
    if (!existsSync(path)) {
        privateWrite(path, `${JSON.stringify(expected, null, 2)}\n`);
        return expected;
    }
    const actual = JSON.parse(readFileSync(path, 'utf8'));
    if (stableJson(actual) !== stableJson(expected)) fail('resumable experiment identity changed');
    return actual;
}

function summarize(protocol, results) {
    const accepted = protocol.schedule.model_order.flatMap((modelId) => {
        const result = results.find((entry) => entry.model_id === modelId && entry.valid);
        return result ? [result] : [];
    });
    return {
        accepted_models: accepted.map((result) => result.model_id),
        total_models: protocol.models.length,
        attempts: results.length,
        invalid_attempts: results.filter((result) => !result.valid).length,
        model_turns_started: results.reduce((sum, result) => sum + result.model_turns_started, 0),
        model_turns_completed: results.reduce((sum, result) => sum + result.model_turns_completed, 0),
        complete: accepted.length === protocol.models.length,
    };
}

function executeBatch({
    protocol,
    protocolPath,
    source,
    dependencySource,
    dependencyStore,
    output,
    codexBin,
    codexHome,
    dryRun,
    allModels,
}) {
    const version = codexVersion(codexBin);
    if (!dryRun && version !== protocol.execution.codex_version) {
        fail(`Codex version mismatch: expected ${protocol.execution.codex_version}, got ${version}`);
    }
    loadOrCreateExperiment({ protocol, protocolPath, output, dryRun, codexVersionValue: version });
    let results = readResults(output);
    let state = progress(protocol, output, results);
    const activePath = join(output, 'private', 'active-model.json');
    if (existsSync(activePath)) fail('stale active-model marker exists; refuse to repeat a possibly spent batch');
    const scoringExists = existsSync(join(output, 'scoring'));
    if (!state.complete && scoringExists) fail('scoring artifacts exist before the experiment is complete');
    if (state.complete && scoringExists) validateScoringArtifacts(output);
    let processed = 0;
    const limit = allModels ? protocol.models.length : protocol.schedule.models_per_batch;
    while (!state.complete && !state.terminal && processed < limit) {
        const modelEntry = state.next;
        const attempt = results.filter((result) => result.model_id === modelEntry.id).length + 1;
        privateWrite(activePath, `${JSON.stringify({ model_id: modelEntry.id, attempt }, null, 2)}\n`);
        let persisted = false;
        try {
            const result = executeModelAttempt({
                protocol,
                protocolPath,
                source,
                dependencySource,
                dependencyStore,
                output,
                modelEntry,
                attempt,
                codexBin,
                codexHome,
                dryRun,
            });
            results = [...results, result];
            writeResults(output, results);
            persisted = true;
        } finally {
            if (persisted) rmSync(activePath, { force: true });
        }
        processed += 1;
        state = progress(protocol, output, results);
        if (!state.complete && results.at(-1)?.valid === false) break;
    }
    if (state.complete) {
        if (!existsSync(join(output, 'scoring'))) {
            writeScoringArtifacts({ protocol, protocolPath, output, accepted: state.accepted });
        }
        validateScoringArtifacts(output);
    }
    const summary = summarize(protocol, results);
    privateWrite(join(output, 'private', 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return { ...summary, terminal_invalid_model: state.terminal };
}

export function buildPlan(protocol) {
    return {
        study_id: protocol.study_id,
        models: protocol.models,
        reasoning_effort: protocol.execution.reasoning_effort,
        model_order: protocol.schedule.model_order,
        models_per_batch: protocol.schedule.models_per_batch,
        intake_only_per_model: true,
        implementation_arms_per_model: protocol.arms.map((arm) => arm.id),
        full_cycle_stages: protocol.execution.full_cycle.resumed_stages,
        minimum_model_turns_per_model: 9,
        maximum_model_turns_per_attempt: 30,
        retry_limits: protocol.schedule.retry_limits,
    };
}

function usage() {
    return `Usage:
  node eval/model-lift/run.mjs lock --source <release-relay-checkout>
  node eval/model-lift/run.mjs plan
  node eval/model-lift/run.mjs fetch-cache --source <release-relay-checkout> --allow-network
  node eval/model-lift/run.mjs dry-run --output <new-directory>
  node eval/model-lift/run.mjs dry-run-batch --output <new-or-resumable-directory>
  node eval/model-lift/run.mjs preflight --source <release-relay-checkout> --output <new-directory>
  node eval/model-lift/run.mjs run --source <release-relay-checkout> --output <new-directory>
       --confirm-protocol-sha256 <sha256> [--codex-home <path>]
  node eval/model-lift/run.mjs run-batch --source <release-relay-checkout>
       --output <new-or-resumable-directory> --confirm-protocol-sha256 <sha256>
       [--codex-home <path>]
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
        assertLocalArtifactLock(protocol, protocolPath);
        console.log(JSON.stringify({
            ...buildPlan(protocol),
            protocol_sha256: sha256(readFileSync(protocolPath)),
        }, null, 2));
        return 0;
    }
    if (command === 'fetch-cache') {
        if (!values.source) fail('fetch-cache requires --source');
        if (!values['allow-network']) fail('fetch-cache requires explicit --allow-network');
        const source = verifySource(values.source, protocol);
        assertArtifactLock(protocol, protocolPath, source);
        console.log(JSON.stringify(fetchDependencyCache({ protocol, source }), null, 2));
        return 0;
    }
    if (!['dry-run', 'dry-run-batch', 'preflight', 'run', 'run-batch'].includes(command)) {
        fail(`unknown command: ${command}`);
    }
    if (!values.output) fail(`${command} requires --output`);
    const batch = command.endsWith('-batch');
    const { output } = batch
        ? prepareBatchOutput(values.output)
        : { output: ensureNewOutput(values.output) };
    const codexBin = values['codex-bin']
        ? realpathSync(resolve(values['codex-bin']))
        : command.startsWith('dry-run') ? DEFAULT_FAKE_CODEX : 'codex';
    if (command.startsWith('dry-run')) {
        assertLocalArtifactLock(protocol, protocolPath);
        const execute = () => executeBatch({
            protocol,
            protocolPath,
            source: null,
            output,
            codexBin,
            codexHome: null,
            dryRun: true,
            allModels: command === 'dry-run',
        });
        const result = batch ? withBatchLock(output, execute) : execute();
        console.log(JSON.stringify(result, null, 2));
        return result.terminal_invalid_model ? 2 : 0;
    }
    if (!values.source) fail(`${command} requires --source`);
    const source = verifySource(values.source, protocol);
    assertArtifactLock(protocol, protocolPath, source);
    const dependencySnapshot = prepareDependencySnapshot({ protocol, source });
    try {
        const dependencySource = dependencySnapshot.workspace;
        const dependencyStore = dependencySnapshot.store;
        if (command === 'preflight') {
            preflight({
                protocol, protocolPath, source, dependencySource, dependencyStore, output, codexBin,
            });
            console.log(JSON.stringify({ preflight: 'pass', scored_model_calls: 0 }, null, 2));
            return 0;
        }
        const expected = sha256(readFileSync(protocolPath));
        if (values['confirm-protocol-sha256'] !== expected) {
            fail(`${command} requires --confirm-protocol-sha256 ${expected}`);
        }
        const preflightPath = join(output, 'preflight.json');
        if (!existsSync(preflightPath)) {
            preflight({
                protocol, protocolPath, source, dependencySource, dependencyStore, output, codexBin,
            });
        } else {
            const receipt = JSON.parse(readFileSync(preflightPath, 'utf8'));
            if (receipt.protocol_sha256 !== expected || receipt.scored_model_calls !== 0
                || receipt.artifact_lock !== 'pass') fail('existing preflight receipt is invalid');
        }
        const execute = () => executeBatch({
            protocol,
            protocolPath,
            source,
            dependencySource,
            dependencyStore,
            output,
            codexBin,
            codexHome: values['codex-home'],
            dryRun: false,
            allModels: command === 'run',
        });
        const result = batch ? withBatchLock(output, execute) : execute();
        console.log(JSON.stringify(result, null, 2));
        return result.terminal_invalid_model ? 2 : 0;
    } finally {
        dependencySnapshot.cleanup();
    }
}

function invokedDirectly() {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
    try {
        process.exitCode = main();
    } catch (error) {
        if (error instanceof ModelLiftError || error instanceof PipelineEvalError) {
            console.error(error.message);
            process.exitCode = 2;
        } else {
            throw error;
        }
    }
}
