// The helpers are the one layer the render suite never executes. It checks that a
// skill *calls* a tracker command, and lint checks that a shim installs it — but
// neither one actually runs the file.
//
// That gap shipped a real bug, in the since-retired Forgejo helper: it read a
// token-file env var in one function and never declared it, so every status write
// died with a ReferenceError the moment the token wasn't already exported. It
// rendered fine, linted fine, and broke on the first /implement in a live repo.
//
// So: every shipped helper must be invoked for real somewhere, or explicitly
// exempted with a reason a new helper can't quietly slip past. Today's sole helper,
// gh-project.mjs, is invoked twice:
//   - here, on a real command path (`status`), with `gh` stubbed on PATH so the run
//     is hermetic — this is the crash-path coverage the file exists for, and the
//     shape of run that would have caught the Forgejo bug.
//   - in test/render.test.mjs's rendered-shim tests, but only with zero arguments,
//     which only proves the shim resolved *a* helper file, not that the helper's
//     command logic runs without crashing. Those tests also spawn gh-project.mjs
//     against a *stub* copy (CYCLE_HOME pointed at a scratch dir), so the real
//     helper under helpers/ is never reached there at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPERS = join(HERE, '..', 'helpers');

describe('helpers', () => {
    // The bug was one missing const in one helper, in a file nothing else here still
    // ships. Pin the whole set rather than name names, so a NEW helper that ships
    // with nothing ever executing it fails this test instead of slipping through.
    test('every shipped helper is covered by an invocation, or explicitly exempted', () => {
        const shipped = readdirSync(HELPERS).filter((f) => f.endsWith('.mjs')).sort();
        // Every helper this suite actually spawns on a real command path (see below).
        const covered = ['gh-project.mjs'];
        const exempt = [];
        assert.deepEqual(
            shipped.filter((f) => !covered.includes(f) && !exempt.includes(f)),
            [],
            'a helper ships with nothing ever executing it — add an invocation, or exempt it with a reason',
        );
    });

    // A hermetic `gh`, stubbed on PATH, that answers exactly the subcommands a
    // `status` write touches: the project id lookup, the item list (to find or add
    // the board item), the field list (to resolve the Status option), and the edit
    // itself. Anything else is a test bug, not a thing to paper over — it exits
    // non-zero with the unhandled args so a gap here fails loudly.
    function stubGh(dir) {
        const bin = join(dir, 'gh');
        writeFileSync(
            bin,
            `#!/usr/bin/env node
const a = process.argv.slice(2);
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
if (a[0] === 'project' && a[1] === 'view') out({ id: 'PROJECT_ID' });
else if (a[0] === 'project' && a[1] === 'item-list') out({ items: [{ id: 'ITEM_1', content: { type: 'Issue', number: 1 } }] });
else if (a[0] === 'project' && a[1] === 'field-list') out({ fields: [{ id: 'FIELD_STATUS', name: 'Status', options: [{ id: 'OPT_READY', name: 'Ready' }] }] });
else if (a[0] === 'project' && a[1] === 'item-edit') { process.exit(0); }
else { console.error('unstubbed gh invocation: ' + a.join(' ')); process.exit(1); }
`,
        );
        chmodSync(bin, 0o755);
        return bin;
    }

    // The bug class this guards against surfaces only once a command actually runs
    // its logic — a variable read in one function and never declared anywhere fails
    // with a ReferenceError the first time that function executes, not at parse
    // time and not on `--help`/no-args. `status` is the write every /implement and
    // /done issues, so it is the command path most worth covering for real.
    test('gh-project.mjs status <issue> <value> runs its real command path without crashing', () => {
        const stubDir = mkdtempSync(join(tmpdir(), 'cycle-gh-stub-'));
        try {
            stubGh(stubDir);
            const r = spawnSync(
                process.execPath,
                [join(HELPERS, 'gh-project.mjs'), 'status', '1', 'Ready'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        PATH: `${stubDir}${delimiter}${process.env.PATH}`,
                        GH_OWNER: 'test-owner',
                        GH_PROJECT: '1',
                        GH_REPO: 'test-owner/demo',
                    },
                },
            );
            const output = `${r.stdout}${r.stderr}`;
            assert.doesNotMatch(output, /ReferenceError|TypeError/, `crashed: ${output}`);
            assert.equal(r.status, 0, `expected a clean exit, got:\n${output}`);
            assert.match(output, /#1: Status → Ready/);
        } finally {
            rmSync(stubDir, { recursive: true, force: true });
        }
    });
});
