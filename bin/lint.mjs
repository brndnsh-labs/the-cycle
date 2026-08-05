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
//   verbs          a typo'd {{@verb}} renders as an unresolved tag instead of failing
//                  the build loudly.
//   verbs          a verb no backend binds, or one naming a scripts/ executable that
//                  nothing installs (the shim mechanism retired with the board).
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
    // Any package manager named in prose pins the skill to one ecosystem. /dep-update
    // spelled `npm outdated` four times, which quietly made it the one skill that
    // couldn't be installed in a repo written in anything else.
    [/\b(?:npm|pnpm|yarn|cargo|poetry|bundle|go get|go mod|uv) (?:outdated|audit|update|install|sync|lock|build|tidy|show|up)\b/,
        'a package-manager command — use {{deps.<name>}}'],
    [/\b(?:pnpm|yarn) run [a-z]/, 'a gate command — use {{gates.<name>}}'],
    [/\bgh (?:issue|pr|project|run) /, 'a tracker command — use a backend verb'],
    [/\bnode scripts\//, 'a helper invocation — use a backend verb'],
    // The name is parameterized as {{repo.human}}; the pronouns around it were not, so
    // the prose silently assumed one person's gender in six files. they/them is correct
    // for anyone, and for "the team".
    [/\b(?:he|him|his|she|her|hers)\b/i, 'a gendered pronoun — use they/them, or {{repo.human}}'],
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
    const harnesses = new Map();
    const harnessDir = join(CYCLE_HOME, 'harnesses');
    if (existsSync(harnessDir)) {
        for (const f of readdirSync(harnessDir).filter((x) => x.endsWith('.jsonc'))) {
            harnesses.set(basename(f, '.jsonc'), readJsonc(join(harnessDir, f)));
        }
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
    // A verb call {{@verb}} that no backend binds is a render failure waiting to
    // happen — this is the one part of the verb story still worth catching now that
    // github is the only backend. (This used to also track {{#if backend.…}} guards,
    // so a verb legitimate on one backend but missing on another wouldn't
    // false-positive; and it warned on a verb only one backend bound that no
    // template called. Both were about *divergence between backends*, which cannot
    // exist with a single one — re-add them if a second backend ever returns.)
    const called = new Map(); // verb → [{rel, line}]
    for (const [rel, text] of templates) {
        text.split('\n').forEach((line, i) => {
            for (const m of line.matchAll(/\{\{@([a-z_]+)/g)) {
                if (!called.has(m[1])) called.set(m[1], []);
                called.get(m[1]).push({ rel, line: i + 1 });
            }
        });
    }
    for (const [verb, sites] of called) {
        const lacking = [...backends].filter(([, b]) => !(b.verbs ?? {})[verb]).map(([n]) => n);
        if (lacking.length === backends.size) {
            add(ERROR, 'verbs', `{{@${verb}}} is bound by no backend`, sites[0] && `${sites[0].rel}:${sites[0].line}`);
        }
    }

    // --- backend semantics ---------------------------------------------------
    // A semantic flag exists to make a template branch. One that no template reads is
    // decoration that will eventually lie: someone flips it expecting the rendered
    // prose to follow, and nothing moves, because the real fact is hardcoded elsewhere.
    // (`has_shipped_status` and `unreachable_exit` were both in exactly that state.)
    const branchedOn = new Set();
    for (const text of templates.values()) {
        for (const m of text.matchAll(/\{\{[#/]?(?:if|unless)?\s*backend\.(\w+)/g)) branchedOn.add(m[1]);
        for (const m of text.matchAll(/\{\{\s*backend\.(\w+)/g)) branchedOn.add(m[1]);
    }
    for (const [name, b] of backends) {
        for (const flag of Object.keys(b.semantics ?? {})) {
            if (!branchedOn.has(flag)) {
                add(ERROR, 'semantics', `${name} declares "${flag}", which no template branches on`, `backends/${name}.jsonc`);
            }
        }
    }
    // The inverse: a template branching on a flag a backend doesn't declare reads as
    // falsy, so the branch silently never fires.
    for (const flag of branchedOn) {
        if (flag === 'name' || flag === 'notes') continue;
        for (const [name, b] of backends) {
            if (!(flag in (b.semantics ?? {}))) {
                add(ERROR, 'semantics', `templates branch on backend.${flag}, which ${name} does not declare`, `backends/${name}.jsonc`);
            }
        }
    }

    // --- no installed executables --------------------------------------------
    // The shim mechanism (backends declaring `shims`, each rendering a real file into
    // the repo that spawned a canonical script in the-cycle's helpers/) is gone — it
    // existed solely to carry the Projects v2 board helper. Nothing installs an
    // executable into a consuming repo any more, so a verb naming one would render a
    // command that cannot run. Templates are covered separately by the inlining rule.
    for (const [name, b] of backends) {
        for (const [verb, cmd] of Object.entries(b.verbs ?? {})) {
            if (/\bscripts\/[\w.-]+/.test(String(cmd))) {
                add(ERROR, 'verbs', `${verb} calls a scripts/ executable, but nothing installs one`, `backends/${name}.jsonc`);
            }
        }
    }

    // --- harness registry ----------------------------------------------------
    // `harness.*` is engine-computed (buildHarnessContext in bin/cycle.mjs), not
    // per-file declared like backend.semantics — every harness gets the same field
    // set. So the risk isn't a mismatched declaration, it's a typo'd field name: inside
    // a {{#if harness.foo}}/{{#unless}} block an unresolved path is silently falsy
    // rather than a hard error (only a bare scalar {{harness.foo}} fails loudly), so a
    // typo there renders a skill with a section quietly missing.
    const HARNESS_FIELDS = new Set([
        'name', 'display', 'root', 'doctrine_path', 'has_menus', 'has_subagents', 'attribution', 'ask',
    ]);
    const harnessBranchedOn = new Set();
    for (const text of templates.values()) {
        for (const m of text.matchAll(/\{\{[#/]?(?:if|unless)?\s*harness\.(\w+)/g)) harnessBranchedOn.add(m[1]);
        for (const m of text.matchAll(/\{\{\s*harness\.(\w+)/g)) harnessBranchedOn.add(m[1]);
    }
    for (const field of harnessBranchedOn) {
        if (!HARNESS_FIELDS.has(field)) {
            add(
                ERROR,
                'harnesses',
                `templates branch on harness.${field}, which buildHarnessContext never populates (has: ${[...HARNESS_FIELDS].join(', ')})`,
                'bin/cycle.mjs',
            );
        }
    }

    // A harness file's own declared "name" must match its filename — loadHarness keys
    // off the filename (cfg.harnesses: ["codex"] → harnesses/codex.jsonc), so a
    // mismatch here is invisible until someone greps the wrong field.
    for (const [file, h] of harnesses) {
        if (h.name !== file) {
            add(ERROR, 'harnesses', `declares name "${h.name}", which does not match its filename`, `harnesses/${file}.jsonc`);
        }
        if (!h.root) add(ERROR, 'harnesses', `${file}: no "root" — the engine has nowhere to place its skill tree`, `harnesses/${file}.jsonc`);
        if (!h.skill_file) add(ERROR, 'harnesses', `${file}: no "skill_file"`, `harnesses/${file}.jsonc`);
        if (typeof h.capabilities?.has_menus !== 'boolean') {
            add(ERROR, 'harnesses', `${file}: capabilities.has_menus must be true or false`, `harnesses/${file}.jsonc`);
        }
        if (typeof h.capabilities?.has_subagents !== 'boolean') {
            add(ERROR, 'harnesses', `${file}: capabilities.has_subagents must be true or false`, `harnesses/${file}.jsonc`);
        }
        if (!h.notes?.attribution) add(WARN, 'harnesses', `${file}: no notes.attribution — the §8 PR trailer renders empty`, `harnesses/${file}.jsonc`);
        if (!h.notes?.ask) add(WARN, 'harnesses', `${file}: no notes.ask — any {{harness.ask}} reference renders empty`, `harnesses/${file}.jsonc`);
    }

    // Two harnesses rendering to the same root would silently overwrite each other's
    // tree the moment a repo configured both in .cycle/config.jsonc's "harnesses".
    const harnessRoots = new Map();
    for (const [file, h] of harnesses) {
        if (!h.root) continue;
        if (harnessRoots.has(h.root)) {
            add(ERROR, 'harnesses', `shares root "${h.root}" with ${harnessRoots.get(h.root)} — configuring both would collide`, `harnesses/${file}.jsonc`);
        } else {
            harnessRoots.set(h.root, file);
        }
    }

    // --- overlays ----------------------------------------------------------
    const used = new Set();
    for (const text of templates.values()) {
        for (const m of text.matchAll(/\{\{>\s*overlay\??:([\w-]+)\}\}/g)) used.add(m[1]);
    }
    // The manifest is what `cycle install --plan` hands a guided setup, so a missing
    // entry means an overlay point nothing will ever be drafted for — it silently
    // stops existing as far as setup is concerned.
    const manifestPath = join(tmplDir, 'overlays.jsonc');
    if (!existsSync(manifestPath)) {
        add(ERROR, 'overlays', 'templates/overlays.jsonc is missing', 'templates/');
    } else {
        const manifest = readJsonc(manifestPath);
        for (const o of used) {
            if (!manifest[o]) add(ERROR, 'overlays', `overlay "${o}" is injected but absent from overlays.jsonc`, 'templates/overlays.jsonc');
        }
        for (const o of Object.keys(manifest)) {
            if (!used.has(o)) add(ERROR, 'overlays', `overlays.jsonc describes "${o}", which no template injects`, 'templates/overlays.jsonc');
            else for (const field of ['into', 'purpose', 'shape', 'value']) {
                if (!manifest[o][field]) add(WARN, 'overlays', `"${o}" has no ${field}`, 'templates/overlays.jsonc');
            }
        }
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

    // --- the shipped setup skills -------------------------------------------
    // These are static, not rendered, so the render suite never sees them. A bad
    // `name` means Claude Code doesn't load the skill and the slash command is
    // simply absent — silent, and confusing to diagnose.
    const setupDir = join(CYCLE_HOME, 'skills');
    if (existsSync(setupDir)) {
        for (const name of readdirSync(setupDir)) {
            const rel = `skills/${name}/SKILL.md`;
            const p = join(setupDir, name, 'SKILL.md');
            if (!existsSync(p)) {
                add(ERROR, 'setup-skills', `${name}/ has no SKILL.md`, rel);
                continue;
            }
            const fm = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(p, 'utf8'));
            if (!fm) {
                add(ERROR, 'setup-skills', 'no frontmatter', rel);
                continue;
            }
            const declared = /^name:\s*(\S+)/m.exec(fm[1])?.[1];
            if (declared !== name) add(ERROR, 'setup-skills', `frontmatter name "${declared}" ≠ directory "${name}"`, rel);
            if (!/^description:\s*\S/m.test(fm[1])) add(ERROR, 'setup-skills', 'no description', rel);
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
    if (!errors.length && !warns.length) console.log(green('✓ consistent — citations, verbs, overlays and profiles all line up'));
    else if (!errors.length) console.log(green(`✓ no errors`) + dim(` · ${warns.length} warning(s)`));
    else console.log(red(`✗ ${errors.length} error(s)`) + dim(` · ${warns.length} warning(s)`));

    process.exitCode = errors.length ? 1 : 0;
}
