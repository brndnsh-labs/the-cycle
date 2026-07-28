// The helpers are the one layer the render suite never executes. It checks that a
// skill *calls* `node scripts/forgejo-project.mjs status …`, and lint checks that a
// shim installs it — but nothing until now actually ran the file.
//
// That gap shipped a real bug: forgejo-project.mjs read TOKEN_FILE in token() and
// never declared it, so every set_status died with a ReferenceError the moment
// FORGEJO_TOKEN wasn't already exported. It renders fine, lints fine, and breaks on
// the first /implement in a live repo.
//
// So: run each helper for real, against an API that cannot answer, and demand the
// failure be the *deliberate* kind. A helper is allowed to fail here — it is not
// allowed to fail because an identifier doesn't exist.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPERS = join(HERE, '..', 'helpers');

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A token file, so auth resolution runs its file path rather than short-circuiting. */
function tokenFile() {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-helper-'));
    dirs.push(dir);
    const p = join(dir, 'token');
    writeFileSync(p, 'not-a-real-token\n');
    return p;
}

/**
 * Port 1 is reserved and never listening, so every helper gets a connection refused
 * and takes its own error path. Repo and API are passed explicitly so nothing depends
 * on the cwd's git remote.
 */
function run(file, args) {
    return spawnSync(process.execPath, [join(HELPERS, file), ...args], {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
            ...process.env,
            FORGEJO_API: 'http://127.0.0.1:1/api/v1',
            FORGEJO_REPO: 'owner/repo',
            FORGEJO_TOKEN_FILE: tokenFile(),
            FORGEJO_TOKEN: '',
        },
    });
}

// A crash of this class means an identifier, import or property doesn't exist — the
// program is wrong, not the environment.
const CRASH = /ReferenceError|TypeError|SyntaxError|is not defined|is not a function/;

const INVOCATIONS = [
    ['forgejo.mjs', ['issue', 'view', '1']],
    ['forgejo-project.mjs', ['status', '1', 'ready']],
    ['forgejo-project.mjs', ['clear', '1', 'Status']],
    ['forgejo-merge.mjs', ['1']],
];

describe('helpers', () => {
    for (const [file, args] of INVOCATIONS) {
        test(`${file} ${args.join(' ')} fails deliberately, not by crashing`, () => {
            const { stdout, stderr, status } = run(file, args);
            const out = `${stdout}${stderr}`;
            assert.doesNotMatch(out, CRASH, `${file} crashed instead of failing cleanly:\n${out}`);
            assert.notEqual(status, 0, `${file} should not succeed against a dead API`);
            // A deliberate failure says something. A silent non-zero exit is its own bug:
            // the pipeline would report "done" with nothing having happened.
            assert.ok(out.trim().length > 0, `${file} exited ${status} with no message`);
        });
    }

    // The bug was one missing const in one helper. The others were fine by luck, so
    // pin the whole set rather than the one file that broke.
    test('every helper is covered by an invocation above', () => {
        const shipped = readdirSync(HELPERS).filter((f) => f.endsWith('.mjs')).sort();
        const covered = [...new Set(INVOCATIONS.map(([f]) => f))];
        // gh-project.mjs shells out to `gh` and needs no Forgejo env; it is exercised
        // by the github render tests instead. Name it explicitly so adding a NEW
        // helper still fails this test rather than slipping through.
        const exempt = ['gh-project.mjs'];
        assert.deepEqual(
            shipped.filter((f) => !covered.includes(f) && !exempt.includes(f)),
            [],
            'a helper ships with nothing ever executing it — add an invocation',
        );
    });
});
