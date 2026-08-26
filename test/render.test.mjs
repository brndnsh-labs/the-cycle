// End-to-end render tests: every profile, on every backend, through every harness,
// into a throwaway repo.
//
// The engine tests cover the template language; these cover the thing that actually
// ships — that every registered combination resolves, produces valid skill
// frontmatter, and renders identically twice. A non-idempotent render would churn
// every consuming repo on every update, so that assertion earns its place.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonc } from '../bin/cycle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'cycle.mjs');
const registryNames = (registry) => readdirSync(join(HERE, '..', registry))
    .filter((f) => f.endsWith('.jsonc') && !f.startsWith('_'))
    .map((f) => f.replace('.jsonc', ''));
const registryEntry = (registry, name) => readJsonc(join(HERE, '..', registry, `${name}.jsonc`));

const PROFILES = registryNames('profiles');
const BACKENDS = registryNames('backends');
const HARNESSES = registryNames('harnesses').map((name) => registryEntry('harnesses', name));
const DEMO_REMOTE = 'https://github.com/brandon/demo.git';

function scratchRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-render-'));
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: 'pipe' });
    run('git', ['init', '-q', '.']);
    run('git', ['remote', 'add', 'origin', DEMO_REMOTE]);
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
        const profileConfig = registryEntry('profiles', profile);
        for (const harness of HARNESSES) {
            describe(`${profile} on ${backend} through ${harness.name}`, () => {
                let dir;
                let skillRoot;
                let skills;
                let managedFiles;

                before(() => {
                    dir = scratchRepo();
                    dirs.push(dir);
                    cycle(dir, [
                        'install', '--profile', profile, '--backend', backend,
                        '--set', `harnesses=${JSON.stringify([harness.name])}`, '-y',
                    ]);
                    skillRoot = join(dir, harness.root);
                    skills = readdirSync(skillRoot, { withFileTypes: true })
                        .filter((e) => e.isDirectory())
                        .map((e) => e.name);
                    managedFiles = [
                        ...skills.map((s) => join(skillRoot, s, harness.skill_file)),
                        join(skillRoot, 'DOCTRINE.md'),
                    ];
                });

                test('renders every skill in the profile', () => {
                    const expected = profileConfig.skills;
                    assert.deepEqual(skills.sort(), [...expected].sort());
                    assert.ok(existsSync(join(skillRoot, 'DOCTRINE.md')));
                });

                test('every skill has parseable frontmatter and a provenance stamp', () => {
                    for (const s of skills) {
                        const text = readFileSync(join(skillRoot, s, harness.skill_file), 'utf8');
                        const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
                        assert.ok(fm, `${s}: no frontmatter`);
                        assert.match(fm[1], /^name: /m, `${s}: no name`);
                        assert.match(fm[1], /^description: /m, `${s}: no description`);
                        assert.equal(new RegExp(`^name: ${s}$`, 'm').test(fm[1]), true, `${s}: name mismatch`);
                        assert.match(text, /<!-- cycle:rendered /, `${s}: no provenance`);
                    }
                });

                if (profileConfig.skills.includes('patch')) {
                    test('patch permits only justified companion files', () => {
                        const patch = readFileSync(join(skillRoot, 'patch', harness.skill_file), 'utf8');
                        assert.match(patch, /Never patch an unrelated file/);
                        assert.match(patch, /may be changed only\s+when it is directly required to resolve a cited finding/);
                        assert.match(patch, /additional file \+ reason must appear in the patch\s+plan before editing/);
                        assert.match(patch, /exception never permits opportunistic cleanup or new ideas/);
                        assert.match(patch, /any directly required companion file and why/);
                    });
                }

                // A leftover {{…}} means a template referenced something config doesn't have
                // and the engine let it through — the exact failure the loud-unresolved rule
                // exists to prevent.
                test('no unrendered template syntax survives', () => {
                    for (const file of managedFiles) {
                        const text = readFileSync(file, 'utf8');
                        const leftover = (text.match(/\{\{[^}]*\}\}/g) ?? []).filter(
                            (m, i, all) => !text.includes(`$${all[i]}`),
                        );
                        assert.deepEqual(leftover, [], `${relative(dir, file)}: unrendered ${leftover.join(', ')}`);
                    }
                });

                test('managed output contains no trailing whitespace', () => {
                    for (const file of managedFiles) {
                        const text = readFileSync(file, 'utf8');
                        assert.doesNotMatch(text, /[ \t]+$/m, `${relative(dir, file)}: trailing whitespace`);
                    }
                });

                // The inverse of the guard that used to live here. An install renders prose
                // and nothing else: no executable is installed into a consuming repo, so a
                // rendered command can never point at a script the repo doesn't have. If a
                // backend ever wants a helper again, this is the test that has to change
                // first — deliberately, not as a side effect.
                test('installs prose only — no executable is rendered into the repo', () => {
                    const backendFile = registryEntry('backends', backend);
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
                    const before = managedFiles.map((file) => readFileSync(file, 'utf8'));
                    cycle(dir, ['update']);
                    const after = managedFiles.map((file) => readFileSync(file, 'utf8'));
                    assert.deepEqual(after, before);
                });
            });
        }
    }
}

// #29: `gh issue edit` does not guarantee remove-before-add when both flags are
// used in one invocation. The target is deliberately present in the derived
// clear-list, so every rendered transition must use two ordered calls rather
// than letting the CLI race the same label against itself.
describe('status transition ordering (#29)', () => {
    let dir;
    let rendered;

    before(() => {
        dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'full', '--backend', 'github', '-y']);
        const skillRoot = join(dir, '.claude', 'skills');
        const files = [
            join(skillRoot, 'DOCTRINE.md'),
            ...readdirSync(skillRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => join(skillRoot, entry.name, 'SKILL.md')),
        ];
        rendered = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    });

    test('the backend verb separates removal from addition with an explicit guard', () => {
        const raw = readFileSync(join(HERE, '..', 'backends', 'github.jsonc'), 'utf8');
        const backend = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
        assert.equal(
            backend.verbs.set_status,
            'gh issue edit $1 --remove-label "{{tracker.status_labels}}" && gh issue edit $1 --add-label $2',
        );
    });

    test('every rendered status transition removes, then conditionally adds', () => {
        const transitions = rendered.split('\n').filter(
            (line) => line.includes('--remove-label "status:') && line.includes('--add-label "'),
        );
        assert.ok(transitions.length > 0, 'fixture rendered no status transitions');
        for (const line of transitions) {
            const [remove, add, ...extra] = line.split(' && ');
            assert.equal(extra.length, 0, line);
            const removed = /--remove-label "([^"]+)"/.exec(remove)?.[1].split(',') ?? [];
            const target = /--add-label "([^"]+)"/.exec(add)?.[1];
            assert.ok(removed.length > 0 && removed.every((label) => label.startsWith('status:')), remove);
            assert.doesNotMatch(remove, /--add-label/);
            assert.match(add, /gh issue edit .* --add-label "(?:status:|<status:label>)/);
            assert.doesNotMatch(add, /--remove-label/);
            assert.ok(target, add);
            if (target !== '<status:label>') {
                assert.ok(removed.includes(target), `target ${target} missing from clear-list: ${remove}`);
            }
        }
    });
});

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

    test('a credentialed remote reaches the plan without its userinfo', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        execFileSync('git', ['remote', 'set-url', 'origin', 'https://x-access-token:ghp_SECRET123@github.com/brandon/demo.git'], { cwd: dir, stdio: 'pipe' });

        const out = cycle(dir, ['install', '--plan']);
        assert.doesNotMatch(out, /ghp_SECRET123/, 'the token must not reach plan stdout');
        assert.equal(JSON.parse(out).detected.remote, 'https://github.com/brandon/demo.git');
        assert.equal(JSON.parse(out).detected.slug, 'brandon/demo', 'redaction must not cost the slug');
    });

    test('a credentialed remote whose userinfo contains a slash still redacts', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        // WHATWG URL parsing cannot represent a raw "/" inside userinfo — the whole
        // remote fails to parse — so this exercises the fallback strip, not the URL
        // branch. A token that only reaches stdout unredacted through that gap.
        execFileSync('git', ['remote', 'set-url', 'origin', 'https://x-access-token:ghp_SLASH/y9ZTOKEN@github.com/brandon/demo.git'], { cwd: dir, stdio: 'pipe' });

        const out = cycle(dir, ['install', '--plan']);
        assert.doesNotMatch(out, /ghp_SLASH/, 'the token must not reach plan stdout');
        assert.doesNotMatch(out, /y9ZTOKEN/, 'neither may its second half');
        assert.equal(JSON.parse(out).detected.remote, 'https://github.com/brandon/demo.git');
        assert.equal(JSON.parse(out).detected.slug, 'brandon/demo', 'redaction must not cost the slug');
    });

    test('a percent-encoded credential rides the URL branch and still redacts', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        execFileSync('git', ['remote', 'set-url', 'origin', 'https://x-access-token:ghp_ENC%2Fx9@github.com/brandon/demo.git'], { cwd: dir, stdio: 'pipe' });

        const out = cycle(dir, ['install', '--plan']);
        assert.doesNotMatch(out, /ghp_ENC/, 'the encoded token must not reach plan stdout');
        assert.doesNotMatch(out, /%2F/, 'not even encoded');
        assert.equal(JSON.parse(out).detected.remote, 'https://github.com/brandon/demo.git');
        assert.equal(JSON.parse(out).detected.slug, 'brandon/demo', 'redaction must not cost the slug');
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

// #77: a stdin EOF mid-interview used to leave rl.question's promise pending forever,
// so `cycle install < /dev/null` exited 0 having written nothing — a silent success for
// an aborted setup. EOF must abort loudly instead.
describe('install interview vs stdin EOF (#77)', () => {
    test('a closed stdin exits non-zero with the abort error instead of silently succeeding', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);

        // input: '' closes the child's stdin immediately — the `< /dev/null` repro.
        const r = spawnSync(process.execPath, [CLI, 'install'], {
            cwd: dir, input: '', encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
        });
        assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /interview aborted: stdin closed before setup completed/);
        assert.equal(existsSync(join(dir, '.cycle')), false, 'the aborted install must write nothing');
    });
});

// #78: a typo'd flag used to dump parseArgs' internal stack trace instead of getting
// the same clean ✗ + hint every other user-facing failure gets.
describe('unknown flag vs error treatment (#78)', () => {
    test('an unknown option exits 1 with a clean message and no stack trace', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);

        const r = spawnSync(process.execPath, [CLI, 'update', '--dr-run'], {
            cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
        });
        assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /✗.*[Uu]nknown option/);
        assert.match(r.stderr, /cycle --help/);
        assert.doesNotMatch(r.stderr, /^\s+at /m, 'no internal stack trace');
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

    test('both doctrines distinguish a sandbox-blocked read from a confirmed tracker outage', () => {
        for (const root of ['.claude', '.agents']) {
            const doctrine = readFileSync(join(dir, root, 'skills', 'DOCTRINE.md'), 'utf8');
            assert.match(doctrine, /first transport or OS-permission failure can be the harness\s+sandbox/);
            assert.match(doctrine, /retry the \*\*exact same read once\*\*/);
            assert.match(doctrine, /Stop if\s+that retry fails/);
            assert.match(doctrine, /Never loop, guess tracker state, or substitute cached data/);
        }
    });

    test('both Scout trees hand broader threads to a separately requested focused pass', () => {
        for (const root of ['.claude', '.agents']) {
            const scout = readFileSync(join(dir, root, 'skills', 'scout', 'SKILL.md'), 'utf8');
            assert.match(scout, /Broader threads are a handoff, not an implicit wider sweep/);
            assert.match(scout, /distinguish likely surfaces from verified ones/);
            assert.match(scout, /whether one issue is sufficient or several independent issues are warranted/);
            assert.match(scout, /focused follow-up `\/scout <lens>` pass/);
            assert.match(scout, /Do \*\*not\*\* automatically broaden the current sweep/);
            assert.match(scout, /any credible \*\*broader thread\*\*\s+handoff from above/);
        }
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

    test('eject rejects a name that resolves outside the harness trees', () => {
        const outside = join(dir, '..', 'eject-victim.md');
        writeFileSync(outside, '<!-- cycle:rendered template=x hash=abc -->\nhello');
        const refused = cycleRaw(dir, ['eject', '../../../eject-victim.md/SKILL.md']);
        assert.equal(refused.status, 1);
        assert.match(refused.out, /does not name a skill inside/);
        assert.match(readFileSync(outside, 'utf8'), /cycle:rendered/, 'the outside file must be untouched');
        rmSync(outside);
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
        execFileSync('git', ['remote', 'add', 'origin', DEMO_REMOTE], { cwd: dir });
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
    test('ignores legacy repo coauthors and keeps harness-specific PR provenance', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '-y']);
        const cfgPath = join(dir, '.cycle', 'config.jsonc');
        assert.doesNotMatch(readFileSync(cfgPath, 'utf8'), /"coauthor"/);

        const donePath = join(dir, '.claude', 'skills', 'done', 'SKILL.md');
        assert.doesNotMatch(readFileSync(donePath, 'utf8'), /Co-Authored-By:/);

        writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8')
            .replace('"harnesses": [\n    "claude"\n  ],', '"harnesses": ["claude", "opencode"],')
            .replace(
                '  "deploy": {',
                '  "commit": { "coauthor": "Stale Model <stale@example.com>" },\n  "deploy": {',
            ));
        assert.match(readFileSync(cfgPath, 'utf8'), /Stale Model <stale@example\.com>/);
        cycle(dir, ['update']);

        const openCodeDone = join(dir, '.opencode', 'skills', 'done', 'SKILL.md');
        for (const path of [donePath, openCodeDone]) {
            const rendered = readFileSync(path, 'utf8');
            assert.doesNotMatch(rendered, /Stale Model|stale@example\.com/);
            assert.match(rendered, /active runtime explicitly supplies a truthful identity/);
            assert.match(rendered, /Never infer an identity from repo config/);
        }

        const claudeDoctrine = readFileSync(join(dir, '.claude', 'skills', 'DOCTRINE.md'), 'utf8');
        const openCodeDoctrine = readFileSync(join(dir, '.opencode', 'skills', 'DOCTRINE.md'), 'utf8');
        assert.match(claudeDoctrine, /Generated with \[Claude Code\]/);
        assert.match(openCodeDoctrine, /Generated with \[OpenCode\]/);
        assert.doesNotMatch(`${claudeDoctrine}\n${openCodeDoctrine}`, /Stale Model|stale@example\.com/);
        assert.match(cycle(dir, ['check']), /clean/);
    });
});

// A repository with no production command must not render executable-sounding verification or
// generic rollback instructions after the explicit stop. A consuming repo may document its real
// external release topology in the deploy overlay; the shared template must not contradict it.
describe('deploy-prod on a repo with no production command', () => {
    const renderWith = (deployProd) => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '-y']);
        const cfgPath = join(dir, '.cycle', 'config.jsonc');
        const cfg = JSON.parse(
            readFileSync(cfgPath, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
        );
        cfg.deploy = deployProd ? { prod: deployProd } : {};
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        cycle(dir, ['update', '--force']);
        return readFileSync(join(dir, '.claude', 'skills', 'deploy-prod', 'SKILL.md'), 'utf8');
    };

    test('renders an honest stop without generic verification or rollback steps', () => {
        const out = renderWith(null);
        assert.match(out, /has no configured production deploy/);
        assert.match(out, /deploy\.prod` is not set/);
        assert.doesNotMatch(out, /## 4\. Verify independently/);
        assert.doesNotMatch(out, /Rollback = roll forward/);
        assert.doesNotMatch(out, /Deploy fails partway/);
        assert.doesNotMatch(out, /Verification disagrees with the deploy script/);
    });

    test('keeps the full verification and rollback flow when production is configured', () => {
        const out = renderWith('./deploy.sh prod');
        assert.match(out, /\.\/deploy\.sh prod/);
        assert.match(out, /## 4\. Verify independently/);
        assert.match(out, /Rollback = roll forward/);
        assert.match(out, /Deploy fails partway/);
        assert.match(out, /Verification disagrees with the deploy script/);
        assert.doesNotMatch(out, /has no configured production deploy/);
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

    test('--dry-run exits non-zero while a conflict and a pending write coexist', () => {
        rmSync(join(dir, '.claude', 'skills', 'scout', 'SKILL.md'));

        const dry = cycleRaw(dir, ['update', '--dry-run']);
        assert.match(dry.out, /refusing to overwrite/);
        assert.match(dry.out, /dry run/);
        assert.equal(dry.status, 1, 'a dry run must not go green while the update it previews would refuse');

        const applied = cycleRaw(dir, ['update']);
        assert.equal(applied.status, 1, 'the real update refuses the same conflict');
    });

    test('--force applies the template over a hand edit', () => {
        cycle(dir, ['update', '--force']);
        assert.doesNotMatch(readFileSync(join(dir, '.claude/skills/patch/SKILL.md'), 'utf8'), /hand-written/);
        assert.match(cycle(dir, ['check']), /clean/);
    });
});

// #11: a reflow-only formatter pass reads as a hand edit under the byte-hash drift
// check, which permanently blocks `cycle update` — the fix keeps the formatter off
// rendered trees, reported (never auto-written) at both install and update time.
describe('formatter guidance (#11)', () => {
    test('a prettier repo with no .prettierignore is told exactly what to add', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, '.prettierrc.json'), '{}');
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.match(out, /prettier reformats markdown/);
        assert.match(out, /\.prettierignore/);
        assert.match(out, /\.claude\/skills\//);
    });

    test('every supported standalone prettier config filename triggers guidance', () => {
        const markers = [
            '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml',
            '.prettierrc.json5', '.prettierrc.toml',
            '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.ts',
            '.prettierrc.cts', '.prettierrc.mts',
            'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
            'prettier.config.ts', 'prettier.config.cts', 'prettier.config.mts',
        ];
        for (const marker of markers) {
            const dir = scratchRepo('github');
            dirs.push(dir);
            writeFileSync(join(dir, marker), '{}');
            const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
            assert.match(out, /prettier reformats markdown/, marker);
        }
    });

    test('a package.yaml prettier key triggers guidance without a local dependency', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, 'package.yaml'), 'name: example\nprettier:\n  printWidth: 100\n');
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.match(out, /prettier reformats markdown/);
    });

    test('a prettier repo whose .prettierignore already covers the harness root gets no guidance', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, '.prettierrc.json'), '{}');
        writeFileSync(join(dir, '.prettierignore'), '.claude/skills/\n');
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.doesNotMatch(out, /formatter:/);

        const updated = cycleRaw(dir, ['update']);
        assert.doesNotMatch(updated.out, /formatter:/);
    });

    test('a later prettier negation makes whole-tree coverage unproven', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, '.prettierrc.json'), '{}');
        writeFileSync(join(dir, '.prettierignore'), '.claude/skills/\n!.claude/skills/DOCTRINE.md\n');
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.match(out, /prettier reformats markdown/);
    });

    test('a dprint repo with no matching exclude is told exactly what to add', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, 'dprint.json'), JSON.stringify({ excludes: [] }));
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.match(out, /dprint reformats markdown/);
        assert.match(out, /dprint\.json/);
        assert.match(out, /"\.claude\/skills\/\*\*"/);
    });

    test('a dprint repo whose excludes already cover the harness root gets no guidance', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, 'dprint.json'), JSON.stringify({ excludes: ['.claude/skills/**'] }));
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.doesNotMatch(out, /formatter:/);
    });

    test('dprint hidden config filenames are detected', () => {
        for (const config of ['.dprint.json', '.dprint.jsonc']) {
            const dir = scratchRepo('github');
            dirs.push(dir);
            writeFileSync(join(dir, config), JSON.stringify({ excludes: [] }));
            const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
            assert.match(out, /dprint reformats markdown/, config);
        }
    });

    test('a later dprint negation makes whole-tree coverage unproven', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, 'dprint.json'), JSON.stringify({
            excludes: ['.claude/skills/**', '!.claude/skills/DOCTRINE.md'],
        }));
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.match(out, /dprint reformats markdown/);
    });

    test('an unrelated later dprint negation leaves whole-tree coverage intact', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, 'dprint.json'), JSON.stringify({
            excludes: ['.claude/skills/**', '!dist.js'],
        }));
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.doesNotMatch(out, /formatter:/);
    });

    test('a dprint exclude that only names one file still gets flagged as missing', () => {
        // `.claude/skills/README.md` excludes a single file, not the subtree — every
        // actual SKILL.md (nested one level deeper) is still exposed to reflow, so this
        // must not be mistaken for coverage the way a naive prefix match would.
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, 'dprint.json'), JSON.stringify({ excludes: ['.claude/skills/README.md'] }));
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.match(out, /dprint reformats markdown/);
    });

    test('a malformed dprint config is reported, not crashed on', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        writeFileSync(join(dir, 'dprint.json'), '{ not valid json');
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.match(out, /could not be parsed/);
    });

    test('a repo with neither formatter gets no guidance at all', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const out = cycle(dir, ['install', '--profile', 'lean', '-y']);
        assert.doesNotMatch(out, /formatter:/);
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
            [/Harnesses \(comma-separated/, ''],
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
        const guardLine = src.split('\n').find((line) => line.includes('until gh pr checks'));
        assert.ok(guardLine, 'expected a rendered foreground guard command');
        assert.match(src, /gh pr checks .* --watch/, 'expected the poll guard');
        assert.match(src, /one foreground, resumable command/);
        assert.match(src, /resume that same command\/session/);
        assert.doesNotMatch(guardLine, /&\s*$/, 'poll guard must not detach');
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
        assert.match(done(guardDir), /foreground poll-then-merge guard/);
        assert.match(done(guardDir), /one foreground, resumable command/);
        assert.doesNotMatch(done(guardDir), /queue server-side auto-merge/);
        assert.match(done(autoDir), /gh pr merge .*--auto/);
        assert.doesNotMatch(done(autoDir), /until gh pr checks/);
        assert.match(done(autoDir), /queue server-side auto-merge/);
        assert.match(done(autoDir), /CI-gated server-side auto-merge/);
        assert.doesNotMatch(done(autoDir), /foreground poll-then-merge guard/);
    });

    test('/done marks review when the PR opens, never after merge or queueing', () => {
        for (const src of [done(guardDir), done(autoDir)]) {
            const pr = src.indexOf('gh pr create');
            const review = src.indexOf('--add-label "status:in-review"');
            const comment = src.indexOf('gh issue comment');
            assert.ok(pr >= 0 && review > pr && comment > review, 'review must follow PR creation');
            assert.equal(src.indexOf('--add-label "status:in-review"', review + 1), -1);
            assert.doesNotMatch(src, /Status explicitly/);
        }
    });

    test('the doctrine makes closure authoritative and reopening an explicit reroute', () => {
        const src = doctrine(guardDir);
        assert.match(src, /Status labels route \*\*open\*\* issues only/);
        assert.match(src, /Reopening starts a new routing decision: explicitly set the next status/);
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

describe('autonomy checkpoints (#41)', () => {
    let dir;
    const skill = (name) => readFileSync(join(dir, '.claude', 'skills', name, 'SKILL.md'), 'utf8');

    before(() => {
        dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'full', '--backend', 'github', '-y']);
    });

    test('/cycle continues after visibility checkpoints and pauses only for no progress', () => {
        const src = skill('cycle');
        assert.match(src, /emits a progress checkpoint after every 5 stories, then continues/);
        assert.doesNotMatch(src, /then confirms/);
        assert.match(src, /without fresh evidence of progress/);
        assert.match(src, /Elapsed time alone does not require confirmation/);
    });

    test('/burndown refreshes its safe queue at a checkpoint instead of stopping there', () => {
        const src = skill('burndown');
        assert.match(src, /reports progress every 5 shipped items but stops only for a real gate, a dry queue, or an interrupt/);
        assert.match(src, /After every 5 shipped items, report a progress checkpoint/);
        assert.match(src, /refresh the open set, and reapply the safe filter before continuing/);
        assert.doesNotMatch(src, /5 items shipped.*check in \(runaway guard\)/);
    });

    test('/nightly treats the five-item boundary as visibility, not a stop condition', () => {
        const src = skill('nightly');
        assert.match(src, /Continues through `\/burndown`'s five-item visibility checkpoints/);
        assert.doesNotMatch(src, /including the 5-item guard/);
    });
});

// The fast path (issue #24): implement/review/done compress ceremony for a small,
// deterministic, gate-verifiable docs/config diff, handed off via an in-context
// "verification receipt" whose freshness is a diff fingerprint. Eligibility criteria
// live once in DOCTRINE §5 (implement/review/done only cite it), so "identical
// eligibility across skills" is structural rather than something to assert per file.
describe('fast path & verification receipts (#24)', () => {
    let dir;
    let customBrakeDir;

    before(() => {
        dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '--profile', 'lean', '--backend', 'github', '-y']);

        customBrakeDir = scratchRepo('github');
        dirs.push(customBrakeDir);
        cycle(customBrakeDir, ['install', '--profile', 'lean', '--backend', 'github', '-y']);
        const cfgPath = join(customBrakeDir, '.cycle', 'config.jsonc');
        const cfg = JSON.parse(
            readFileSync(cfgPath, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
        );
        cfg.brakes = ['payments / billing'];
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        cycle(customBrakeDir, ['update']);
    });

    const doctrine = (d) => readFileSync(join(d, '.claude', 'skills', 'DOCTRINE.md'), 'utf8');
    const implement = (d) => readFileSync(join(d, '.claude', 'skills', 'implement', 'SKILL.md'), 'utf8');
    const review = (d) => readFileSync(join(d, '.claude', 'skills', 'review', 'SKILL.md'), 'utf8');
    const done = (d) => readFileSync(join(d, '.claude', 'skills', 'done', 'SKILL.md'), 'utf8');

    test('DOCTRINE defines one eligibility bar: one or two files, docs/config, deterministic, gate-provable', () => {
        const src = doctrine(dir);
        assert.match(src, /fast path/i);
        assert.match(src, /one or two files/);
        assert.match(src, /docs and\/or config/);
        assert.match(src, /deterministic/);
        assert.match(src, /§4's gates can \*\*prove\*\*/);
    });

    test('eligibility explicitly excludes every configured brake, not a hardcoded list', () => {
        const defaultSrc = doctrine(dir);
        assert.match(defaultSrc, /none\*\* of the always-brake classes above/);
        assert.match(defaultSrc, /auth \/ tokens \/ secrets/);

        const customSrc = doctrine(customBrakeDir);
        assert.match(customSrc, /none\*\* of the always-brake classes above/);
        assert.match(customSrc, /payments \/ billing/);
        assert.doesNotMatch(customSrc, /auth \/ tokens \/ secrets/);
    });

    test('/implement emits a verification receipt with issue, files, fingerprint, and per-gate PASS/FAIL', () => {
        const src = implement(dir);
        assert.match(src, /Fast path:\*\* one sentence/);
        assert.match(src, /## Verification receipt/);
        assert.match(src, /\*\*Diff fingerprint:\*\*/);
        assert.match(src, /— <PASS\/FAIL>/);
        assert.match(src, /gate that read FAIL drops the story out of the fast path/);
    });

    test('/review replaces silent docs-skip with the editorial lens, and never for code', () => {
        const src = review(dir);
        assert.doesNotMatch(src, /None — report "docs-only/);
        assert.match(src, /### Editorial lens/);
        assert.match(src, /Issue fidelity/);
        assert.match(src, /Contradictory wording/);
        assert.match(src, /References/);
        assert.match(src, /Unintended edits/);
        assert.match(src, /never "skipping review\."/);
    });

    test('/review and /done both fall back to normal verification on a stale or missing receipt', () => {
        const reviewSrc = review(dir);
        assert.match(reviewSrc, /recompute its diff fingerprint/);
        assert.match(reviewSrc, /stale fingerprint or no receipt: proceed\s+normally/);
        assert.match(reviewSrc, /stale or missing a PASS.*treat it as absent/s);

        const doneSrc = done(dir);
        assert.match(doneSrc, /recompute its diff fingerprint/);
        assert.match(doneSrc, /A stale/);
        assert.match(doneSrc, /a missing receipt, or any gate reading FAIL: run them here as usual/);
    });

    test('/done turns a dirty main tree into an issue branch, with bounded hard stops', () => {
        const src = done(dir);
        assert.match(src, /gh issue view "<n>"/);
        assert.match(src, /capture its title\s+plus milestone\/epic before choosing a branch/);
        assert.match(src, /existing epic branch applies, switch to and reuse it as `\/implement` does/);
        assert.match(src, /On `main` with a reviewed uncommitted diff that has something to ship/);
        assert.match(src, /derive `<slug>` from the issue title/);
        assert.match(src, /create\s+`fix\/<issue>-<slug>`, and continue/);
        assert.match(src, /git checkout -b fix\/<issue>-<slug>/);
        assert.match(src, /branch name\s+already exists, STOP for the\s+naming collision/);
        assert.match(src, /On `main` with no diff or nothing to ship, STOP/);
        assert.match(src, /Never stage, commit, or otherwise build on\s+`main`/);
        assert.doesNotMatch(src, /must be on a feature branch, not `main`\. If on `main`, stop/);
    });

    test('the fast path never skips gates, branch policy, or tracker status — only ceremony', () => {
        const src = doctrine(dir);
        assert.match(src, /still performs tracker status, branch policy, §4's gates, and normal delivery safety/);
        assert.match(src, /compresses \*\*ceremony and duplicate reads\*\*, never the checks themselves/);
    });
});

// #75: loadBackend/loadProfile/loadHarness interpolated a registry name straight into a
// path under CYCLE_HOME. Names come from .cycle/config.jsonc and flags, so a tampered
// config could aim that path anywhere on disk and feed the renderer an attacker-chosen
// registry whose root/skills fields direct arbitrary writes. The planted file is invalid
// JSONC with a marker: reading it AT ALL fails differently than refusing it, so the clean
// refusal message plus an absent marker is proof of containment.
describe('registry name containment (#75)', () => {
    const MARKER = 'cycle-evil-registry-marker-75';
    const evilBody = `{ "root": "${MARKER}", "skills": ["${MARKER}"],\n`;
    let evilFile;

    // The containment boundary is this checkout itself — CYCLE_HOME resolves from
    // bin/cycle.mjs's location — so the name is computed as real relative-path
    // arithmetic from each registry directory out to the planted file.
    const evilNameFor = (registry) =>
        relative(join(HERE, '..', registry), evilFile).replace(/\.jsonc$/, '');

    before(() => {
        const evilDir = mkdtempSync(join(tmpdir(), 'cycle-evil-registry-'));
        dirs.push(evilDir);
        evilFile = join(evilDir, 'pwn.jsonc');
        writeFileSync(evilFile, evilBody);
    });

    test('--backend aimed outside the backends registry refuses instead of reading it', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const r = cycleRaw(dir, ['install', '-y', '--backend', evilNameFor('backends')]);
        assert.equal(r.status, 1);
        assert.match(r.out, /is not a backend registered in this cycle home/);
        assert.ok(!r.out.includes(MARKER), 'the planted marker must never surface');
    });

    test('--profile aimed outside the profiles registry refuses instead of reading it', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        const r = cycleRaw(dir, ['install', '-y', '--profile', evilNameFor('profiles')]);
        assert.equal(r.status, 1);
        assert.match(r.out, /is not a profile registered in this cycle home/);
        assert.ok(!r.out.includes(MARKER), 'the planted marker must never surface');
    });

    test('a tampered config harnesses entry refuses instead of reading it', () => {
        const dir = scratchRepo('github');
        dirs.push(dir);
        cycle(dir, ['install', '-y', '--profile', 'lean', '--backend', 'github']);
        const cfgPath = join(dir, '.cycle', 'config.jsonc');
        const cfg = JSON.parse(
            readFileSync(cfgPath, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
        );
        cfg.harnesses = [evilNameFor('harnesses')];
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

        const r = cycleRaw(dir, ['update']);
        assert.equal(r.status, 1);
        assert.match(r.out, /is not a harness registered in this cycle home/);
        assert.ok(!r.out.includes(MARKER), 'the planted marker must never surface');
    });

    test('the planted file outside the cycle home is untouched throughout', () => {
        assert.equal(readFileSync(evilFile, 'utf8'), evilBody);
    });
});
