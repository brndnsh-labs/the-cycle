#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCENARIOS = join(HERE, 'scenarios');
const SOURCE_PATHS = ['package.json', 'bin', 'templates', 'backends', 'harnesses', 'profiles'];
const FIXTURE_VERSION = 1;

class EvalError extends Error {}

function fail(message) {
    throw new EvalError(message);
}

function run(command, args, { cwd = ROOT, env = process.env, input, encoding = 'utf8', timeout } = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env,
        input,
        encoding,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const stderr = encoding === null ? result.stderr?.toString('utf8') : result.stderr;
        const stdout = encoding === null ? result.stdout?.toString('utf8') : result.stdout;
        fail(`${command} ${args.join(' ')} failed (${result.status})\n${stderr || stdout || ''}`.trimEnd());
    }
    return result.stdout;
}

function git(args, cwd, options) {
    return run('git', args, { cwd, ...options });
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function hashObject(value) {
    return sha256(JSON.stringify(stable(value)));
}

function walkFiles(root, current = root) {
    const files = [];
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) files.push(...walkFiles(root, path));
        else if (entry.isFile()) files.push(path);
    }
    return files;
}

function hashTree(root) {
    const hash = createHash('sha256');
    for (const path of walkFiles(root)) {
        hash.update(relative(root, path));
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function hashSourceTree(root) {
    const hash = createHash('sha256');
    for (const rel of SOURCE_PATHS) {
        const path = join(root, rel);
        if (!existsSync(path)) continue;
        const files = statSync(path).isDirectory() ? walkFiles(path) : [path];
        for (const file of files) {
            hash.update(relative(root, file));
            hash.update('\0');
            hash.update(readFileSync(file));
            hash.update('\0');
        }
    }
    return hash.digest('hex');
}

function ensureInside(root, path) {
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(`..${sep}`)) {
        fail(`unsafe materialized path: ${path}`);
    }
}

function sourceMetadata(path, spec, resolvedRef = null) {
    let commit = resolvedRef;
    let dirty = null;
    if (!commit) {
        const commitResult = spawnSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
        if (commitResult.status === 0) {
            commit = commitResult.stdout.trim();
            const status = spawnSync(
                'git',
                ['-C', path, 'status', '--porcelain', '--', ...SOURCE_PATHS],
                { encoding: 'utf8' },
            );
            dirty = status.status === 0 ? Boolean(status.stdout.trim()) : null;
        }
    }
    return { spec, path, commit, dirty, source_sha256: hashSourceTree(path) };
}

function materializeRef(spec, destination) {
    const resolvedRef = git(['rev-parse', '--verify', `${spec}^{commit}`], ROOT).trim();
    mkdirSync(destination, { recursive: true });
    const listing = git(
        ['ls-tree', '-r', '-z', '--name-only', resolvedRef, '--', ...SOURCE_PATHS],
        ROOT,
    );
    const files = listing.split('\0').filter(Boolean);
    if (!files.includes('bin/cycle.mjs')) fail(`git ref ${spec} does not contain bin/cycle.mjs`);
    for (const rel of files) {
        const path = resolve(destination, rel);
        ensureInside(destination, path);
        mkdirSync(dirname(path), { recursive: true });
        const content = git(['show', `${resolvedRef}:${rel}`], ROOT, { encoding: null });
        writeFileSync(path, content);
    }
    return sourceMetadata(destination, spec, resolvedRef);
}

function resolveSource(spec, sourceRoot, name) {
    const path = resolve(spec);
    if (existsSync(path)) {
        const real = realpathSync(path);
        if (!existsSync(join(real, 'bin', 'cycle.mjs'))) fail(`${spec} is not a the-cycle checkout`);
        return sourceMetadata(real, spec);
    }
    return materializeRef(spec, join(sourceRoot, name));
}

const isNonEmptyString = (value) => typeof value === 'string' && Boolean(value.trim());
const isStringArray = (value, { nonEmpty = false } = {}) =>
    Array.isArray(value)
    && (!nonEmpty || value.length > 0)
    && value.every(isNonEmptyString);

export function validateScenario(scenario) {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
        fail('evaluation scenario must be an object');
    }
    if (!isNonEmptyString(scenario.id) || !isNonEmptyString(scenario.prompt)
        || !scenario.issue || !Array.isArray(scenario.assertions)) {
        fail(`scenario ${scenario.id ?? '<unknown>'} is missing id, prompt, issue, or assertions`);
    }

    for (const [index, assertion] of scenario.assertions.entries()) {
        const where = `scenario ${scenario.id} assertion[${index}]`;
        if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
            fail(`${where} must be an object`);
        }
        const requirePath = () => {
            if (!isNonEmptyString(assertion.path)) fail(`${where} requires a non-empty string path`);
        };
        const requireContains = () => {
            if (!isNonEmptyString(assertion.contains)) fail(`${where} requires a non-empty string contains`);
        };

        switch (assertion.type) {
            case 'file_equals':
                requirePath();
                if (typeof assertion.value !== 'string') fail(`${where} requires a string value`);
                break;
            case 'file_unchanged':
            case 'path_unstaged':
                requirePath();
                break;
            case 'changed_paths':
                if (!isStringArray(assertion.value)) fail(`${where} requires a string-array value`);
                break;
            case 'command_succeeded':
            case 'command_failed':
            case 'command_absent':
                requireContains();
                break;
            case 'commands_succeeded_in_order':
                if (!isStringArray(assertion.value, { nonEmpty: true })) {
                    fail(`${where} requires a non-empty string-array value`);
                }
                break;
            case 'fixture_gate':
                break;
            default:
                fail(`${where} has unknown type ${JSON.stringify(assertion.type)}`);
        }
    }
    return scenario;
}

function loadScenarios(selected = []) {
    const wanted = new Set(selected);
    const scenarios = readdirSync(SCENARIOS)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => JSON.parse(readFileSync(join(SCENARIOS, name), 'utf8')))
        .filter((scenario) => !wanted.size || wanted.has(scenario.id));
    if (!scenarios.length) fail('no evaluation scenarios selected');
    const ids = new Set();
    for (const scenario of scenarios) {
        validateScenario(scenario);
        if (ids.has(scenario.id)) fail(`invalid or duplicate scenario id: ${scenario.id}`);
        ids.add(scenario.id);
    }
    if (wanted.size) {
        const missing = [...wanted].filter((id) => !ids.has(id));
        if (missing.length) fail(`unknown scenario(s): ${missing.join(', ')}`);
    }
    return scenarios;
}

function writeFixtureFiles(workspace, scenario) {
    const files = {
        'AGENTS.md': [
            '# Evaluation fixture',
            '',
            'Use the repository skill named by the task and read `.agents/skills/DOCTRINE.md`.',
            'All tracker operations must use the local `gh` command supplied by the evaluator.',
            'Do not access the network. The normal local gate is `npm test`.',
            '',
        ].join('\n'),
        'package.json': `${JSON.stringify({ name: 'cycle-eval-fixture', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
        'test/feature.test.mjs': [
            "import { test } from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { readFileSync } from 'node:fs';",
            '',
            "test('the bounded feature is implemented', () => {",
            "    assert.equal(readFileSync(new URL('../feature.txt', import.meta.url), 'utf8'), 'implemented\\n');",
            '});',
            '',
        ].join('\n'),
        ...scenario.initial_files,
    };
    for (const [rel, content] of Object.entries(files)) {
        const path = resolve(workspace, rel);
        ensureInside(workspace, path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
    return { tracked: Object.keys(files), filesHash: hashObject(files) };
}

function renderSkills(workspace, source) {
    const cli = join(source.path, 'bin', 'cycle.mjs');
    const sets = [
        ['harnesses', ['codex']],
        ['repo.name', 'cycle-eval-fixture'],
        ['repo.slug', 'local/cycle-eval-fixture'],
        ['repo.human', 'Evaluator'],
        ['gates.test', 'npm test'],
        ['branch.minor_edits_direct', false],
    ];
    const args = [cli, 'install', '--profile', 'lean', '--backend', 'github'];
    for (const [path, value] of sets) args.push('--set', `${path}=${JSON.stringify(value)}`);
    args.push('-y');
    run(process.execPath, args, { cwd: workspace, env: { ...process.env, NO_COLOR: '1' } });
    return hashTree(join(workspace, '.agents', 'skills'));
}

function setupFixture(runDir, scenario, source) {
    const workspace = join(runDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    git(['init', '-q', '-b', 'main'], workspace);
    git(['config', 'user.name', 'Cycle Evaluator'], workspace);
    git(['config', 'user.email', 'cycle-eval@example.invalid'], workspace);
    const { tracked, filesHash } = writeFixtureFiles(workspace, scenario);
    const skillHash = renderSkills(workspace, source);
    rmSync(join(workspace, '.cycle', 'state.json'), { force: true });

    const exclude = join(workspace, '.git', 'info', 'exclude');
    writeFileSync(exclude, `${readFileSync(exclude, 'utf8')}\n.cycle-eval/\n`);
    git(['add', '--', ...tracked, '.cycle', '.agents'], workspace);
    git(['commit', '-q', '-m', 'test: seed behavioral evaluation fixture'], workspace);

    const control = join(workspace, '.cycle-eval');
    const remote = join(control, 'remote.git');
    mkdirSync(control, { recursive: true });
    git(['init', '-q', '--bare', remote], workspace);
    git(['remote', 'add', 'origin', remote], workspace);
    git(['push', '-q', '-u', 'origin', 'main'], workspace);

    const fakeBin = join(HERE, 'bin');
    const fakeGh = join(fakeBin, 'gh');
    if (!existsSync(fakeGh)) fail(`missing evaluator tracker double: ${fakeGh}`);

    for (const [rel, content] of Object.entries(scenario.dirty_files ?? {})) {
        const path = resolve(workspace, rel);
        ensureInside(workspace, path);
        writeFileSync(path, content);
    }

    const observed = new Map();
    for (const assertion of scenario.assertions) {
        if (assertion.type !== 'file_unchanged' || observed.has(assertion.path)) continue;
        const path = resolve(workspace, assertion.path);
        observed.set(assertion.path, existsSync(path) ? sha256(readFileSync(path)) : null);
    }
    const controlTest = join(workspace, 'test', 'feature.test.mjs');
    return {
        runDir,
        workspace,
        fakeBin,
        skillHash,
        fixtureHash: hashObject({
            version: FIXTURE_VERSION,
            scenario,
            filesHash,
            fake_gh_sha256: hashTree(fakeBin),
        }),
        observed,
        controlTest,
        controlTestHash: sha256(readFileSync(controlTest)),
    };
}

function changedPaths(workspace) {
    const output = git(['status', '--porcelain=v1', '-z'], workspace);
    const entries = output.split('\0').filter(Boolean);
    const paths = [];
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        paths.push(entry.slice(3));
        if (entry[0] === 'R' || entry[1] === 'R' || entry[0] === 'C' || entry[1] === 'C') index++;
    }
    return paths.sort();
}

function completedCommands(events) {
    return events
        .filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution')
        .map((event) => event.item);
}

function evaluateAssertions(scenario, fixture, events) {
    const assertions = [];
    const commands = completedCommands(events);
    for (const assertion of scenario.assertions) {
        let actual;
        let expected;
        if (assertion.type === 'file_equals') {
            const path = resolve(fixture.workspace, assertion.path);
            actual = existsSync(path) ? readFileSync(path, 'utf8') : null;
            expected = assertion.value;
        } else if (assertion.type === 'file_unchanged') {
            const path = resolve(fixture.workspace, assertion.path);
            actual = existsSync(path) ? sha256(readFileSync(path)) : null;
            expected = fixture.observed.get(assertion.path);
        } else if (assertion.type === 'changed_paths') {
            actual = changedPaths(fixture.workspace);
            expected = [...assertion.value].sort();
        } else if (assertion.type === 'path_unstaged') {
            actual = git(['diff', '--cached', '--name-only', '--', assertion.path], fixture.workspace).trim();
            expected = '';
        } else if (assertion.type === 'command_succeeded') {
            actual = commands.some((command) =>
                command.command.includes(assertion.contains)
                && command.status === 'completed'
                && command.exit_code === 0);
            expected = true;
        } else if (assertion.type === 'command_failed') {
            actual = commands.some((command) =>
                command.command.includes(assertion.contains)
                && (command.status === 'failed' || (command.exit_code !== null && command.exit_code !== 0)));
            expected = true;
        } else if (assertion.type === 'command_absent') {
            actual = commands.some((command) => command.command.includes(assertion.contains));
            expected = false;
        } else if (assertion.type === 'commands_succeeded_in_order') {
            let next = 0;
            for (const command of commands) {
                if (next >= assertion.value.length || !command.command.includes(assertion.value[next])) continue;
                if (command.status !== 'completed' || command.exit_code !== 0) break;
                next++;
            }
            actual = next;
            expected = assertion.value.length;
        } else if (assertion.type === 'fixture_gate') {
            const unchanged = existsSync(fixture.controlTest)
                && sha256(readFileSync(fixture.controlTest)) === fixture.controlTestHash;
            let gate;
            if (unchanged) {
                const gateHome = join(fixture.runDir, 'gate-home');
                mkdirSync(gateHome, { recursive: true });
                gate = spawnSync(process.execPath, ['--test', 'test/feature.test.mjs'], {
                    cwd: fixture.workspace,
                    encoding: 'utf8',
                    env: {
                        PATH: process.env.PATH ?? '',
                        HOME: gateHome,
                        TMPDIR: process.env.TMPDIR ?? tmpdir(),
                        LANG: process.env.LANG ?? 'C',
                    },
                });
            }
            const gateLog = unchanged
                ? `${gate.stdout ?? ''}${gate.stderr ?? ''}${gate.error ? `${gate.error.message}\n` : ''}`
                : 'fixture test changed; independent gate not executed\n';
            writeFileSync(join(fixture.runDir, 'independent-gate.log'), gateLog);
            actual = { test_unchanged: unchanged, exit_code: unchanged && !gate.error ? gate.status : null };
            expected = { test_unchanged: true, exit_code: 0 };
        } else {
            fail(`scenario ${scenario.id} has unknown assertion type ${assertion.type}`);
        }
        assertions.push({
            type: assertion.type,
            path: assertion.path ?? null,
            contains: assertion.contains ?? null,
            sequence: assertion.type === 'commands_succeeded_in_order' ? assertion.value : null,
            pass: JSON.stringify(actual) === JSON.stringify(expected),
            expected,
            actual,
        });
    }
    return assertions;
}

export function parseExecEvents(text) {
    const events = [];
    const malformed = [];
    const invalidEvents = [];
    for (const [index, line] of text.split('\n').entries()) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line);
            if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
                invalidEvents.push(index + 1);
                continue;
            }
            events.push(event);
        }
        catch { malformed.push(index + 1); }
    }
    const completed = events.filter((event) => event.type === 'turn.completed').at(-1);
    const failed = events.find((event) => event.type === 'turn.failed' || event.type === 'error');
    const validationErrors = [
        malformed.length ? `malformed JSONL at line(s) ${malformed.join(', ')}` : null,
        invalidEvents.length ? `invalid JSONL event at line(s) ${invalidEvents.join(', ')}` : null,
    ].filter(Boolean);
    return {
        events,
        usage: completed?.usage ?? null,
        invalid: validationErrors.length
            ? validationErrors.join('; ')
            : failed
                ? `Codex emitted ${failed.type}`
                : completed
                    ? null
                    : 'Codex emitted no turn.completed event',
    };
}

function codexVersion(codexBin) {
    const result = spawnSync(codexBin, ['--version'], { encoding: 'utf8' });
    if (result.error) fail(`cannot run ${codexBin} --version: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = result.stderr?.trim() || result.stdout?.trim();
        fail(`cannot run ${codexBin} --version${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout.trim();
}

function codexEnvironment(fixture, scenario) {
    const env = {};
    for (const name of [
        'PATH',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'TERM',
        'SHELL',
        'USER',
        'LOGNAME',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'NODE_EXTRA_CA_CERTS',
    ]) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const control = join(fixture.workspace, '.cycle-eval');
    env.HOME = join(control, 'home');
    env.TMPDIR = join(control, 'tmp');
    env.CODEX_HOME = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
    env.CYCLE_EVAL_SCENARIO_ID = scenario.id;
    env.NO_COLOR = '1';
    if (process.env.FAKE_CODEX_SKIP_BEHAVIOR !== undefined) {
        env.FAKE_CODEX_SKIP_BEHAVIOR = process.env.FAKE_CODEX_SKIP_BEHAVIOR;
    }
    if (process.env.FAKE_CODEX_REVERSE_STATUS !== undefined) {
        env.FAKE_CODEX_REVERSE_STATUS = process.env.FAKE_CODEX_REVERSE_STATUS;
    }
    // Why: authentication stays in CODEX_HOME; ambient credentials do not enter the agent process.
    return env;
}

function runOne({ arm, repetition, scenario, source, codexBin, codexVersionValue, model, effort, timeoutMs, output }) {
    const name = `${scenario.id}-${String(repetition).padStart(2, '0')}-${arm}`;
    const runDir = join(output, 'runs', name);
    mkdirSync(runDir, { recursive: true });
    const fixture = setupFixture(runDir, scenario, source);
    const eventsPath = join(runDir, 'events.jsonl');
    const stderrPath = join(runDir, 'stderr.log');
    const diffPath = join(runDir, 'final.diff');
    const statusPath = join(runDir, 'final-status.txt');
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const env = codexEnvironment(fixture, scenario);
    env.PATH = `${fixture.fakeBin}:${env.PATH ?? ''}`;
    mkdirSync(env.HOME, { recursive: true });
    mkdirSync(env.TMPDIR, { recursive: true });
    const args = [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--sandbox', 'workspace-write',
        '--model', model,
        '--config', `model_reasoning_effort=${JSON.stringify(effort)}`,
        '--config', 'approval_policy="never"',
        '--config', 'sandbox_workspace_write.network_access=false',
        '--config', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
        '--config', 'sandbox_workspace_write.exclude_slash_tmp=true',
        '--config', 'shell_environment_policy.inherit="core"',
        '--cd', fixture.workspace,
        scenario.prompt,
    ];
    const processResult = spawnSync(codexBin, args, {
        cwd: fixture.workspace,
        env,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - started;
    const stdout = processResult.stdout ?? '';
    const stderr = processResult.stderr ?? '';
    writeFileSync(eventsPath, stdout);
    writeFileSync(stderrPath, stderr);
    writeFileSync(diffPath, git(['diff', '--binary', 'HEAD'], fixture.workspace));
    writeFileSync(statusPath, git(['status', '--short', '--branch'], fixture.workspace));
    const parsed = parseExecEvents(stdout);
    let invalidReason = null;
    if (processResult.error) invalidReason = processResult.error.code === 'ETIMEDOUT'
        ? `Codex timed out after ${timeoutMs}ms`
        : processResult.error.message;
    else if (processResult.signal) invalidReason = `Codex terminated by ${processResult.signal}`;
    else if (processResult.status !== 0) invalidReason = `Codex exited ${processResult.status}`;
    else invalidReason = parsed.invalid;
    const assertions = evaluateAssertions(scenario, fixture, parsed.events);
    const independentGatePath = join(runDir, 'independent-gate.log');
    const result = {
        schema_version: 1,
        scenario: scenario.id,
        arm,
        repetition,
        snapshot: {
            spec: source.spec,
            commit: source.commit,
            dirty: source.dirty,
            source_sha256: source.source_sha256,
            rendered_skill_sha256: fixture.skillHash,
        },
        fixture_sha256: fixture.fixtureHash,
        requested_model: model,
        requested_effort: effort,
        codex_version: codexVersionValue,
        started_at: startedAt,
        elapsed_ms: elapsedMs,
        usage: parsed.usage,
        harness_exit_code: processResult.status,
        invalid_reason: invalidReason,
        passed: invalidReason ? null : assertions.every((assertion) => assertion.pass),
        assertions,
        artifacts: {
            events: relative(output, eventsPath),
            stderr: relative(output, stderrPath),
            diff: relative(output, diffPath),
            status: relative(output, statusPath),
            independent_gate: existsSync(independentGatePath)
                ? relative(output, independentGatePath)
                : null,
            workspace: relative(output, fixture.workspace),
        },
    };
    writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
}

function printSummary(results) {
    console.log('\nscenario                 run  baseline   candidate');
    const grouped = new Map();
    for (const result of results) {
        const key = `${result.scenario}\0${result.repetition}`;
        const row = grouped.get(key) ?? { scenario: result.scenario, repetition: result.repetition };
        row[result.arm] = result.invalid_reason ? 'INVALID' : result.passed ? 'PASS' : 'FAIL';
        grouped.set(key, row);
    }
    for (const row of grouped.values()) {
        console.log(
            `${row.scenario.padEnd(24)} ${String(row.repetition).padStart(3)}  ${(row.baseline ?? '-').padEnd(10)} ${row.candidate ?? '-'}`,
        );
    }
}

function usage() {
    return `Usage:
  node eval/run.mjs --baseline <ref-or-path> --candidate <ref-or-path> \\
    --model <model> --output <new-directory> [--repeat <n>] [--scenario <id>]

Options:
  --effort <level>       Reasoning effort, default: medium
  --timeout-ms <ms>      Per-agent-run timeout, default: 900000
  --codex-bin <path>     Codex executable, default: codex
  --scenario <id>        Run only one scenario; repeatable

Behavioral failures are recorded in results.jsonl and do not make this a merge gate.
Invalid runner or Codex execution exits 2.
`;
}

export function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({
        args: argv,
        options: {
            baseline: { type: 'string' },
            candidate: { type: 'string' },
            model: { type: 'string' },
            output: { type: 'string' },
            repeat: { type: 'string', default: '1' },
            effort: { type: 'string', default: 'medium' },
            'timeout-ms': { type: 'string', default: '900000' },
            'codex-bin': { type: 'string', default: 'codex' },
            scenario: { type: 'string', multiple: true },
            help: { type: 'boolean', short: 'h' },
        },
        strict: true,
    });
    if (values.help) {
        console.log(usage());
        return [];
    }
    for (const name of ['baseline', 'candidate', 'model', 'output']) {
        if (!values[name]) fail(`missing --${name}\n\n${usage()}`);
    }
    const repeat = Number(values.repeat);
    const timeoutMs = Number(values['timeout-ms']);
    if (!Number.isSafeInteger(repeat) || repeat < 1) fail('--repeat must be a positive integer');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('--timeout-ms must be a positive integer');
    const output = resolve(values.output);
    if (existsSync(output) && (!statSync(output).isDirectory() || readdirSync(output).length)) {
        fail(`output path must be a new or empty directory: ${output}`);
    }
    mkdirSync(output, { recursive: true });
    const sourceRoot = mkdtempSync(join(tmpdir(), 'cycle-eval-sources-'));
    try {
        const sources = {
            baseline: resolveSource(values.baseline, sourceRoot, 'baseline'),
            candidate: resolveSource(values.candidate, sourceRoot, 'candidate'),
        };
        const scenarios = loadScenarios(values.scenario ?? []);
        const version = codexVersion(values['codex-bin']);
        const publicSource = ({ spec, commit, dirty, source_sha256 }) => ({
            spec,
            commit,
            dirty,
            source_sha256,
        });
        const experiment = {
            schema_version: 1,
            created_at: new Date().toISOString(),
            baseline: publicSource(sources.baseline),
            candidate: publicSource(sources.candidate),
            model: values.model,
            effort: values.effort,
            repeat,
            scenarios: scenarios.map((scenario) => scenario.id),
            codex_version: version,
        };
        writeFileSync(join(output, 'experiment.json'), `${JSON.stringify(experiment, null, 2)}\n`);

        const results = [];
        for (const [scenarioIndex, scenario] of scenarios.entries()) {
            for (let repetition = 1; repetition <= repeat; repetition++) {
                const arms = (scenarioIndex + repetition) % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
                for (const arm of arms) {
                    console.log(`running ${scenario.id} ${arm} (${repetition}/${repeat})`);
                    results.push(runOne({
                        arm,
                        repetition,
                        scenario,
                        source: sources[arm],
                        codexBin: values['codex-bin'],
                        codexVersionValue: version,
                        model: values.model,
                        effort: values.effort,
                        timeoutMs,
                        output,
                    }));
                }
            }
        }
        writeFileSync(join(output, 'results.jsonl'), results.map((result) => JSON.stringify(result)).join('\n') + '\n');
        printSummary(results);
        console.log(`\nresults: ${join(output, 'results.jsonl')}`);
        if (results.some((result) => result.invalid_reason)) process.exitCode = 2;
        return results;
    } finally {
        rmSync(sourceRoot, { recursive: true, force: true });
    }
}

function invokedDirectly() {
    if (!process.argv[1]) return false;
    try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
    catch { return false; }
}

if (invokedDirectly()) {
    try { main(); }
    catch (error) {
        if (error instanceof EvalError || error?.code?.startsWith?.('ERR_PARSE_ARGS')) {
            console.error(`error: ${error.message}`);
            process.exit(2);
        }
        throw error;
    }
}
