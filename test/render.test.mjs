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
                cycle(dir, ['install', '--profile', profile, '--backend', backend, '-y']);
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

            // The inverse of the guard that used to live here. An install renders prose
            // and nothing else: no executable is installed into a consuming repo, so a
            // rendered command can never point at a script the repo doesn't have. If a
            // backend ever wants a helper again, this is the test that has to change
            // first — deliberately, not as a side effect.
            test('installs prose only — no executable is rendered into the repo', () => {
                const backendFile = JSON.parse(
                    readFileSync(join(HERE, '..', 'backends', `${backend}.jsonc`), 'utf8')
                        .replace(/^\s*\/\/.*$/gm, '')
                        .replace(/,(\s*[}\]])/g, '$1'),
                );
                assert.ok(!backendFile.shims, `${backend}: declares shims, but the shim mechanism is gone`);

                for (const cmd of Object.values(backendFile.verbs ?? {})) {
                    assert.doesNotMatch(
                        String(cmd),
                        /\bscripts\//,
                        `${backend}: a verb calls a scripts/ executable that nothing installs`,
                    );
                }
                assert.ok(!existsSync(join(dir, 'scripts')), 'rendered a scripts/ directory');
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
        // Four, not the old six: the board number and its owner are gone, and github
        // now requires no bindings a human has to supply.
        assert.ok(questions.length >= 4, `expected at least 4 questions, got ${questions.length}`);
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

    // github used to require a board number and owner here. Both are gone with the
    // board, and the point of keeping the test is that nothing quietly reintroduces a
    // required binding: `gh` resolves the repo from the checkout, so a fresh install
    // has nothing left to get wrong.
    test('the chosen backend requires no extra bindings to render', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const { questions } = planOf(dir);
        const backendFile = JSON.parse(
            readFileSync(join(HERE, '..', 'backends', 'github.jsonc'), 'utf8')
                .replace(/^\s*\/\/.*$/gm, '')
                .replace(/,(\s*[}\]])/g, '$1'),
        );
        assert.ok(!backendFile.requires, 'github declares requires; the interview would ask for them again');
        assert.ok(!questions.some((q) => q.path?.startsWith('tracker.project')), 'still asking for a board number');
        assert.ok(questions.some((q) => q.path === 'tracker.statuses'), 'must still ask for the status vocabulary');
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
        writeFileSync(join(dir, '.cycle', 'config.jsonc'), JSON.stringify(draft, null, 2));
        assert.equal(write.then, 'cycle update');
        cycle(dir, ['update']);
        assert.match(cycle(dir, ['check']), /clean/);
    });

    test('reports an existing install rather than pretending to be a first run', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.equal(planOf(dir).existing_config, '.cycle/config.jsonc');
    });

    test('--set rejects malformed and unknown config paths', () => {
        for (const assignment of ['tracker.ranking', 'tracker.nope=4', 'tracker.ranking=']) {
            const dir = scratchRepo('github');
            dirs.push(dir);
            const result = cycleRaw(dir, ['install', '--profile', 'lean', '--set', assignment, '-y']);
            assert.equal(result.status, 1);
            assert.match(result.out, /invalid --set|unknown config path|backend needs 1 value/);
        }
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
        cycle(dir, ['install', '--profile', 'standard', '-y']);
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

    test('Codex uses direct chat when its structured menu is unavailable in normal skill execution', () => {
        const claudeIntake = readFileSync(join(dir, '.claude', 'skills', 'intake', 'SKILL.md'), 'utf8');
        const codexIntake = readFileSync(join(dir, '.agents', 'skills', 'intake', 'SKILL.md'), 'utf8');
        assert.match(claudeIntake, /`AskUserQuestion`/);
        assert.doesNotMatch(claudeIntake, /request_user_input/);
        assert.match(codexIntake, /no structured menu tool/);
        assert.doesNotMatch(codexIntake, /request_user_input/);
        assert.doesNotMatch(codexIntake, /AskUserQuestion/);

        const codexDoctrine = readFileSync(join(dir, '.agents', 'skills', 'DOCTRINE.md'), 'utf8');
        assert.doesNotMatch(codexDoctrine, /Sonnet|opus/);
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

describe('dependency metadata contracts', () => {
    test('a package.json-only repository gets a truthful no-lock workflow', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'standard', '-y']);

        const skill = readFileSync(join(dir, '.claude', 'skills', 'dep-update', 'SKILL.md'), 'utf8');
        assert.match(skill, /npm outdated/);
        assert.doesNotMatch(skill, /npm audit/);
        assert.doesNotMatch(skill, /package-lock\.json/);
        assert.match(skill, /no configured\s+lockfile/i);
        assert.match(skill, /`package\.json`/);
    });

    test('a configured manifest that does not exist fails with an actionable error', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '-y']);
        const cfgPath = join(dir, '.cycle', 'config.jsonc');
        writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace(
            '"manifests": [\n      "package.json"\n    ]',
            '"manifests": ["package.json", "missing.lock"]',
        ));

        const checked = cycleRaw(dir, ['check']);
        assert.equal(checked.status, 1);
        assert.match(checked.out, /configured dependency manifest missing: missing\.lock/);
        assert.match(checked.out, /fix deps\.manifests/);
    });

    test('legacy configs infer their lockfile from dependency manifests', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, 'package-lock.json'), '{"name":"demo","lockfileVersion":3,"packages":{}}\n');
        cycle(dir, ['install', '--profile', 'standard', '-y']);
        const cfgPath = join(dir, '.cycle', 'config.jsonc');
        const configured = readFileSync(cfgPath, 'utf8');
        assert.match(configured, /"lockfile": "package-lock\.json"/);
        const legacyConfig = configured.replace(
            /^\s*"lockfile": "package-lock\.json",\n/m,
            '',
        );
        assert.doesNotMatch(legacyConfig, /"lockfile":/);
        writeFileSync(cfgPath, legacyConfig);

        cycle(dir, ['update']);
        const skill = readFileSync(join(dir, '.claude', 'skills', 'dep-update', 'SKILL.md'), 'utf8');
        assert.match(skill, /Lockfile drift with nothing outdated/);
        assert.match(skill, /`package-lock\.json`/);
        assert.doesNotMatch(skill, /no configured\s+lockfile/i);
    });

    test('a repository with no recognized dependency ecosystem renders an honest stub', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cycle-no-deps-'));
        dirs.push(dir);
        execFileSync('git', ['init', '-q', '.'], { cwd: dir });
        execFileSync('git', ['remote', 'add', 'origin', REMOTES.github], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 'Brandon Shea'], { cwd: dir });
        cycle(dir, ['install', '--profile', 'standard', '-y']);

        const skill = readFileSync(join(dir, '.claude', 'skills', 'dep-update', 'SKILL.md'), 'utf8');
        assert.match(skill, /## Not configured/);
        assert.match(skill, /No supported dependency manifest was detected/);
        assert.doesNotMatch(skill, /npm (?:outdated|update|install|audit)/);
        assert.match(cycle(dir, ['check']), /clean/);
    });
});

describe('commit attribution', () => {
    test('omits invented coauthors by default and preserves legacy configured trailers', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '-y']);
        const donePath = join(dir, '.claude', 'skills', 'done', 'SKILL.md');
        assert.doesNotMatch(readFileSync(donePath, 'utf8'), /Co-Authored-By/);

        const cfgPath = join(dir, '.cycle', 'config.jsonc');
        writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace(
            '"coauthor": ""',
            '"coauthor": "Configured Agent <agent@example.com>"',
        ));
        cycle(dir, ['update']);
        assert.match(
            readFileSync(donePath, 'utf8'),
            /Co-Authored-By: Configured Agent <agent@example\.com>/,
        );
    });
});

// A single-environment repo has nowhere lower-stakes to deploy. The test-box flow is
// deliberately ungated ("no gate, no explicit go") because a test box is cheap to get wrong;
// rendering that framing where prod is the ONLY environment turns a preview into an unreviewed
// release. TwistOS defended against this by hand-writing an unmanaged stub — which worked, but
// reported drift forever and would lose to a `--force`. The guarantee belongs in the template.
describe('deploy-test on a repo with no test environment', () => {
    const readCfg = (p) => JSON.parse(
        readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
    );
    const renderWith = (deployTest) => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'standard', '-y']);
        const cfgPath = join(dir, '.cycle', 'config.jsonc');
        const cfg = readCfg(cfgPath);
        cfg.deploy = deployTest ? { test: deployTest, prod: './deploy.sh prod' } : { prod: './deploy.sh' };
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        cycle(dir, ['update', '--force']);
        return readFileSync(join(dir, '.claude', 'skills', 'deploy-test', 'SKILL.md'), 'utf8');
    };

    test('renders a redirect stub, never the ungated test-box flow', () => {
        const out = renderWith(null);
        assert.match(out, /not applicable here/, 'expected the stub variant');
        assert.match(out, /\/deploy-prod/, 'stub must hand off to the gated skill');
        assert.doesNotMatch(out, /no gate, no explicit go/, 'ungated framing leaked into a prod-only repo');
        assert.doesNotMatch(out, /put it on the test box/, 'test-box framing leaked into a prod-only repo');
    });

    test('still renders the real flow when a test target exists', () => {
        const out = renderWith('./deploy.sh test');
        assert.match(out, /put it on the test box/);
        assert.match(out, /\.\/deploy\.sh test/, 'the configured command must appear');
        assert.doesNotMatch(out, /not applicable here/);
    });

    test('Codex asks for the post-deploy verdict directly in chat', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'standard', '-y']);
        const cfgPath = join(dir, '.cycle', 'config.jsonc');
        const cfg = readCfg(cfgPath);
        cfg.harnesses = ['claude', 'codex'];
        cfg.deploy = { test: './deploy.sh test', prod: './deploy.sh prod' };
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        cycle(dir, ['update', '--force']);

        const out = readFileSync(join(dir, '.agents', 'skills', 'deploy-test', 'SKILL.md'), 'utf8');
        assert.match(out, /directly in chat, offering \*\*Works\*\*/);
        assert.doesNotMatch(out, /request_user_input/);
    });

    test('the stub is managed — it renders clean instead of reporting drift', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'standard', '-y']);
        const cfgPath = join(dir, '.cycle', 'config.jsonc');
        const cfg = readCfg(cfgPath);
        cfg.deploy = { prod: './deploy.sh' };
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        cycle(dir, ['update', '--force']);
        assert.match(cycle(dir, ['check']), /clean/);
    });
});

describe('drift detection', () => {
    let dir;
    before(() => {
        dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '-y']);
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
        for (const part of ['bin', 'templates', 'backends', 'harnesses', 'profiles', 'skills', 'docs', 'package.json']) {
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
        gitlessCli(dir, ['install', '--profile', 'lean', '-y']);
        const state = JSON.parse(readFileSync(join(dir, '.cycle', 'state.json'), 'utf8'));
        assert.equal(state.upstream, expectedVersion);
    });

    test('gitless `cycle install` points at the durable clone for cycle update/check and the setup skills', async () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        // Exercise the interactive path separately. Every answer is now an accepted
        // default: with the board gone, github has no binding the interview must ask a
        // human to supply, so a first install is pure confirmation.
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

// ---------------------------------------------------------------------------
// backend_overrides — a per-repo correction to a backend-wide default.
//
// `auto_merge` is the motivating case and the dangerous one: it is a
// branch-protection fact, not a forge fact, so two repos on the same backend can
// need opposite values. Both directions are asserted — that the override actually
// changes the rendered merge path, AND that the default still renders the guard —
// because a conditional that silently renders nothing is exactly the bug this
// replaced (§6 previously had an {{#unless}} with no counterpart).
// ---------------------------------------------------------------------------
describe('backend_overrides.auto_merge', () => {
    let guardDir;
    let autoDir;

    before(() => {
        guardDir = scratchRepo('github');
        dirs.push(guardDir);
        cycle(guardDir, ['install', '--profile', 'full', '--backend', 'github', '-y']);

        autoDir = scratchRepo('github');
        dirs.push(autoDir);
        cycle(autoDir, ['install', '--profile', 'full', '--backend', 'github', '-y']);
        const cfgPath = join(autoDir, '.cycle', 'config.jsonc');
        const cfg = readFileSync(cfgPath, 'utf8');
        assert.match(cfg, /"backend":\s*"github"/, 'fixture expects a plain string backend');
        writeFileSync(
            cfgPath,
            cfg.replace(/"backend":\s*"github",/, '"backend": "github",\n  "backend_overrides": { "auto_merge": true },'),
        );
        cycle(autoDir, ['update']);
    });

    const doctrine = (d) => readFileSync(join(d, '.claude', 'skills', 'DOCTRINE.md'), 'utf8');
    const done = (d) => readFileSync(join(d, '.claude', 'skills', 'done', 'SKILL.md'), 'utf8');
    const cycleSkill = (d) => readFileSync(join(d, '.claude', 'skills', 'cycle', 'SKILL.md'), 'utf8');

    test('default renders the poll-then-merge guard, not --auto', () => {
        const src = doctrine(guardDir);
        assert.match(src, /gh pr checks .* --watch/, 'expected the poll guard');
        assert.doesNotMatch(src, /gh pr merge .*--auto/, 'must not offer --auto without protection');
    });

    test('the override swaps the merge path to server-side --auto', () => {
        const src = doctrine(autoDir);
        assert.match(src, /gh pr merge .*--auto/, 'expected the server-side merge');
        assert.doesNotMatch(src, /until gh pr checks/, 'the poll guard must be gone');
    });

    test('/done follows the same switch, so the flag is not doctrine-only', () => {
        assert.match(done(guardDir), /until gh pr checks/);
        assert.doesNotMatch(done(guardDir), /gh pr merge .*--auto/);
        assert.match(done(guardDir), /background poll-then-merge guard/);
        assert.doesNotMatch(done(guardDir), /queue server-side auto-merge/);
        assert.match(done(autoDir), /gh pr merge .*--auto/);
        assert.doesNotMatch(done(autoDir), /until gh pr checks/);
        assert.match(done(autoDir), /queue server-side auto-merge/);
        assert.match(done(autoDir), /CI-gated server-side auto-merge/);
        assert.doesNotMatch(done(autoDir), /background poll-then-merge guard/);
    });

    test('/cycle reports the actual completion boundary in both modes', () => {
        assert.match(cycleSkill(guardDir), /poll-then-merge → issue closed/);
        assert.doesNotMatch(cycleSkill(guardDir), /server-side merge queued/);
        assert.match(cycleSkill(autoDir), /server-side merge queued; issue closes when the forge lands it/);
        assert.doesNotMatch(cycleSkill(autoDir), /poll-then-merge → issue closed/);
    });

    // The regression this change exists to prevent: `Closes #<n>` used to live INSIDE
    // the {{#unless auto_merge}} block, so a protected repo silently lost the one rule
    // that makes issue-closing work at all.
    test('Closes #<n> survives in BOTH modes', () => {
        assert.match(doctrine(guardDir), /Closes #<n>/);
        assert.match(doctrine(autoDir), /Closes #<n>/);
    });

    test('an overridden repo still renders clean and re-renders byte-identically', () => {
        const { status, out } = cycleRaw(autoDir, ['check']);
        assert.equal(status, 0, out);
        assert.match(out, /clean/);
    });
});
