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
    for (const part of ['templates', 'backends', 'harnesses', 'profiles', 'docs']) {
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

    test('lints shared references alongside skills', () => {
        const dir = sandbox();
        edit(dir, 'templates/references/DELIVERY.md.tmpl', (t) => `${t}\n\nSee DOCTRINE §42.\n`);
        const hit = errors(dir).find((finding) => finding.where?.startsWith('references/DELIVERY.md.tmpl:'));
        assert.equal(hit?.check, 'citations');
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
    // The shim mechanism is gone with the Projects v2 board, which makes the invariant
    // absolute rather than conditional — nothing installs an executable, so a verb may
    // never name one.
    test('catches a verb calling a scripts/ executable that nothing installs', () => {
        const dir = sandbox();
        edit(dir, 'backends/github.jsonc', (t) =>
            t.replace('"issue_close":', '"issue_teleport": "node scripts/nowhere.mjs $1",\n    "issue_close":'));
        const hits = errors(dir).filter((f) => /scripts\/nowhere\.mjs|scripts\/ executable/.test(f.message));
        assert.equal(hits.length, 1, 'expected exactly one finding for the uninstallable script');
        assert.match(hits[0].message, /issue_teleport/);
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

    // Template prose ships to every consuming repo, so a dialect slip propagates and is
    // only caught downstream, if at all — cspell failed on `behaviour` while passing
    // `labelled` four times in the same commit.
    test('catches a British spelling in a template', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/next.md.tmpl', (t) => `${t}\n\nCheck the observed behaviour.\n`);
        assert.ok(errors(dir).some((f) => f.check === 'dialect' && /behaviour/.test(f.message)));
    });

    test('checks the docs corpus too, not just templates', () => {
        const dir = sandbox();
        edit(dir, 'docs/BACKENDS.md', (t) => `${t}\n\nThe organisation owns the board.\n`);
        assert.ok(errors(dir).some((f) => f.check === 'dialect' && /organisation/.test(f.message)));
    });

    // The reason this is a fixed word list and not an `-ise`/`-our` pattern. A check that
    // fires on ordinary words gets switched off, and then it protects nothing.
    test('does not fire on US words that merely look British', () => {
        const dir = sandbox();
        const decoys = 'A precise, concise promise: otherwise we exercise four of the premises. '
            + 'The emphasis of the analysis surprised us — enterprise merchandise, likewise.';
        edit(dir, 'templates/skills/next.md.tmpl', (t) => `${t}\n\n${decoys}\n`);
        const hits = errors(dir).filter((f) => f.check === 'dialect');
        assert.deepEqual(hits, [], `false positives: ${hits.map((h) => h.message).join('; ')}`);
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
        edit(dir, 'backends/github.jsonc', (t) => t.replace('"auto_merge": false', '"auto_merge": false,\n    "invented_flag": true'));
        assert.ok(errors(dir).some((f) => f.check === 'semantics' && /invented_flag/.test(f.message)));
    });

    // The inverse: branching on an undeclared flag reads as falsy, so the branch never
    // fires and the skill silently loses a section.
    test('catches a template branching on a flag no backend declares', () => {
        const dir = sandbox();
        edit(dir, 'templates/skills/done.md.tmpl', (t) => `${t}\n{{#if backend.never_declared}}x{{/if}}\n`);
        assert.ok(errors(dir).some((f) => f.check === 'semantics' && /never_declared/.test(f.message)));
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
