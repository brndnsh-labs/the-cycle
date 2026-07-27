// Tests for the render engine. Run: node --test test/
//
// These cover the parts where a silent bug would be expensive: a template that
// renders an empty string instead of failing, a provenance hash that doesn't
// round-trip (drift detection stops working), or a `${{ }}` GitHub Actions
// expression getting eaten.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    hashContent,
    lineDiff,
    readProvenance,
    renderTemplate,
    stampProvenance,
    stripJsonComments,
    stripProvenance,
} from '../bin/cycle.mjs';

const ctx = {
    repo: { name: 'Mend', human: 'Brandon' },
    gates: { typecheck: 'npm run typecheck', test: 'npm test' },
    brakes: ['auth / tokens', 'schema migration'],
    tracker: { project: 4, owner: 'brndnsh' },
    backend: { name: 'github', has_board: true },
    empty: [],
};

const verbs = {
    issue_view: 'gh issue view $1 --json body',
    board_list: 'gh project item-list {{tracker.project}} --owner {{tracker.owner}} --format json',
};

const R = (s, o = {}) => renderTemplate(s, ctx, { verbs, ...o });

describe('JSONC', () => {
    test('strips line and block comments', () => {
        assert.equal(stripJsonComments('{"a":1} // hi'), '{"a":1} ');
        assert.equal(stripJsonComments('{/* x */"a":1}'), '{"a":1}');
    });

    test('leaves // inside strings alone', () => {
        assert.equal(stripJsonComments('{"u":"https://x.com/y"}'), '{"u":"https://x.com/y"}');
        assert.equal(stripJsonComments('{"a":"x\\"//y"}'), '{"a":"x\\"//y"}');
    });

    test('drops trailing commas', () => {
        assert.equal(stripJsonComments('{"a":1,}'), '{"a":1}');
    });
});

describe('scalars', () => {
    test('resolves dotted paths', () => {
        assert.equal(R('Hi {{repo.human}}'), 'Hi Brandon');
        assert.equal(R('{{gates.typecheck}}'), 'npm run typecheck');
        assert.equal(R('#{{tracker.project}}'), '#4');
    });

    test('joins arrays, honouring a separator that ends in a space', () => {
        assert.equal(R('{{brakes}}'), 'auth / tokens, schema migration');
        assert.equal(R('{{brakes|join: · }}'), 'auth / tokens · schema migration');
    });

    // The whole point of the config indirection is that a missing binding is loud.
    // A skill rendered with a hole in it would be worse than no skill at all.
    test('an unresolved path is fatal, never empty', () => {
        assert.throws(() => R('{{nope.missing}}'), /unresolved/);
    });
});

describe('GitHub Actions passthrough', () => {
    test('${{ }} survives untouched', () => {
        assert.equal(R('run: ${{ matrix.node }}'), 'run: ${{ matrix.node }}');
        assert.equal(R('${{ github.sha }} for {{repo.name}}'), '${{ github.sha }} for Mend');
    });
});

describe('blocks', () => {
    test('if / unless', () => {
        assert.equal(R('{{#if backend.has_board}}board{{/if}}'), 'board');
        assert.equal(R('{{#if empty}}x{{/if}}'), '');
        assert.equal(R('{{#unless empty}}none{{/unless}}'), 'none');
    });

    test('nesting and siblings resolve to the right closer', () => {
        assert.equal(R('{{#if backend.has_board}}a{{#if repo.name}}b{{/if}}{{/if}}'), 'ab');
        assert.equal(R('{{#if empty}}x{{/if}}{{#if repo.name}}y{{/if}}'), 'y');
    });

    test('each binds {{.}} and keeps the outer scope', () => {
        assert.equal(R('{{#each brakes}}- {{.}}\n{{/each}}'), '- auth / tokens\n- schema migration\n');
        assert.equal(R('{{#each empty}}x{{/each}}'), '');
        assert.equal(R('{{#each brakes}}{{repo.name}}:{{.}} {{/each}}'), 'Mend:auth / tokens Mend:schema migration ');
    });

    test('an unclosed block is fatal', () => {
        assert.throws(() => R('{{#if repo.name}}x'), /missing \{\{\/if\}\}/);
    });
});

describe('backend verbs', () => {
    // Quotes survive: a rendered command is meant to be readable and pasteable,
    // and `--title <title>` would be wrong shell if anyone copied it.
    test('substitutes positional args, keeping their quotes', () => {
        assert.equal(R('{{@issue_view "<n>"}}'), 'gh issue view "<n>" --json body');
        assert.equal(R('{{@issue_view 12}}'), 'gh issue view 12 --json body');
    });

    test('expands config inside the verb string itself', () => {
        assert.equal(R('{{@board_list}}'), 'gh project item-list 4 --owner brndnsh --format json');
    });

    test('an unknown verb is fatal and lists what exists', () => {
        assert.throws(() => R('{{@nope}}'), /unknown backend verb/);
    });

    // Status names differ per backend (Todo vs ready), so call sites pass them from
    // config. That nests a tag inside a tag — the parser must not close on the inner one.
    test('an argument may itself be a lookup', () => {
        assert.equal(
            renderTemplate('{{@issue_view "{{tracker.owner}}"}}', ctx, { verbs }),
            'gh issue view "brndnsh" --json body',
        );
    });
});

describe('overlays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-ov-'));
    writeFileSync(join(dir, 'routing.md'), '| path | reviewer |\n| {{repo.name}} | x |');

    test('injects and renders the overlay', () => {
        assert.equal(R('A\n{{> overlay:routing}}\nB', { overlays: dir }), 'A\n| path | reviewer |\n| Mend | x |\nB');
    });

    test('a missing overlay fails loudly rather than leaving a hole', () => {
        assert.throws(() => R('{{> overlay:nope}}', { overlays: dir }), /needs overlay/);
    });

    test('an optional overlay renders nothing when absent, and leaves no gap', () => {
        assert.equal(R('A\n{{> overlay?:nope}}\nB', { overlays: dir }), 'A\nB');
        assert.equal(R('A\n{{> overlay?:routing}}\nB', { overlays: dir }), 'A\n| path | reviewer |\n| Mend | x |\nB');
    });
});

// Without this, every {{#if}} that renders nothing leaves a blank line, so a
// skill's shape would depend on which optional sections happened to apply — and
// two repos with the same config would produce differently-spaced files.
describe('standalone tag lines', () => {
    test('a block tag alone on its line contributes no line', () => {
        assert.equal(R('a\n{{#if empty}}\nx\n{{/if}}\nb'), 'a\nb');
        assert.equal(R('a\n{{#if repo.name}}\nx\n{{/if}}\nb'), 'a\nx\nb');
    });

    test('an inline block tag keeps its line', () => {
        assert.equal(R('a {{#if repo.name}}yes{{/if}} b'), 'a yes b');
        assert.equal(R('a {{#if empty}}yes{{/if}} b'), 'a  b');
    });

    test('each over a standalone block emits one line per item', () => {
        assert.equal(R('{{#each brakes}}\n- {{.}}\n{{/each}}'), '- auth / tokens\n- schema migration\n');
    });

    test('a scalar alone on a line keeps its line', () => {
        assert.equal(R('a\n{{repo.name}}\nb'), 'a\nMend\nb');
    });
});

describe('provenance', () => {
    const doc = '---\nname: done\ndescription: d\n---\n\n# /done\n\nbody here\n';
    const stamped = stampProvenance(doc, 'skills/done.md.tmpl');

    test('sits after frontmatter so the frontmatter still parses', () => {
        const lines = stamped.split('\n');
        assert.equal(lines[0], '---');
        assert.equal(lines[3], '---');
        assert.ok(lines[4].startsWith('<!-- cycle:rendered'));
    });

    test('hash round-trips, which is what makes check work', () => {
        assert.equal(hashContent(stripProvenance(stamped)), readProvenance(stamped).hash);
        assert.equal(readProvenance(stamped).template, 'skills/done.md.tmpl');
    });

    // Non-idempotent stamping would churn every consuming repo on every update.
    test('stamping is idempotent', () => {
        assert.equal(stampProvenance(doc, 'skills/done.md.tmpl'), stamped);
    });

    test('detects a hand edit', () => {
        const edited = stamped.replace('body here', 'body HERE');
        assert.notEqual(hashContent(stripProvenance(edited)), readProvenance(edited).hash);
    });

    // DOCTRINE.md has no frontmatter. This case regressed once: the stamped file kept
    // a leading newline the pre-stamp body never had, so `check` reported drift on a
    // file rendered seconds earlier. A drift detector that cries wolf gets ignored.
    test('round-trips on a file with no frontmatter', () => {
        const plain = stampProvenance('# Pipeline doctrine\n\nbody\n', 'DOCTRINE.md.tmpl');
        assert.ok(plain.startsWith('<!-- cycle:rendered'));
        assert.equal(hashContent(stripProvenance(plain)), readProvenance(plain).hash);
    });
});

describe('diff', () => {
    test('counts changed lines', () => {
        const d = lineDiff('a\nb\nc', 'a\nX\nc');
        assert.equal(d.added, 1);
        assert.equal(d.removed, 1);
        assert.equal(lineDiff('a\nb', 'a\nb').added, 0);
    });
});
