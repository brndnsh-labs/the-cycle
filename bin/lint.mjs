// lint.mjs — internal consistency of the-cycle itself.
//
// The render tests prove every template *resolves*. These checks prove the pieces
// still refer to each other correctly, which resolving cannot show: a `§7` citation
// pointing at a section that got renumbered renders perfectly and misinforms every
// read of that skill.
//
// Each check exists because the corresponding mistake was made, or is one edit away:
//
//   citations      §N is a plain string; nothing links it to DOCTRINE's headings.
//   verbs          a typo'd {{@verb}} only fails on the backend that lacks it.
//   shims          `shims` was declared and consumed nowhere — every rendered skill
//                  called scripts/forgejo-project.mjs into a repo that had no such
//                  file. Verbs and shim declarations must agree.
//   overlays       AUTHORING.md's table is hand-maintained next to the code it
//                  documents, which is exactly how docs go stale.
//   profiles       a template in no profile is dead; a profile entry with no
//                  template fails the render, but late and per-repo.
//   cross-refs     a lean repo's skill saying "then run /nightly" points at a skill
//                  that repo doesn't install.
//   inlining       the original sin: a repo fact typed into portable prose. Every
//                  copy drifted because every skill restated `npm run typecheck`.
//
// Errors fail the build; warnings are reported and pass.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const ERROR = 'error';
const WARN = 'warn';

/** Commands that belong in a backend verb or a gate, never in portable prose. */
const INLINED = [
    [/\bnpm run [a-z]/, 'a gate command — use {{gates.<name>}}'],
    [/\b(?:pnpm|yarn) [a-z]/, 'a gate command — use {{gates.<name>}}'],
    [/\bgh (?:issue|pr|project|run) /, 'a tracker command — use a backend verb'],
    [/\bnode scripts\//, 'a helper invocation — use a backend verb'],
    [/\bci-logs\b/, 'a helper invocation — use {{@ci_log}} / {{@ci_runs}}'],
];

export function lint({ CYCLE_HOME }) {
    const findings = [];
    const add = (severity, check, message, where) => findings.push({ severity, check, message, where });

    const tmplDir = join(CYCLE_HOME, 'templates');
    const skillDir = join(tmplDir, 'skills');
    const templates = new Map(); // rel → text
    templates.set('DOCTRINE.md.tmpl', readFileSync(join(tmplDir, 'DOCTRINE.md.tmpl'), 'utf8'));
    for (const f of readdirSync(skillDir).filter((x) => x.endsWith('.md.tmpl')).sort()) {
        templates.set(join('skills', f), readFileSync(join(skillDir, f), 'utf8'));
    }

    const backends = new Map();
    for (const f of readdirSync(join(CYCLE_HOME, 'backends')).filter((x) => x.endsWith('.jsonc'))) {
        backends.set(basename(f, '.jsonc'), readJsonc(join(CYCLE_HOME, 'backends', f)));
    }
    const profiles = new Map();
    for (const f of readdirSync(join(CYCLE_HOME, 'profiles')).filter((x) => x.endsWith('.jsonc'))) {
        profiles.set(basename(f, '.jsonc'), readJsonc(join(CYCLE_HOME, 'profiles', f)));
    }

    const skillNames = new Set(
        [...templates.keys()].filter((k) => k.startsWith('skills/')).map((k) => basename(k, '.md.tmpl')),
    );

    // --- citations ---------------------------------------------------------
    const doctrine = templates.get('DOCTRINE.md.tmpl');
    const sections = new Set([...doctrine.matchAll(/^## §(\d+)\b/gm)].map((m) => m[1]));
    for (const [rel, text] of templates) {
        text.split('\n').forEach((line, i) => {
            for (const m of line.matchAll(/§(\d+)/g)) {
                if (!sections.has(m[1])) {
                    add(ERROR, 'citations', `cites §${m[1]}, which DOCTRINE has no section for`, `${rel}:${i + 1}`);
                }
            }
        });
    }
    // A section nothing cites is not wrong, but it is a smell worth seeing.
    const cited = new Set(
        [...templates].flatMap(([rel, t]) => (rel === 'DOCTRINE.md.tmpl' ? [] : [...t.matchAll(/§(\d+)/g)].map((m) => m[1]))),
    );
    for (const s of [...sections].sort((a, b) => a - b)) {
        if (!cited.has(s)) add(WARN, 'citations', `DOCTRINE §${s} is cited by no skill`, 'DOCTRINE.md.tmpl');
    }

    // --- verbs -------------------------------------------------------------
    // A verb missing from one backend is legitimate when the call sits inside a
    // {{#if backend.…}} branch — that is how board reads work on Forgejo, which has
    // no board. Outside such a branch it is a render failure waiting for whichever
    // repo happens to use the other tracker.
    const called = new Map(); // verb → [{rel, line, guarded}]
    for (const [rel, text] of templates) {
        let guard = 0;
        text.split('\n').forEach((line, i) => {
            for (const m of line.matchAll(/\{\{[#/](if|unless)\s*([^}\s]*)/g)) {
                if (m[0].startsWith('{{/')) guard = Math.max(0, guard - 1);
                else if (m[2].startsWith('backend.')) guard += 1;
                else guard += 0; // a non-backend conditional does not excuse a missing verb
            }
            for (const m of line.matchAll(/\{\{@([a-z_]+)/g)) {
                if (!called.has(m[1])) called.set(m[1], []);
                called.get(m[1]).push({ rel, line: i + 1, guarded: guard > 0 });
            }
        });
    }
    for (const [verb, sites] of called) {
        const lacking = [...backends].filter(([, b]) => !(b.verbs ?? {})[verb]).map(([n]) => n);
        if (lacking.length === backends.size) {
            add(ERROR, 'verbs', `{{@${verb}}} is bound by no backend`, sites[0] && `${sites[0].rel}:${sites[0].line}`);
            continue;
        }
        for (const site of sites) {
            if (lacking.length && !site.guarded) {
                add(
                    ERROR,
                    'verbs',
                    `{{@${verb}}} is unbound on ${lacking.join(', ')} and this call is not inside a {{#if backend.…}}`,
                    `${site.rel}:${site.line}`,
                );
            }
        }
    }
    // An uncalled verb is not itself a problem — the vocabulary in docs/BACKENDS.md is
    // deliberately complete, so adding a skill never means editing a backend. What IS
    // worth seeing is an uncalled verb only *one* backend binds: either the other
    // backend is missing it, or it was written for a skill that never materialized.
    for (const [name, b] of backends) {
        for (const verb of Object.keys(b.verbs ?? {})) {
            if (called.has(verb)) continue;
            const others = [...backends].filter(([n]) => n !== name);
            if (others.length && others.every(([, o]) => !(o.verbs ?? {})[verb])) {
                add(WARN, 'verbs', `only ${name} binds "${verb}", and no template calls it`, `backends/${name}.jsonc`);
            }
        }
    }

    // --- shims -------------------------------------------------------------
    for (const [name, b] of backends) {
        const declared = new Set((b.shims ?? []).map((s) => s.path));
        const referenced = new Set();
        for (const cmd of Object.values(b.verbs ?? {})) {
            for (const m of String(cmd).matchAll(/\b(scripts\/[\w.-]+)/g)) referenced.add(m[1]);
        }
        for (const path of referenced) {
            if (!declared.has(path)) {
                add(ERROR, 'shims', `verbs call ${path} but no shim installs it`, `backends/${name}.jsonc`);
            }
        }
        for (const path of declared) {
            if (!referenced.has(path)) {
                add(WARN, 'shims', `installs ${path}, which no verb calls`, `backends/${name}.jsonc`);
            }
        }
        for (const shim of b.shims ?? []) {
            if (!shim.helper) {
                add(ERROR, 'shims', `${shim.path} declares no helper`, `backends/${name}.jsonc`);
            } else if (!existsSync(join(CYCLE_HOME, 'helpers', shim.helper))) {
                add(ERROR, 'shims', `${shim.path} → helpers/${shim.helper}, which does not exist`, `backends/${name}.jsonc`);
            }
        }
    }

    // --- overlays ----------------------------------------------------------
    const used = new Set();
    for (const text of templates.values()) {
        for (const m of text.matchAll(/\{\{>\s*overlay\??:([\w-]+)\}\}/g)) used.add(m[1]);
    }
    const authoring = join(CYCLE_HOME, 'docs', 'AUTHORING.md');
    if (existsSync(authoring)) {
        const doc = readFileSync(authoring, 'utf8');
        const table = doc.slice(doc.indexOf('Current overlay points'));
        const documented = new Set(
            [...table.slice(0, table.indexOf('\n## ') + 1 || undefined).matchAll(/^\|\s*([^|]+)\|/gm)]
                .flatMap((m) => [...m[1].matchAll(/`([\w-]+)`/g)].map((x) => x[1])),
        );
        for (const o of used) {
            if (!documented.has(o)) add(WARN, 'overlays', `overlay "${o}" is used but not in AUTHORING.md's table`, 'docs/AUTHORING.md');
        }
        for (const o of documented) {
            if (!used.has(o)) add(WARN, 'overlays', `AUTHORING.md documents overlay "${o}", which no template injects`, 'docs/AUTHORING.md');
        }
    }

    // --- profiles ----------------------------------------------------------
    const inAnyProfile = new Set([...profiles.values()].flatMap((p) => p.skills ?? []));
    for (const skill of skillNames) {
        if (!inAnyProfile.has(skill)) add(WARN, 'profiles', `template exists but no profile installs it`, `templates/skills/${skill}.md.tmpl`);
    }
    for (const [name, p] of profiles) {
        for (const skill of p.skills ?? []) {
            if (!skillNames.has(skill)) add(ERROR, 'profiles', `lists "${skill}", which has no template`, `profiles/${name}.jsonc`);
        }
    }

    // --- cross-references ---------------------------------------------------
    // Only /names that are actually skills here; anything else is a Claude Code
    // built-in or a path, and not ours to judge.
    for (const [rel, text] of templates) {
        if (!rel.startsWith('skills/')) continue;
        const self = basename(rel, '.md.tmpl');
        const refs = new Set([...text.matchAll(/(?<![\w/])\/([a-z][a-z-]+)\b/g)].map((m) => m[1]));
        for (const ref of refs) {
            if (ref === self || !skillNames.has(ref)) continue;
            for (const [pname, p] of profiles) {
                const skills = p.skills ?? [];
                if (skills.includes(self) && !skills.includes(ref)) {
                    add(WARN, 'cross-refs', `mentions /${ref}, absent from the "${pname}" profile that installs it`, rel);
                }
            }
        }
    }

    // --- inlined repo facts -------------------------------------------------
    for (const [rel, text] of templates) {
        text.split('\n').forEach((line, i) => {
            for (const [re, why] of INLINED) {
                if (re.test(line)) add(ERROR, 'inlining', `${why}: ${line.trim().slice(0, 70)}`, `${rel}:${i + 1}`);
            }
        });
    }

    return findings;
}

/** Local copy so lint can run standalone; same stripper the CLI uses. */
function readJsonc(path) {
    const text = readFileSync(path, 'utf8');
    return JSON.parse(
        text
            .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ''))
            .replace(/,(\s*[}\]])/g, '$1'),
    );
}

export function cmdLint(args, { CYCLE_HOME, bold, dim, red, yellow, green }) {
    const findings = lint({ CYCLE_HOME });
    const errors = findings.filter((f) => f.severity === ERROR);
    const warns = findings.filter((f) => f.severity === WARN);
    const quiet = args.includes('-q') || args.includes('--quiet');

    for (const group of [errors, quiet ? [] : warns]) {
        let lastCheck = null;
        for (const f of group) {
            if (f.check !== lastCheck) {
                console.log(`\n${bold(f.check)}`);
                lastCheck = f.check;
            }
            const mark = f.severity === ERROR ? red('✗') : yellow('!');
            console.log(`  ${mark} ${f.message}`);
            if (f.where) console.log(`    ${dim(f.where)}`);
        }
    }

    console.log();
    if (!errors.length && !warns.length) console.log(green('✓ consistent — citations, verbs, shims, overlays and profiles all line up'));
    else if (!errors.length) console.log(green(`✓ no errors`) + dim(` · ${warns.length} warning(s)`));
    else console.log(red(`✗ ${errors.length} error(s)`) + dim(` · ${warns.length} warning(s)`));

    process.exitCode = errors.length ? 1 : 0;
}
