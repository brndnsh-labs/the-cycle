// End-to-end render tests: every profile, on every backend, into a throwaway repo.
//
// The engine tests cover the template language; these cover the thing that actually
// ships — that all 19 templates resolve, produce valid skill frontmatter, and render
// identically twice. A non-idempotent render would churn every consuming repo on
// every update, so that assertion earns its place.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'cycle.mjs');
const PROFILES = readdirSync(join(HERE, '..', 'profiles'))
    .filter((f) => f.endsWith('.jsonc') && !f.startsWith('_'))
    .map((f) => f.replace('.jsonc', ''));
const BACKENDS = ['forgejo', 'github'];

const REMOTES = {
    github: 'https://github.com/brndnsh/demo.git',
    forgejo: 'https://git.brndn.zip/brandon/demo.git',
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

/** GitHub needs a board number before it can render; supply one the way a user would. */
function setProject(dir) {
    const p = join(dir, '.cycle', 'config.jsonc');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"project": null', '"project": 4'));
}

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
                try {
                    cycle(dir, ['install', '--profile', profile, '--backend', backend, '-y']);
                } catch {
                    // github stops on the missing board number by design; supply and retry.
                    setProject(dir);
                    cycle(dir, ['update']);
                }
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
        const dir = scratchRepo('forgejo');
        dirs.push(dir);
        const plan = planOf(dir);

        assert.equal(plan.detected.backend, 'forgejo');
        assert.equal(plan.detected.slug, 'brandon/demo');
        // The gate is how you *invoke* the script, not what the script runs.
        assert.deepEqual(plan.detected.gates, { typecheck: 'npm run typecheck', test: 'npm test' });
        assert.equal(plan.existing_config, null);
        assert.equal(existsSync(join(dir, '.cycle')), false, '--plan must not write');
        assert.equal(existsSync(join(dir, '.claude')), false, '--plan must not write');
    });

    test('every question carries a reason, not just a default', () => {
        const dir = scratchRepo('forgejo');
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
        assert.ok(questions.some((q) => q.path === 'backend'));
    });

    test('surfaces what the chosen backend additionally requires', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const { questions } = planOf(dir);
        assert.ok(questions.some((q) => q.path === 'tracker.project'), 'github must ask for its board');
        assert.ok(questions.some((q) => q.path === 'tracker.owner'));
    });

    test('lists every overlay point with the guidance needed to draft it', () => {
        const dir = scratchRepo('forgejo');
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
        const dir = scratchRepo('forgejo');
        dirs.push(dir);
        const { draft, write } = planOf(dir);

        mkdirSync(join(dir, '.cycle'), { recursive: true });
        writeFileSync(join(dir, '.cycle', 'config.jsonc'), JSON.stringify(draft, null, 2));
        assert.equal(write.then, 'cycle update');
        cycle(dir, ['update']);
        assert.match(cycle(dir, ['check']), /clean/);
    });

    test('reports an existing install rather than pretending to be a first run', () => {
        const dir = scratchRepo('forgejo');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.equal(planOf(dir).existing_config, '.cycle/config.jsonc');
    });
});

// The whole point of the resolution chain is that a repo cloned onto a machine where
// the-cycle lives somewhere else still works. Baked-path-only would pass every other
// test here and fail on the second machine.
describe('shim resolution', () => {
    test('CYCLE_HOME overrides the path baked in at render time', () => {
        const dir = scratchRepo('forgejo');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '-y']);

        const elsewhere = mkdtempSync(join(tmpdir(), 'cycle-elsewhere-'));
        dirs.push(elsewhere);
        mkdirSync(join(elsewhere, 'helpers'));
        writeFileSync(join(elsewhere, 'helpers', 'forgejo.mjs'), 'console.log("SENTINEL", process.env.FORGEJO_REPO);\n');

        const r = spawnSync(process.execPath, [join(dir, 'scripts', 'forgejo.mjs')], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, CYCLE_HOME: elsewhere },
        });
        assert.match(r.stdout, /SENTINEL/, 'CYCLE_HOME was not preferred');
        // …and the repo's bindings ride along, which is what frees the helper from
        // hardcoding a repo slug.
        assert.match(r.stdout, /brandon\/demo/, 'shim did not pass its baked env through');
    });

    test('an exported value beats the baked-in binding', () => {
        const dir = scratchRepo('forgejo');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '-y']);

        const elsewhere = mkdtempSync(join(tmpdir(), 'cycle-elsewhere-'));
        dirs.push(elsewhere);
        mkdirSync(join(elsewhere, 'helpers'));
        writeFileSync(join(elsewhere, 'helpers', 'forgejo.mjs'), 'console.log(process.env.FORGEJO_REPO);\n');

        const r = spawnSync(process.execPath, [join(dir, 'scripts', 'forgejo.mjs')], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, CYCLE_HOME: elsewhere, FORGEJO_REPO: 'someone/else' },
        });
        assert.match(r.stdout, /someone\/else/);
    });
});

describe('drift detection', () => {
    let dir;
    before(() => {
        dir = scratchRepo('forgejo');
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
