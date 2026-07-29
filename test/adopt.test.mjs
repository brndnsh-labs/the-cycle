// Loss detection — the thing `cycle adopt` was missing when it converted mend.
//
// The bug it exists to prevent, exactly: every overlay point is optional, so a repo
// with no overlays renders a complete-looking pipeline. adopt printed "✓ renders
// cleanly" while the five scout lens bodies, the dep-update landmine table and the
// entire deploy topology — ~300 lines of knowledge that took real incidents to
// learn — ceased to exist. A green tick over a silent deletion.
//
// So these tests pin the two failure directions separately, because a detector that
// only satisfies one of them is useless: it must FIRE on content that vanished, and
// stay QUIET on content the template merely rewrote. A detector that flags everything
// trains you to skip the report, which is the same outcome as not having one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { contentLoss, overlayFor, sections } from '../bin/adopt.mjs';

const LANDMINES = `
## High-scrutiny packages

- **better-sqlite3** — a native module. The deploy script runs npm ci on the box
  itself after rsync, so a bump does not risk an ABI-mismatch deploy the way it
  would in a repo that ships a committed native binary.
- **tailwindcss** — v4 derives numeric spacing and numeric leading from a single
  spacing token. An override once silently doubled both app-wide and only a
  screenshot caught it; the gates stayed green throughout.
`;

const GENERIC_TEMPLATE = `
## Workflow

1. Survey what is outdated. Group by risk: a patch on a leaf dependency is
   routine; a major, a framework, or anything with a native build step is not.
2. Present the plan: what is bumping, from and to, and what you are holding back.
3. Branch, update, and run the gates.
`;

describe('adopt / content loss', () => {
    test('fires on a section the render has nowhere to put', () => {
        const lost = contentLoss(LANDMINES, GENERIC_TEMPLATE);
        assert.equal(lost.length, 1, 'the landmine table vanished and should be reported');
        assert.match(lost[0].title, /High-scrutiny/);
        assert.ok(lost[0].carried < 20, `expected almost nothing carried, got ${lost[0].carried}%`);
    });

    // The counterweight. Templates legitimately rewrite procedure in their own
    // words, and reporting that as loss is how a warning becomes noise.
    test('stays quiet when the template rewrote the same content', () => {
        const reworded = `
## Workflow

1. Survey what is outdated, grouping by risk — a patch on a leaf dependency is
   routine, while a major, a framework, or anything with a native build step is not.
2. Present the plan: what is bumping, from and to, and what you are holding back.
3. Branch, update, and then run the gates.
`;
        assert.deepEqual(contentLoss(GENERIC_TEMPLATE, reworded), []);
    });

    test('ignores a section too small to judge', () => {
        assert.deepEqual(contentLoss('## Note\n\nSee below.\n', 'nothing here'), []);
    });

    test('reports the biggest loss first, so the top of the list is the part worth reading', () => {
        const smaller = `
## Smaller but still real

The edge Caddy terminates TLS and reverse proxies each subdomain to its box on
port three thousand, so neither machine is reachable from the internet directly.
`;
        const lost = contentLoss(`${LANDMINES}\n${smaller}`, 'unrelated');
        assert.ok(lost.length >= 2);
        assert.ok(lost[0].lines >= lost[1].lines, 'sections must be ranked by size');
    });

    // Shell snippets are everywhere in these skills. Reading `# comment` inside a
    // fence as a heading shattered DOCTRINE into fragments titled "1. Wait for the
    // run to REGISTER", which made the whole report look untrustworthy.
    test('does not mistake a comment inside a code fence for a heading', () => {
        const md = ['## Real heading', '', '```bash', '# Not a heading', 'echo hi', '```', '', 'body text'].join('\n');
        assert.deepEqual(
            sections(md).map((s) => s.title),
            ['Real heading'],
        );
    });
});

describe('adopt / overlay routing', () => {
    const manifest = {
        'doctrine-preamble': { into: 'DOCTRINE, before §1' },
        'doctrine-labels': { into: 'DOCTRINE §2 (Labels)' },
        'doctrine-gates': { into: 'DOCTRINE §4 (Gates)' },
    };
    const all = Object.keys(manifest);

    test('routes a DOCTRINE section to the overlay that names its §N', () => {
        assert.equal(overlayFor('§2 Labels', all, manifest), 'doctrine-labels');
        assert.equal(overlayFor('§4 Gates', all, manifest), 'doctrine-gates');
    });

    test('routes the preamble to the before-§1 overlay', () => {
        assert.equal(overlayFor('(preamble)', all, manifest), 'doctrine-preamble');
    });

    // The temptation is to route every loss in a single-overlay template to that
    // overlay. That is how /scout's "Workflow" and "Dedup" sections got labelled as
    // belonging in scout-lenses — wrong, and confidently wrong, which is worse than
    // silent. Where it isn't derivable, say nothing.
    test('declines to guess when the section names no section number', () => {
        assert.equal(overlayFor('Workflow', all, manifest), null);
        assert.equal(overlayFor('§9 Branch policy', all, manifest), null, 'no overlay claims §9');
    });
});
