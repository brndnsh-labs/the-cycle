// Consistency of the-cycle itself — the checks the render suite structurally cannot
// make, because a stale §N citation or a shim nobody installs renders perfectly.
//
// Half of these tests break the tree on purpose. A lint that only ever reports clean
// is indistinguishable from a lint that does nothing, and the render suite already
// tells us the happy path works.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lint } from '../bin/lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CYCLE_HOME = join(HERE, '..');

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A throwaway copy of everything lint reads, so a test can break one thing safely. */
function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-lint-'));
    dirs.push(dir);
    for (const part of ['templates', 'backends', 'profiles', 'helpers', 'docs']) {
        cpSync(join(CYCLE_HOME, part), join(dir, part), { recursive: true });
    }
    return dir;
}

const edit = (dir, rel, fn) => {
    const p = join(dir, rel);
    writeFileSync(p, fn(readFileSync(p, 'utf8')));
};

const errors = (dir) => lint({ CYCLE_HOME: dir }).filter((f) => f.severity === 'error');
const checksHit = (dir) => new Set(errors(dir).map((f) => f.check));

describe('lint', () => {
    test('the tree is consistent', () => {
        const findings = lint({ CYCLE_HOME });
        const errs = findings.filter((f) => f.severity === 'error');
        assert.deepEqual(
            errs.map((f) => `${f.check}: ${f.message} (${f.where})`),
            [],
        );
        // Warnings are allowed to exist, but a clean tree should have none — they are
        // the things worth looking at, so a permanent warning trains you to ignore them.
        assert.deepEqual(
            findings.filter((f) => f.severity === 'warn').map((f) => `${f.check}: ${f.message} (${f.where})`),
            [],
        );
    });

    test('catches a citation with no matching DOCTRINE section', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/patch.md.tmpl', (t) => `${t}\n\nSee DOCTRINE §42.\n`);
        assert.ok(checksHit(dir).has('citations'));
    });

    test('catches a renumbered DOCTRINE section that skills still cite', () => {
        const dir = sandbox();
        edit(dir, 'templates/DOCTRINE.md.tmpl', (t) => t.replace('## §5 ', '## §55 '));
        assert.ok(checksHit(dir).has('citations'), 'renumbering a section must break its citations');
    });

    test('catches a verb no backend binds', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/done.md.tmpl', (t) => `${t}\n{{@issue_teleport "1"}}\n`);
        assert.ok(checksHit(dir).has('verbs'));
    });

    // The exact bug this file was written after: verbs referenced a helper script that
    // no shim installed, so every rendered skill called a file the repo didn't have.
    test('catches a verb calling a script no shim installs', () => {
        const dir = sandbox();
        edit(dir, 'backends/forgejo.jsonc', (t) =>
            t.replace('"issue_close":', '"issue_teleport": "node scripts/nowhere.mjs $1",\n    "issue_close":'));
        // Referenced by a verb, declared by no shim → error regardless of who calls it.
        const hits = errors(dir).filter((f) => f.check === 'shims');
        assert.equal(hits.length, 1, 'expected exactly one shim finding');
        assert.match(hits[0].message, /scripts\/nowhere\.mjs/);
    });

    test('catches a shim pointing at a helper that does not exist', () => {
        const dir = sandbox();
        edit(dir, 'backends/github.jsonc', (t) => t.replace('"helper": "gh-project.mjs"', '"helper": "ghost.mjs"'));
        assert.ok(errors(dir).some((f) => f.check === 'shims' && /ghost\.mjs/.test(f.message)));
    });

    test('catches a profile listing a skill with no template', () => {
        const dir = sandbox();
        edit(dir, 'profiles/lean.jsonc', (t) => t.replace('"cycle",', '"cycle",\n    "imaginary",'));
        assert.ok(checksHit(dir).has('profiles'));
    });

    // The original sin, and the reason all three source repos drifted: every skill
    // restated `npm run typecheck`, so changing it meant editing every skill.
    test('catches a gate command inlined into portable prose', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/implement.md.tmpl', (t) => `${t}\n\nRun \`npm run typecheck\` before you stop.\n`);
        assert.ok(checksHit(dir).has('inlining'));
    });

    test('catches a tracker command inlined into portable prose', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/next.md.tmpl', (t) => `${t}\n\nRun \`gh issue list --state open\`.\n`);
        assert.ok(checksHit(dir).has('inlining'));
    });

    // A verb only one backend binds is fine inside a {{#if backend.…}} branch — that
    // is how board reads work on Forgejo, which has no board. Outside one it is a
    // render failure waiting for whichever repo uses the other tracker.
    test('allows a one-backend verb inside a backend conditional', () => {
        assert.ok(!errors(CYCLE_HOME).some((f) => /board_list/.test(f.message)));
    });

    test('catches a one-backend verb called unconditionally', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/burndown.md.tmpl', (t) => `${t}\n\nRead the board: {{@board_list}}\n`);
        assert.ok(errors(dir).some((f) => f.check === 'verbs' && /board_list/.test(f.message)));
    });
});
