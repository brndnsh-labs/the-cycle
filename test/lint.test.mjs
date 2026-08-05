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
    for (const part of ['templates', 'backends', 'harnesses', 'profiles', 'helpers', 'docs']) {
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

/**
 * A second backend that mirrors github but omits board_list — exactly how the
 * since-retired Forgejo backend (label routing only, no board) omitted it.
 *
 * With the-cycle down to one real backend, the verbs check's "lacking" list is always
 * empty and its guard-tracking (bin/lint.mjs:107-115) can never be exercised either
 * way — a genuine gap only a fabricated second backend can close.
 */
function addSyntheticBackend(dir) {
    const other = readFileSync(join(dir, 'backends', 'github.jsonc'), 'utf8')
        .replace(/[ \t]*"board_list":[^\n]*\n/, '\n')
        .replace('"has_board": true,', '"has_board": false,')
        .replace('"name": "github",', '"name": "other",');
    writeFileSync(join(dir, 'backends', 'other.jsonc'), other);
}

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
        edit(dir, 'backends/github.jsonc', (t) =>
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

    // /dep-update spelled `npm outdated` four times, which quietly made it the one skill
    // that couldn't be installed in a repo written in anything else.
    test('catches a package-manager command inlined into portable prose', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/dep-update.md.tmpl', (t) => `${t}\n\nRun \`cargo update\` first.\n`);
        assert.ok(checksHit(dir).has('inlining'));
    });

    // The person's name was parameterized as {{repo.human}}; the pronouns around it were
    // not, so six files silently assumed one maintainer's gender.
    test('catches a gendered pronoun', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/next.md.tmpl', (t) => `${t}\n\nAsk him what he wants next.\n`);
        assert.ok(errors(dir).some((f) => /gendered pronoun/.test(f.message)));
    });

    test('catches the contraction form a plain word-boundary grep misses', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/next.md.tmpl', (t) => `${t}\n\nGroup by how he'd check it.\n`);
        assert.ok(errors(dir).some((f) => /gendered pronoun/.test(f.message)));
    });

    // A flag no template reads is decoration that eventually lies: someone flips it
    // expecting the prose to follow, and nothing moves.
    test('catches a semantic flag no template branches on', () => {
        const dir = sandbox();
        edit(dir, 'backends/github.jsonc', (t) => t.replace('"has_board": true,', '"has_board": true,\n    "invented_flag": true,'));
        assert.ok(errors(dir).some((f) => f.check === 'semantics' && /invented_flag/.test(f.message)));
    });

    // The inverse: branching on an undeclared flag reads as falsy, so the branch never
    // fires and the skill silently loses a section.
    test('catches a template branching on a flag no backend declares', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/done.md.tmpl', (t) => `${t}\n{{#if backend.never_declared}}x{{/if}}\n`);
        assert.ok(errors(dir).some((f) => f.check === 'semantics' && /never_declared/.test(f.message)));
    });

    // A verb only one backend binds is fine inside a {{#if backend.…}} branch — that
    // is how board reads stayed guarded on the since-retired Forgejo backend, which
    // had no board. Outside one it is a render failure waiting for whichever repo
    // uses the other tracker.
    test('allows a one-backend verb inside a backend conditional', () => {
        const dir = sandbox();
        addSyntheticBackend(dir);
        // next.md.tmpl already calls {{@board_list}} inside {{#if backend.has_board}} —
        // exactly the guarded shape this check exists to allow. Left unguarded (or with
        // guard-tracking itself broken), this would false-positive on real, shipped
        // template content.
        assert.ok(!errors(dir).some((f) => /board_list/.test(f.message)));
    });

    test('catches a one-backend verb called unconditionally', () => {
        const dir = sandbox();
        addSyntheticBackend(dir);
        edit(dir, 'templates/skills/burndown.md.tmpl', (t) => `${t}\n\nRead the board: {{@board_list}}\n`);
        assert.ok(errors(dir).some((f) => f.check === 'verbs' && /board_list/.test(f.message)));
    });

    // harness.* is engine-computed, so unlike backend.semantics a typo can't be caught
    // by "declared but unused" — only by checking against the field set the engine
    // actually populates.
    test('catches a template branching on a harness field the engine never populates', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/done.md.tmpl', (t) => `${t}\n{{#if harness.has_wings}}x{{/if}}\n`);
        assert.ok(errors(dir).some((f) => f.check === 'harnesses' && /has_wings/.test(f.message)));
    });

    test('catches a harness file whose declared name does not match its filename', () => {
        const dir = sandbox();
        edit(dir, 'harnesses/codex.jsonc', (t) => t.replace('"name": "codex",', '"name": "codecks",'));
        assert.ok(errors(dir).some((f) => f.check === 'harnesses' && /codecks/.test(f.message)));
    });

    test('catches two harnesses declaring the same root', () => {
        const dir = sandbox();
        edit(dir, 'harnesses/codex.jsonc', (t) => t.replace('".agents/skills"', '".claude/skills"'));
        assert.ok(errors(dir).some((f) => f.check === 'harnesses' && /collide/.test(f.message)));
    });

    test('the shipped harnesses are consistent', () => {
        assert.ok(!errors(CYCLE_HOME).some((f) => f.check === 'harnesses'));
    });
});
