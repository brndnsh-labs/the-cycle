// End-to-end render tests: every profile, on every backend, into a throwaway repo.
//
// The engine tests cover the template language; these cover the thing that actually
// ships — that all 19 templates resolve, produce valid skill frontmatter, and render
// identically twice. A non-idempotent render would churn every consuming repo on
// every update, so that assertion earns its place.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'cycle.mjs');
const PROFILES = readdirSync(join(HERE, '..', 'profiles'))
    .filter((f) => f.endsWith('.jsonc') && !f.startsWith('_'))
    .map((f) => f.replace('.jsonc', ''));
const BACKENDS = ['github'];

const REMOTES = {
    github: 'https://github.com/brandon/demo.git',
};

function scratchRepo(backend) {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-render-'));
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: 'pipe' });
    run('git', ['init', '-q', '.']);
    run('git', ['remote', 'add', 'origin', REMOTES[backend]]);
    run('git', ['config', 'user.name', 'Brandon Shea']);
    run('git', ['config', 'user.email', 'b@example.com']);
    writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'demo', scripts: { typecheck: 'tsc -b', test: 'node --test' } }),
    );
    return dir;
}

const cycle = (dir, args) =>
    execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

/** Like cycle(), but for the commands that exit non-zero on purpose (check, update). */
const cycleRaw = (dir, args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

for (const backend of BACKENDS) {
    for (const profile of PROFILES) {
        describe(`${profile} on ${backend}`, () => {
            let dir;
            let skills;

            before(() => {
                dir = scratchRepo(backend);
                dirs.push(dir);
                cycle(dir, ['install', '--profile', profile, '--backend', backend, '--set', 'tracker.project=4', '-y']);
                skills = readdirSync(join(dir, '.claude', 'skills'), { withFileTypes: true })
                    .filter((e) => e.isDirectory())
                    .map((e) => e.name);
            });

            test('renders every skill in the profile', () => {
                const expected = JSON.parse(
                    readFileSync(join(HERE, '..', 'profiles', `${profile}.jsonc`), 'utf8')
                        .replace(/\/\/.*$/gm, '')
                        .replace(/,(\s*[}\]])/g, '$1'),
                ).skills;
                assert.deepEqual(skills.sort(), [...expected].sort());
                assert.ok(existsSync(join(dir, '.claude', 'skills', 'DOCTRINE.md')));
            });

            test('every skill has parseable frontmatter and a provenance stamp', () => {
                for (const s of skills) {
                    const text = readFileSync(join(dir, '.claude', 'skills', s, 'SKILL.md'), 'utf8');
                    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
                    assert.ok(fm, `${s}: no frontmatter`);
                    assert.match(fm[1], /^name: /m, `${s}: no name`);
                    assert.match(fm[1], /^description: /m, `${s}: no description`);
                    assert.equal(new RegExp(`^name: ${s}$`, 'm').test(fm[1]), true, `${s}: name mismatch`);
                    assert.match(text, /<!-- cycle:rendered /, `${s}: no provenance`);
                }
            });

            // A leftover {{…}} means a template referenced something config doesn't have
            // and the engine let it through — the exact failure the loud-unresolved rule
            // exists to prevent.
            test('no unrendered template syntax survives', () => {
                for (const s of [...skills.map((x) => join('.claude/skills', x, 'SKILL.md')), '.claude/skills/DOCTRINE.md']) {
                    const text = readFileSync(join(dir, s), 'utf8');
                    const leftover = (text.match(/\{\{[^}]*\}\}/g) ?? []).filter(
                        (m, i, all) => !text.includes(`$${all[i]}`),
                    );
                    assert.deepEqual(leftover, [], `${s}: unrendered ${leftover.join(', ')}`);
                }
            });

            // A rendered skill whose commands point at a script the repo doesn't have
            // reads perfectly and fails on every invocation — the failure mode that
            // shipped when `shims` was declared in the backend and consumed nowhere.
            test('every shim the backend declares is rendered, executable, and reaches its helper', () => {
                const backendFile = JSON.parse(
                    readFileSync(join(HERE, '..', 'backends', `${backend}.jsonc`), 'utf8')
                        .replace(/^\s*\/\/.*$/gm, '')
                        .replace(/,(\s*[}\]])/g, '$1'),
                );
                assert.ok(backendFile.shims?.length, `${backend}: declares no shims`);

                for (const shim of backendFile.shims) {
                    const p = join(dir, shim.path);
                    assert.ok(existsSync(p), `${shim.path}: not rendered`);
                    assert.match(readFileSync(p, 'utf8'), /^#!/, `${shim.path}: lost its shebang`);
                    assert.match(readFileSync(p, 'utf8'), /^\/\/ cycle:rendered /m, `${shim.path}: no provenance`);
                    assert.ok(statSync(p).mode & 0o111, `${shim.path}: not executable`);

                    // Run it. The helpers all print usage and exit non-zero with no
                    // args; what matters is that the shim *found* one — a resolution
                    // failure has its own distinct message.
                    const r = spawnSync(process.execPath, [p], { cwd: dir, encoding: 'utf8' });
                    assert.doesNotMatch(
                        `${r.stdout}${r.stderr}`,
                        /cannot find the-cycle/,
                        `${shim.path}: could not resolve its helper`,
                    );
                }
            });

            test('check reports clean immediately after install', () => {
                assert.match(cycle(dir, ['check']), /clean/);
            });

            test('re-rendering is a byte-identical no-op', () => {
                const before = skills.map((s) => readFileSync(join(dir, '.claude/skills', s, 'SKILL.md'), 'utf8'));
                cycle(dir, ['update']);
                const after = skills.map((s) => readFileSync(join(dir, '.claude/skills', s, 'SKILL.md'), 'utf8'));
                assert.deepEqual(after, before);
            });
        });
    }
}

// `install --plan` is the seam between the deterministic renderer and a guided setup
// that has judgment. Its contract: emit everything needed to fill in a config, write
// nothing, and stay in step with the templates.
describe('install --plan', () => {
    const planOf = (dir) => JSON.parse(cycle(dir, ['install', '--plan']));

    test('describes the repo without writing to it', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const plan = planOf(dir);

        assert.equal(plan.detected.backend, 'github');
        assert.equal(plan.detected.slug, 'brandon/demo');
        // The gate is how you *invoke* the script, not what the script runs.
        assert.deepEqual(plan.detected.gates, { typecheck: 'npm run typecheck', test: 'npm test' });
        assert.equal(plan.existing_config, null);
        assert.equal(existsSync(join(dir, '.cycle')), false, '--plan must not write');
        assert.equal(existsSync(join(dir, '.claude')), false, '--plan must not write');
    });

    test('every question carries a reason, not just a default', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const { questions } = planOf(dir);
        assert.ok(questions.length >= 6);
        for (const q of questions) {
            assert.ok(q.path, 'question with no config path');
            assert.ok(q.asks, `${q.path}: no question text`);
            // The "why" is the load-bearing part: it's what stops a model from
            // accepting the placeholder default and calling the setup done.
            assert.ok(q.why && q.why.length > 40, `${q.path}: no substantive rationale`);
        }
        assert.ok(questions.some((q) => q.path === 'brakes'));
        // github is the only backend the-cycle binds today, so there is nothing to ask —
        // matching the interactive interview, which drops this question for the same
        // reason (see cmdInstall in bin/cycle.mjs). A one-option question would raise an
        // AskUserQuestion with no real choice behind it.
        assert.ok(!questions.some((q) => q.path === 'backend'), '--plan must not ask a one-option backend question');
    });

    test('surfaces what the chosen backend additionally requires', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const { questions } = planOf(dir);
        assert.ok(questions.some((q) => q.path === 'tracker.project'), 'github must ask for its board');
        assert.ok(questions.some((q) => q.path === 'tracker.owner'));
    });

    test('lists every overlay point with the guidance needed to draft it', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const { overlays } = planOf(dir);

        const manifest = JSON.parse(
            readFileSync(join(HERE, '..', 'templates', 'overlays.jsonc'), 'utf8')
                .replace(/^\s*\/\/.*$/gm, '')
                .replace(/,(\s*[}\]])/g, '$1'),
        );
        assert.deepEqual(overlays.map((o) => o.name).sort(), Object.keys(manifest).sort());
        for (const o of overlays) {
            assert.ok(o.purpose && o.shape && o.into, `${o.name}: incomplete guidance`);
            assert.equal(o.exists, false);
            assert.match(o.path, /^\.cycle\/overlays\//);
        }
    });

    test('the draft it emits is a config that actually renders', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const { draft, write } = planOf(dir);

        mkdirSync(join(dir, '.cycle'), { recursive: true });
        draft.tracker.project = 4;
        writeFileSync(join(dir, '.cycle', 'config.jsonc'), JSON.stringify(draft, null, 2));
        assert.equal(write.then, 'cycle update');
        cycle(dir, ['update']);
        assert.match(cycle(dir, ['check']), /clean/);
    });

    test('reports an existing install rather than pretending to be a first run', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '--set', 'tracker.project=4', '-y']);
        assert.equal(planOf(dir).existing_config, '.cycle/config.jsonc');
    });

    test('--set rejects malformed and unknown config paths', () => {
        for (const assignment of ['tracker.project', 'tracker.nope=4', 'tracker.project=null']) {
            const dir = scratchRepo('github');
            dirs.push(dir);
            const result = cycleRaw(dir, ['install', '--profile', 'lean', '--set', assignment, '-y']);
            assert.equal(result.status, 1);
            assert.match(result.out, /invalid --set|unknown config path|backend needs 1 value/);
        }
    });
});

// The whole point of the resolution chain is that a repo cloned onto a machine where
// the-cycle lives somewhere else still works. Baked-path-only would pass every other
// test here and fail on the second machine.
describe('shim resolution', () => {
    test('CYCLE_HOME overrides the path baked in at render time', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '--set', 'tracker.project=4', '-y']);

        const elsewhere = mkdtempSync(join(tmpdir(), 'cycle-elsewhere-'));
        dirs.push(elsewhere);
        mkdirSync(join(elsewhere, 'helpers'));
        writeFileSync(
            join(elsewhere, 'helpers', 'gh-project.mjs'),
            'console.log("SENTINEL", process.env.GH_REPO, process.env.GH_OWNER, process.env.GH_PROJECT);\n',
        );

        const r = spawnSync(process.execPath, [join(dir, 'scripts', 'gh-project.mjs')], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, CYCLE_HOME: elsewhere },
        });
        assert.match(r.stdout, /SENTINEL/, 'CYCLE_HOME was not preferred');
        // …and the repo's bindings ride along, which is what frees the helper from
        // hardcoding a repo slug, owner, or board number.
        assert.match(r.stdout, /brandon\/demo/, 'shim did not pass its baked repo through');
        assert.match(r.stdout, /\b4\b/, 'shim did not pass its baked board number through');
    });

    test('an exported value beats the baked-in binding', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '--set', 'tracker.project=4', '-y']);

        const elsewhere = mkdtempSync(join(tmpdir(), 'cycle-elsewhere-'));
        dirs.push(elsewhere);
        mkdirSync(join(elsewhere, 'helpers'));
        writeFileSync(join(elsewhere, 'helpers', 'gh-project.mjs'), 'console.log(process.env.GH_REPO);\n');

        const r = spawnSync(process.execPath, [join(dir, 'scripts', 'gh-project.mjs')], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, CYCLE_HOME: elsewhere, GH_REPO: 'someone/else' },
        });
        assert.match(r.stdout, /someone\/else/);
    });
});

// Multi-harness: one config renders more than one skill tree. The engine-level
// concern is that the second tree is genuinely independent — its own root, its own
// {{harness.*}} substitutions — not a copy that happens to share output with Claude
// Code's.
describe('multi-harness render', () => {
    let dir;
    before(() => {
        dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'standard', '--set', 'tracker.project=4', '-y']);
        const p = join(dir, '.cycle', 'config.jsonc');
        writeFileSync(p, readFileSync(p, 'utf8').replace(
            '"harnesses": [\n    "claude"\n  ],',
            '"harnesses": ["claude", "codex"],',
        ));
        cycle(dir, ['update']);
    });

    test('renders a second tree at the codex harness root, alongside the untouched claude one', () => {
        assert.ok(existsSync(join(dir, '.claude', 'skills', 'DOCTRINE.md')));
        assert.ok(existsSync(join(dir, '.agents', 'skills', 'DOCTRINE.md')));
        assert.ok(existsSync(join(dir, '.agents', 'skills', 'cycle', 'SKILL.md')));
    });

    test('every codex-tree skill has parseable frontmatter and a provenance stamp', () => {
        for (const s of readdirSync(join(dir, '.agents', 'skills'), { withFileTypes: true })
            .filter((e) => e.isDirectory()).map((e) => e.name)) {
            const text = readFileSync(join(dir, '.agents', 'skills', s, 'SKILL.md'), 'utf8');
            const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
            assert.ok(fm, `${s}: no frontmatter`);
            assert.equal(new RegExp(`^name: ${s}$`, 'm').test(fm[1]), true, `${s}: name mismatch`);
            assert.match(text, /<!-- cycle:rendered /, `${s}: no provenance`);
        }
    });

    test('no unrendered template syntax survives in the codex tree', () => {
        for (const s of ['DOCTRINE.md', 'cycle/SKILL.md', 'intake/SKILL.md', 'unblock/SKILL.md', 'done/SKILL.md']) {
            const text = readFileSync(join(dir, '.agents', 'skills', s), 'utf8');
            const leftover = (text.match(/\{\{[^}]*\}\}/g) ?? []).filter(
                (m, i, all) => !text.includes(`$${all[i]}`),
            );
            assert.deepEqual(leftover, [], `${s}: unrendered ${leftover.join(', ')}`);
        }
    });

    test('each tree self-references its own doctrine path and attribution, not the other harness\'s', () => {
        const claudeDoctrine = readFileSync(join(dir, '.claude', 'skills', 'DOCTRINE.md'), 'utf8');
        const codexDoctrine = readFileSync(join(dir, '.agents', 'skills', 'DOCTRINE.md'), 'utf8');
        assert.match(claudeDoctrine, /Generated with \[Claude Code\]/);
        assert.match(codexDoctrine, /Generated with \[Codex CLI\]/);

        const claudeCycle = readFileSync(join(dir, '.claude', 'skills', 'cycle', 'SKILL.md'), 'utf8');
        const codexCycle = readFileSync(join(dir, '.agents', 'skills', 'cycle', 'SKILL.md'), 'utf8');
        assert.match(claudeCycle, /Shared rules in `\.claude\/skills\/DOCTRINE\.md`/);
        assert.match(codexCycle, /Shared rules in `\.agents\/skills\/DOCTRINE\.md`/);
    });

    test('the structured-menu tool name differs per harness, both wrapped correctly', () => {
        const claudeIntake = readFileSync(join(dir, '.claude', 'skills', 'intake', 'SKILL.md'), 'utf8');
        const codexIntake = readFileSync(join(dir, '.agents', 'skills', 'intake', 'SKILL.md'), 'utf8');
        assert.match(claudeIntake, /`AskUserQuestion`/);
        assert.doesNotMatch(claudeIntake, /ask_user_question/);
        assert.match(codexIntake, /`ask_user_question`/);
        assert.doesNotMatch(codexIntake, /AskUserQuestion/);
    });

    test('check reports clean across both trees, and re-render is a byte-identical no-op', () => {
        assert.match(cycle(dir, ['check']), /clean/);
        const before = readFileSync(join(dir, '.agents', 'skills', 'cycle', 'SKILL.md'), 'utf8');
        cycle(dir, ['update']);
        assert.equal(readFileSync(join(dir, '.agents', 'skills', 'cycle', 'SKILL.md'), 'utf8'), before);
    });

    test('eject removes provenance from every configured harness tree, not just one', () => {
        const out = cycle(dir, ['eject', 'wrap-up']);
        assert.match(out, /\.claude\/skills\/wrap-up\/SKILL\.md/);
        assert.match(out, /\.agents\/skills\/wrap-up\/SKILL\.md/);
        assert.doesNotMatch(readFileSync(join(dir, '.claude', 'skills', 'wrap-up', 'SKILL.md'), 'utf8'), /cycle:rendered/);
        assert.doesNotMatch(readFileSync(join(dir, '.agents', 'skills', 'wrap-up', 'SKILL.md'), 'utf8'), /cycle:rendered/);
    });
});

describe('drift detection', () => {
    let dir;
    before(() => {
        dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '--set', 'tracker.project=4', '-y']);
    });

    test('a hand edit is reported and update refuses to clobber it', () => {
        const f = join(dir, '.claude', 'skills', 'patch', 'SKILL.md');
        writeFileSync(f, `${readFileSync(f, 'utf8')}\nhand-written\n`);

        const checked = cycleRaw(dir, ['check']);
        assert.match(checked.out, /locally drifted/);
        assert.equal(checked.status, 1, 'check must exit non-zero on drift, for hooks and CI');

        const updated = cycleRaw(dir, ['update']);
        assert.match(updated.out, /refusing to overwrite/);
        assert.match(readFileSync(f, 'utf8'), /hand-written/, 'the hand edit must survive');
    });

    test('--force applies the template over a hand edit', () => {
        cycle(dir, ['update', '--force']);
        assert.doesNotMatch(readFileSync(join(dir, '.claude/skills/patch/SKILL.md'), 'utf8'), /hand-written/);
        assert.match(cycle(dir, ['check']), /clean/);
    });
});

describe('version stamp — no .git in CYCLE_HOME (an npm/npx install)', () => {
    let gitlessHome;
    let expectedVersion;

    before(() => {
        gitlessHome = mkdtempSync(join(tmpdir(), 'cycle-gitless-'));
        dirs.push(gitlessHome);
        for (const part of ['bin', 'templates', 'backends', 'harnesses', 'profiles', 'helpers', 'skills', 'docs', 'package.json']) {
            cpSync(join(HERE, '..', part), join(gitlessHome, part), { recursive: true });
        }
        expectedVersion = `v${JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version}`;
    });

    const gitlessCli = (cwd, args) =>
        execFileSync(process.execPath, [join(gitlessHome, 'bin', 'cycle.mjs'), ...args], {
            cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
        });

    test('--version falls back to the package version instead of "unknown"', () => {
        assert.equal(gitlessCli(gitlessHome, ['--version']).trim(), expectedVersion);
    });

    test('a render from a gitless copy stamps state.json with the package version', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        gitlessCli(dir, ['install', '--profile', 'lean', '--set', 'tracker.project=4', '-y']);
        const state = JSON.parse(readFileSync(join(dir, '.cycle', 'state.json'), 'utf8'));
        assert.equal(state.upstream, expectedVersion);
    });

    test('a shim rendered from a gitless copy never bakes in the ephemeral package dir', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        gitlessCli(dir, ['install', '--profile', 'lean', '--set', 'tracker.project=4', '-y']);
        const shim = readFileSync(join(dir, 'scripts', 'gh-project.mjs'), 'utf8');
        assert.ok(!shim.includes(gitlessHome), 'the baked path must not point into the npx-style cache dir');
        assert.match(shim, /['"].*[/\\]code[/\\]the-cycle['"]/, 'expected the conventional clone location baked in instead');
    });

    test('gitless `cycle install` points at the durable clone for cycle update/check and the setup skills', async () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        // Exercise the interactive path separately: accept every detected default except
        // the board number, which github has none to detect — type one, the way a real
        // user would.
        const child = spawn(process.execPath, [join(gitlessHome, 'bin', 'cycle.mjs'), 'install', '--profile', 'lean'], {
            cwd: dir,
            env: { ...process.env, NO_COLOR: '1' },
        });
        let out = '';
        const waiters = [];
        const pump = (d) => {
            out += d;
            // Re-check every pending waiter against the buffer we have so far.
            for (const w of waiters.slice()) {
                if (w.re.test(out)) {
                    waiters.splice(waiters.indexOf(w), 1);
                    w.resolve();
                }
            }
        };
        child.stdout.on('data', pump);
        child.stderr.on('data', pump);
        const awaitPrompt = (re) =>
            re.test(out) ? Promise.resolve() : new Promise((resolve, reject) => waiters.push({ re, resolve, reject }));

        // If the child exits — crash, or finishing before every scripted prompt was
        // seen — nothing will ever satisfy a still-pending waiter, and the `await`
        // below hangs forever. node --test has no default per-test timeout, so on CI
        // that is a wedged job, not a red test. Fail loudly instead.
        child.on('close', (code) => {
            for (const w of waiters.splice(0)) {
                w.reject(new Error(`child exited (code ${code}) before matching ${w.re}\n${out}`));
            }
        });

        // One answer per prompt, and each one is written only after ITS prompt has
        // actually appeared. readline registers the next `question()` listener only
        // once the previous one resolves, so answers that arrive early are silently
        // dropped and the interview stalls. Waiting on the prompt — rather than on a
        // timer — is what makes that safe on a slow, contended CI runner: a fixed
        // sleep loses the race under load and the run hangs with a half-filled config.
        const script = [
            [/Repo display name/, ''],
            [/interrupt\?/, ''],
            [/Profile \(lean/, ''],
            [/tracker\.project/, '4'],
            [/tracker\.owner/, ''],
            [/Typecheck gate/, ''],
            [/Test gate/, ''],
            [/Always-brake surfaces/, ''],
        ];
        for (const [prompt, answer] of script) {
            await awaitPrompt(prompt);
            child.stdin.write(`${answer}\n`);
        }
        child.stdin.end();
        const code = await new Promise((resolve) => child.on('close', resolve));
        assert.equal(code, 0, out);
        assert.match(out, /npm\/npx install/);
        assert.match(out, /cycle-setup/);
    });
});
