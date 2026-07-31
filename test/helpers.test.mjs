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
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
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

    // The dead-port tests stop at the first request, so nothing below the merge —
    // the close + label-clear path — ever executes in them. That is exactly the
    // unexecuted-path class this file exists for, so drive one green merge against a
    // mock Forgejo and watch what the guard actually does to the closed issue.
    test('a green merge closes the issue and drops only its stale status/* label', async () => {
        const requests = [];
        const routes = {
            'GET /repos/owner/repo/pulls/1': [
                200,
                { merged: false, body: 'feature', head: { sha: 'abc123', ref: 'feat' } },
            ],
            'GET /repos/owner/repo/commits/abc123/status': [
                200,
                { state: 'success', statuses: [{ context: 'ci', status: 'success' }] },
            ],
            'POST /repos/owner/repo/pulls/1/merge': [200, {}],
            'POST /repos/owner/repo/issues/5/comments': [201, {}],
            'PATCH /repos/owner/repo/issues/5': [201, {}],
            'GET /repos/owner/repo/issues/5/labels': [
                200,
                [
                    { id: 11, name: 'status/in-progress' },
                    { id: 12, name: 'bug' },
                ],
            ],
            'DELETE /repos/owner/repo/issues/5/labels/11': [204, null],
        };
        const server = createServer((req, res) => {
            const key = `${req.method} ${req.url.replace('/api/v1', '')}`;
            requests.push(key);
            const hit = routes[key];
            if (!hit) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: `unmocked: ${key}` }));
                return;
            }
            res.writeHead(hit[0], { 'Content-Type': 'application/json' });
            res.end(hit[1] === null ? '' : JSON.stringify(hit[1]));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        try {
            const { code, out } = await new Promise((resolve) => {
                const child = spawn(
                    process.execPath,
                    [join(HELPERS, 'forgejo-merge.mjs'), '1', '--closes', '5'],
                    {
                        timeout: 20_000,
                        env: {
                            ...process.env,
                            FORGEJO_API: `http://127.0.0.1:${port}/api/v1`,
                            FORGEJO_REPO: 'owner/repo',
                            FORGEJO_TOKEN: 'test-token',
                        },
                    },
                );
                let buf = '';
                child.stdout.on('data', (d) => {
                    buf += d;
                });
                child.stderr.on('data', (d) => {
                    buf += d;
                });
                child.on('close', (c) => resolve({ code: c, out: buf }));
            });
            assert.equal(code, 0, `guard should exit 0 on a clean run:\n${out}`);
            assert.match(out, /closed #5/, `issue #5 was not closed:\n${out}`);
            assert.match(
                out,
                /dropped stale label status\/in-progress/,
                `status label was not cleared:\n${out}`,
            );
            assert.ok(
                requests.includes('DELETE /repos/owner/repo/issues/5/labels/11'),
                `no DELETE for the status/* label — saw: ${requests.join(', ')}`,
            );
            assert.ok(
                !requests.some((r) => r.endsWith('/labels/12')),
                'a workflow label (bug) must survive the close — only status/* is stale',
            );
        } finally {
            server.close();
        }
    });

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
