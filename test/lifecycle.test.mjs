// Lifecycle of managed files: conditional profile entries, orphan removal on update,
// and orphan overlay files.
//
// Everything runs against a synthetic CYCLE_HOME (a copy of bin/ plus tiny templates,
// profiles, backends and harnesses written here), so these tests say nothing about the
// real pipeline's contents and survive its rewrites.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lint } from '../bin/lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const put = (base, rel, text) => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text);
};

const SKILL = (name) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\n{{> overlay?:note}}\n`;

/** A fresh CYCLE_HOME with its own tiny registries. `skills` is the profile's array. */
function makeHome(skills, { extraSkills = [] } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'cycle-lifecycle-home-'));
    dirs.push(home);
    cpSync(join(HERE, '..', 'bin'), join(home, 'bin'), { recursive: true });
    cpSync(join(HERE, '..', 'package.json'), join(home, 'package.json'));
    put(home, 'backends/b.jsonc', JSON.stringify({ name: 'b', verbs: {} }));
    put(home, 'harnesses/h.jsonc', JSON.stringify({ name: 'h', display: 'H', root: '.h/skills', skill_file: 'SKILL.md' }));
    put(home, 'profiles/p.jsonc', JSON.stringify({ skills }));
    put(home, 'templates/DOCTRINE.md.tmpl', '# Doctrine\n\n## §1 One\n');
    for (const s of ['alpha', 'beta', 'gamma', ...extraSkills]) put(home, `templates/skills/${s}.md.tmpl`, SKILL(s));
    put(home, 'templates/overlays.jsonc', JSON.stringify({
        note: { into: 'alpha', purpose: 'p', shape: 's', value: 'v' },
        unused: { into: 'nothing', purpose: 'p', shape: 's', value: 'v' },
    }));
    return home;
}

function makeRepo(config = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-lifecycle-repo-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    put(dir, '.cycle/config.jsonc', JSON.stringify({
        profile: 'p', backend: 'b', harnesses: ['h'], ...config,
    }));
    return dir;
}

const run = (home, cwd, args) => {
    const r = spawnSync(process.execPath, [join(home, 'bin', 'cycle.mjs'), ...args], {
        cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};

const skillPath = (repo, name) => join(repo, '.h', 'skills', name, 'SKILL.md');
const state = (repo) => JSON.parse(readFileSync(join(repo, '.cycle', 'state.json'), 'utf8'));

describe('conditional profile entries', () => {
    let home;
    before(() => {
        home = makeHome(['alpha', { skill: 'beta', when: 'deploy.test' }, { skill: 'gamma', when: '!deploy.test' }]);
    });

    test('rendered when the path is truthy, and the negated entry is not', () => {
        const repo = makeRepo({ deploy: { test: 'make deploy' } });
        assert.equal(run(home, repo, ['update']).code, 0);
        assert.ok(existsSync(skillPath(repo, 'alpha')));
        assert.ok(existsSync(skillPath(repo, 'beta')));
        assert.ok(!existsSync(skillPath(repo, 'gamma')));
    });

    test('not rendered when the path is falsy or absent, and the negated entry is', () => {
        for (const cfg of [{ deploy: { test: '' } }, {}]) {
            const repo = makeRepo(cfg);
            assert.equal(run(home, repo, ['update']).code, 0);
            assert.ok(existsSync(skillPath(repo, 'alpha')));
            assert.ok(!existsSync(skillPath(repo, 'beta')));
            assert.ok(existsSync(skillPath(repo, 'gamma')));
        }
    });

    test('flipping the condition off orphans the skill and update removes it', () => {
        const repo = makeRepo({ deploy: { test: 'x' } });
        run(home, repo, ['update']);
        writeFileSync(join(repo, '.cycle', 'config.jsonc'), JSON.stringify({ profile: 'p', backend: 'b', harnesses: ['h'] }));
        const r = run(home, repo, ['update']);
        assert.equal(r.code, 0);
        assert.ok(!existsSync(skillPath(repo, 'beta')));
    });

    for (const [label, entry, message] of [
        ['an unknown key', { skill: 'beta', when: 'a.b', wen: 'x' }, /unknown key/],
        ['a missing when', { skill: 'beta' }, /"when"/],
        ['a non-string skill', { skill: 3, when: 'a' }, /"skill"/],
        ['a bad path', { skill: 'beta', when: 'a b' }, /"when"/],
        ['a non-object entry', 7, /skill name or/],
    ]) {
        test(`a malformed entry fails loudly: ${label}`, () => {
            const bad = makeHome(['alpha', entry]);
            const repo = makeRepo();
            const r = run(bad, repo, ['update']);
            assert.equal(r.code, 1);
            assert.match(r.err, message);
        });
    }

    test('lint accepts conditional entries and counts them as installed', () => {
        const findings = lint({ CYCLE_HOME: home });
        const profileFindings = findings.filter((f) => f.check === 'profiles' || f.check === 'cross-refs');
        assert.deepEqual(profileFindings, []);
    });

    test('lint reports a malformed entry as a profiles error', () => {
        const bad = makeHome(['alpha', { skill: 'beta', when: 'a', oops: 1 }]);
        const errs = lint({ CYCLE_HOME: bad }).filter((f) => f.check === 'profiles' && f.severity === 'error');
        assert.equal(errs.length, 1);
        assert.match(errs[0].message, /unknown key/);
    });

    test('lint still flags a conditional entry with no template', () => {
        const bad = makeHome(['alpha', { skill: 'ghost', when: 'a' }]);
        const errs = lint({ CYCLE_HOME: bad }).filter((f) => f.check === 'profiles' && f.severity === 'error');
        assert.ok(errs.some((f) => /"ghost", which has no template/.test(f.message)));
    });
});

describe('orphaned managed files', () => {
    /** A repo rendered with alpha+beta, then moved to a profile with only alpha. */
    function orphaned() {
        const home = makeHome(['alpha', 'beta']);
        const repo = makeRepo();
        assert.equal(run(home, repo, ['update']).code, 0);
        assert.ok(existsSync(skillPath(repo, 'beta')));
        put(home, 'profiles/p.jsonc', JSON.stringify({ skills: ['alpha'] }));
        return { home, repo };
    }

    test('update removes an unedited orphan and its now-empty directory, and prunes state', () => {
        const { home, repo } = orphaned();
        const r = run(home, repo, ['update']);
        assert.equal(r.code, 0, r.all);
        assert.match(r.out, /removed .*beta[/\\]SKILL\.md/);
        assert.ok(!existsSync(skillPath(repo, 'beta')));
        assert.ok(!existsSync(dirname(skillPath(repo, 'beta'))));
        assert.ok(existsSync(skillPath(repo, 'alpha')));
        assert.deepEqual(
            Object.keys(state(repo).files).sort(),
            ['.h/skills/DOCTRINE.md', '.h/skills/alpha/SKILL.md'],
        );
        // and it converges
        assert.match(run(home, repo, ['update']).out, /already up to date/);
        assert.equal(run(home, repo, ['check']).code, 0);
    });

    test('update leaves a directory that still holds other files', () => {
        const { home, repo } = orphaned();
        writeFileSync(join(dirname(skillPath(repo, 'beta')), 'notes.txt'), 'mine');
        assert.equal(run(home, repo, ['update']).code, 0);
        assert.ok(!existsSync(skillPath(repo, 'beta')));
        assert.ok(existsSync(join(dirname(skillPath(repo, 'beta')), 'notes.txt')));
    });

    test('an orphan already gone from disk is just dropped from state', () => {
        const { home, repo } = orphaned();
        rmSync(dirname(skillPath(repo, 'beta')), { recursive: true });
        const r = run(home, repo, ['update']);
        assert.equal(r.code, 0, r.all);
        assert.ok(!('.h/skills/beta/SKILL.md' in state(repo).files));
    });

    test('update refuses an edited orphan without --force, and keeps tracking it', () => {
        const { home, repo } = orphaned();
        writeFileSync(skillPath(repo, 'beta'), `${readFileSync(skillPath(repo, 'beta'), 'utf8')}\nmy edit\n`);
        const r = run(home, repo, ['update']);
        assert.equal(r.code, 1);
        assert.match(r.out, /refusing/);
        assert.match(r.out, /beta[/\\]SKILL\.md/);
        assert.ok(existsSync(skillPath(repo, 'beta')));
        assert.ok('.h/skills/beta/SKILL.md' in state(repo).files);
        assert.equal(run(home, repo, ['check']).code, 1);
    });

    // --force overwrites drifted files; it must not also silently delete hand-edited orphans,
    // whose content no template holds.
    test('update --force alone does not delete an edited orphan', () => {
        const { home, repo } = orphaned();
        writeFileSync(skillPath(repo, 'beta'), `${readFileSync(skillPath(repo, 'beta'), 'utf8')}\nmy edit\n`);
        const r = run(home, repo, ['update', '--force']);
        assert.equal(r.code, 1);
        assert.match(r.out, /--prune-edited/);
        assert.ok(existsSync(skillPath(repo, 'beta')));
    });

    test('update --prune-edited removes an edited orphan', () => {
        const { home, repo } = orphaned();
        writeFileSync(skillPath(repo, 'beta'), `${readFileSync(skillPath(repo, 'beta'), 'utf8')}\nmy edit\n`);
        const r = run(home, repo, ['update', '--prune-edited']);
        assert.equal(r.code, 0, r.all);
        assert.ok(!existsSync(dirname(skillPath(repo, 'beta'))));
        assert.ok(!('.h/skills/beta/SKILL.md' in state(repo).files));
    });

    test('an orphan with no provenance header is treated as edited', () => {
        const { home, repo } = orphaned();
        writeFileSync(skillPath(repo, 'beta'), '# hand written\n');
        assert.equal(run(home, repo, ['update']).code, 1);
        assert.ok(existsSync(skillPath(repo, 'beta')));
    });

    test('--dry-run says what would be removed and changes nothing', () => {
        const { home, repo } = orphaned();
        const before = readFileSync(join(repo, '.cycle', 'state.json'), 'utf8');
        const r = run(home, repo, ['update', '--dry-run']);
        // Same exit semantics as pending writes in a dry run: pending work alone is not an error.
        assert.equal(r.code, 0, r.all);
        assert.match(r.out, /would remove .*beta[/\\]SKILL\.md/);
        assert.ok(existsSync(skillPath(repo, 'beta')));
        assert.equal(readFileSync(join(repo, '.cycle', 'state.json'), 'utf8'), before);
    });

    test('check reports an orphan as non-clean', () => {
        const { home, repo } = orphaned();
        const r = run(home, repo, ['check']);
        assert.equal(r.code, 1);
        assert.match(r.out, /stale/);
        assert.match(r.out, /beta[/\\]SKILL\.md/);
        assert.doesNotMatch(r.out, /✓ clean/);
    });

    test('a state entry outside the harness roots is never deleted', () => {
        const { home, repo } = orphaned();
        writeFileSync(join(repo, 'precious.md'), 'keep me');
        const s = state(repo);
        s.files['precious.md'] = 'deadbeef';
        s.files['../outside.md'] = 'deadbeef';
        writeFileSync(join(repo, '.cycle', 'state.json'), JSON.stringify(s));
        assert.equal(run(home, repo, ['update', '--force']).code, 0);
        assert.equal(readFileSync(join(repo, 'precious.md'), 'utf8'), 'keep me');
        assert.ok(!('precious.md' in state(repo).files));
    });

    test('a directory recorded in state is dropped from state, never deleted or crashed on', () => {
        const { home, repo } = orphaned();
        mkdirSync(join(repo, '.h', 'skills', 'userdir'), { recursive: true });
        writeFileSync(join(repo, '.h', 'skills', 'userdir', 'mine.md'), 'mine');
        const s = state(repo);
        s.files['.h/skills/userdir'] = 'deadbeef';
        writeFileSync(join(repo, '.cycle', 'state.json'), JSON.stringify(s));
        for (const args of [['update'], ['update', '--prune-edited']]) {
            const r = run(home, repo, args);
            assert.doesNotMatch(r.all, /EISDIR|at .*cycle\.mjs/);
        }
        assert.equal(readFileSync(join(repo, '.h', 'skills', 'userdir', 'mine.md'), 'utf8'), 'mine');
        assert.ok(!('.h/skills/userdir' in state(repo).files));
    });

    test('an orphan reached through a symlink escaping the repo is refused, not deleted', () => {
        const { home, repo } = orphaned();
        const outside = mkdtempSync(join(tmpdir(), 'cycle-lifecycle-outside-'));
        dirs.push(outside);
        writeFileSync(join(outside, 'SKILL.md'), 'outside');
        rmSync(dirname(skillPath(repo, 'beta')), { recursive: true });
        execFileSync('ln', ['-s', outside, dirname(skillPath(repo, 'beta'))]);
        const r = run(home, repo, ['update', '--prune-edited']);
        assert.equal(r.code, 1);
        assert.match(r.err, /symlink/);
        assert.equal(readFileSync(join(outside, 'SKILL.md'), 'utf8'), 'outside');
    });
});

describe('orphan overlay files', () => {
    const home = () => makeHome(['alpha']);

    test('an overlay with no registered injection point fails the render with an actionable message', () => {
        const repo = makeRepo();
        put(repo, '.cycle/overlays/ghost-point.md', 'repo specific words');
        for (const cmd of [['update'], ['check'], ['render']]) {
            const r = run(home(), repo, cmd);
            assert.equal(r.code, 1, cmd.join(' '));
            assert.match(r.err, /\.cycle[/\\]overlays[/\\]ghost-point\.md/);
            assert.match(r.err, /silently dropped/);
            assert.match(r.err, /move its content/);
        }
    });

    test('a registered overlay that no skill in this profile uses does not fail', () => {
        const repo = makeRepo();
        put(repo, '.cycle/overlays/unused.md', 'registered, just not injected by this profile');
        const r = run(home(), repo, ['update']);
        assert.equal(r.code, 0, r.all);
    });

    test('a registered, used overlay is injected', () => {
        const repo = makeRepo();
        put(repo, '.cycle/overlays/note.md', 'hello overlay');
        assert.equal(run(home(), repo, ['update']).code, 0);
        assert.match(readFileSync(skillPath(repo, 'alpha'), 'utf8'), /hello overlay/);
    });

    test('non-markdown files in the overlays directory are ignored', () => {
        const repo = makeRepo();
        put(repo, '.cycle/overlays/notes.txt', 'scratch');
        put(repo, '.cycle/overlays/.gitkeep', '');
        assert.equal(run(home(), repo, ['update']).code, 0);
    });
});

describe('state.json formatting', () => {
    const statePath = (repo) => join(repo, '.cycle', 'state.json');

    test('a fresh state.json uses two-space indentation', () => {
        const home = makeHome(['alpha']);
        const repo = makeRepo();
        assert.equal(run(home, repo, ['update']).code, 0);
        assert.match(readFileSync(statePath(repo), 'utf8'), /^\{\n  "upstream"/);
    });

    test('update keeps the indentation an existing state.json already has', () => {
        const home = makeHome(['alpha']);
        for (const [indent, firstKey] of [['\t', /^\{\n\t"upstream"/], [4, /^\{\n {4}"upstream"/]]) {
            const repo = makeRepo();
            run(home, repo, ['update']);
            writeFileSync(statePath(repo), `${JSON.stringify(state(repo), null, indent)}\n`);
            rmSync(skillPath(repo, 'alpha')); // forces a real re-render, so state is rewritten
            assert.equal(run(home, repo, ['update']).code, 0);
            assert.ok(existsSync(skillPath(repo, 'alpha')));
            assert.match(readFileSync(statePath(repo), 'utf8'), firstKey);
        }
    });
});
