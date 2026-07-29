// `cycle adopt` — reverse-engineer a hand-written pipeline into the-cycle's shape.
//
// This is the command that makes the whole repo worth building: without it, the-cycle
// is a fourth divergent copy of the same skills rather than the thing the other three
// converge onto.
//
// Its job is to DRAFT and to SHOW, never to decide. Where a repo's existing doctrine
// and the shared template disagree, that is a judgment call for a human — adopt
// surfaces the delta and stops. It writes nothing without --write, and even then it
// writes only .cycle/ (config + overlays), never over an existing skill.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseArgs, styleText } from 'node:util';

const supportsColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (s, t) => (supportsColor ? styleText(s, t) : t);
const bold = (t) => paint('bold', t);
const dim = (t) => paint('dim', t);
const green = (t) => paint('green', t);
const yellow = (t) => paint('yellow', t);
const cyan = (t) => paint('cyan', t);

// ---------------------------------------------------------------------------
// extraction — heuristics over a DOCTRINE.md that already follows the §1–§9 spine
// ---------------------------------------------------------------------------

/** Body text of one `## §N …` section. */
function section(doctrine, n) {
    const re = new RegExp(`^## §${n}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## §|\\Z)`, 'm');
    return re.exec(doctrine)?.[1]?.trim() ?? '';
}

/** The first fenced block in a chunk of markdown. */
const firstFence = (text) => /```[a-z]*\n([\s\S]*?)```/.exec(text)?.[1]?.trimEnd() ?? '';

/**
 * §4's gate commands. Comments are kept: they explain what each gate actually covers,
 * and that explanation is repo knowledge worth carrying over verbatim.
 */
function extractGates(doctrine) {
    const lines = firstFence(section(doctrine, 4)).split('\n').filter((l) => l.trim());
    const commands = lines.filter((l) => !l.trim().startsWith('#'));
    const named = {};
    for (const line of commands) {
        const cmd = line.split('#')[0].trim();
        if (/typecheck|tsc/.test(cmd)) named.typecheck ??= cmd;
        else if (/\btest\b/.test(cmd)) named.test ??= cmd;
        else if (/\blint\b/.test(cmd)) named.lint ??= cmd;
    }
    return { ...named, commands };
}

/**
 * §5's always-brake bullets. A bullet's label is its first bold span, which may not
 * start the line — real doctrine writes both "- **Crypto / relay**" and "- A diff is
 * a **destructive data op**". Anchoring on `^- \*\*` silently drops half of them.
 */
function extractBrakes(doctrine) {
    const body = section(doctrine, 5);
    const stop = body.indexOf('**Stop and surface');
    const scope = stop === -1 ? body : body.slice(stop);
    const out = [];

    // Top-level bullets only, re-joined across their wrapped continuation lines.
    for (const raw of scope.split(/\n(?=- )/)) {
        if (!raw.startsWith('- ')) continue;
        const bullet = raw.replace(/\n\s+/g, ' ');
        const label = /\*\*(.+?)\*\*/.exec(bullet)?.[1]?.replace(/[.:]$/, '').trim();
        if (!label) continue;
        // Already in the shared template — carrying them over would duplicate them.
        if (/review finding|implementation choice|design decision|Gates\/CI red|Needs-decision/i.test(label)) continue;
        out.push(label);
    }
    return [...new Set(out)];
}

/** §1's status table, as {name, meaning, action} rows. */
function extractStatuses(doctrine) {
    const rows = [];
    for (const line of section(doctrine, 1).split('\n')) {
        const m = /^\|\s*\*?\*?(.+?)\*?\*?\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line.trim());
        if (!m) continue;
        const [, rawName, meaning, action] = m;
        const name = rawName
            .replace(/`/g, '')
            .replace(/\\/g, '')
            .replace(/\*+/g, '')
            .replace(/\s*\+.*$/, '') // "(no Status) + backlog/finding" → "(no Status)"
            .trim();
        if (!name || /^-+$/.test(name) || /^status\/?$/i.test(name)) continue;
        rows.push({ name, meaning: meaning.trim(), action: action.trim() });
    }
    return rows;
}

/** The `Co-Authored-By:` trailer §8 pins — usually the staleset value in the repo. */
const extractCoauthor = (doctrine) =>
    /Co-Authored-By:\s*(.+)/.exec(section(doctrine, 8))?.[1]?.trim() ?? null;

const extractRanking = (doctrine) =>
    /\*\*Ranking[^*]*\*\*[^:]*:\s*([\s\S]*?)(?:\n\n|$)/.exec(section(doctrine, 1))?.[1]
        ?.replace(/\s+/g, ' ')
        .replace(/\.$/, '')
        .trim() ?? null;

/** §9: does this repo let minor edits skip the branch+PR dance? */
const extractMinorEditsDirect = (doctrine) => /straight to `?main`?/i.test(section(doctrine, 9));

// ---------------------------------------------------------------------------
// content loss — what the render would drop on the floor
// ---------------------------------------------------------------------------
//
// The failure this exists to prevent: every overlay point is optional, so a repo
// with no overlays renders a complete-looking pipeline and adopt reports "renders
// cleanly" — while the five scout lens bodies, the dep-update landmines and the
// whole deploy topology quietly cease to exist. Converting mend lost ~300 lines
// that way, and nothing said a word.
//
// adopt already holds both sides: the existing hand-written files, and the content
// planRender would write over them. So it can just *look*.

/** Words only — so the same sentence rewrapped at a different width isn't "lost". */
const normalize = (s) =>
    s
        .toLowerCase()
        .replace(/`[^`]*`/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

/**
 * Word trigrams. Comparing whole lines would flag every reflowed paragraph, and
 * comparing single words would match anything; three-word runs survive rewrapping
 * and light editing but disappear when the content genuinely does.
 */
function trigrams(text) {
    const words = normalize(text).split(' ').filter(Boolean);
    const out = new Set();
    for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    return out;
}

/**
 * Split markdown into `## heading` → body chunks, plus whatever precedes the first.
 *
 * Fence-aware, because these files are full of shell snippets and `# comment` inside
 * a ```block``` is not a heading — reading it as one shattered DOCTRINE into fragments
 * titled things like "1. Wait for the run to REGISTER".
 */
export function sections(md) {
    const body = md.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^<!--\s*cycle:rendered[^\n]*\n/m, '');
    const lines = body.split('\n');
    const out = [];
    let fenced = false;
    let cur = { title: '(preamble)', lines: [] };
    for (const line of lines) {
        if (/^\s*```/.test(line)) fenced = !fenced;
        const h = !fenced && /^(#{1,4})\s+(.+)$/.exec(line);
        if (h) {
            out.push(cur);
            cur = { title: h[2].trim(), lines: [] };
        } else {
            cur.lines.push(line);
        }
    }
    out.push(cur);
    return out.map((s) => ({ title: s.title, text: s.lines.join('\n') })).filter((s) => s.text.trim().length > 0);
}

/**
 * Sections of `existing` whose substance does not survive into `rendered`.
 *
 * Deliberately biased toward over-reporting: a false positive costs one glance,
 * while the false negative is the entire bug — 300 lines gone with a green tick
 * next to it. The threshold is coverage, not identity, so a section the template
 * rewrote in its own words reads as carried, and one it never knew about reads as
 * lost.
 */
export function contentLoss(existing, rendered) {
    const have = trigrams(rendered);
    const lost = [];
    for (const sec of sections(existing)) {
        const tri = trigrams(sec.text);
        // Too short to judge — a two-line section has no statistical signal, and at
        // this size the reworded-procedure false positives outnumber the real losses.
        if (tri.size < 20) continue;
        let carried = 0;
        for (const t of tri) if (have.has(t)) carried++;
        const ratio = carried / tri.size;
        if (ratio < 0.5) {
            lost.push({
                title: sec.title,
                lines: sec.text.trim().split('\n').length,
                carried: Math.round(ratio * 100),
            });
        }
    }
    // Biggest first: the 31-line landmine table matters and the 4-line one usually
    // doesn't, and a human scanning this reads the top of the list.
    return lost.sort((a, b) => b.lines - a.lines);
}

/** template rel path → the overlay names it declares, by reading the template itself. */
function overlayPointsByTemplate(CYCLE_HOME) {
    const dir = join(CYCLE_HOME, 'templates');
    const map = new Map();
    const walk = (d, prefix = '') => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) {
                walk(join(d, e.name), `${prefix}${e.name}/`);
            } else if (e.name.endsWith('.tmpl')) {
                const names = [...readFileSync(join(d, e.name), 'utf8').matchAll(/overlay\??:([\w-]+)\s*\}\}/g)].map(
                    (m) => m[1],
                );
                if (names.length) map.set(`${prefix}${e.name}`, [...new Set(names)]);
            }
        }
    };
    walk(dir);
    return map;
}

/**
 * Which overlay should carry a lost section — but ONLY where that is knowable.
 *
 * DOCTRINE's eight points are addressable, because each manifest entry names its
 * `§N`. A skill template usually declares exactly one point, and the tempting move is
 * to route everything there — but that is how `/scout`'s "Workflow" and "Dedup"
 * sections got labelled as belonging in `scout-lenses`, which is wrong and, worse,
 * confidently wrong. Where the answer isn't derivable, say nothing and let the
 * file-level list speak.
 */
export function overlayFor(sectionTitle, candidates, manifest) {
    const n = /§\s*(\d+)/.exec(sectionTitle)?.[1];
    if (n) return candidates.find((c) => new RegExp(`§\\s*${n}\\b`).test(manifest[c]?.into ?? '')) ?? null;
    if (sectionTitle === '(preamble)' || /doctrine/i.test(sectionTitle)) {
        return candidates.find((c) => /before §1/i.test(manifest[c]?.into ?? '')) ?? null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

export function cmdAdopt(args, ctx) {
    const { findRepoRoot, detect, planRender, loadProfile, renderConfig } = ctx;
    const { values } = parseArgs({
        args,
        options: { write: { type: 'boolean' }, profile: { type: 'string' } },
        allowPositionals: true,
    });

    const root = findRepoRoot();
    const skillsDir = join(root, '.claude', 'skills');
    const doctrinePath = join(skillsDir, 'DOCTRINE.md');

    if (!existsSync(skillsDir)) {
        console.log(`${yellow('!')} no .claude/skills here — nothing to adopt.`);
        console.log(dim('  this is a greenfield repo; run `cycle install` instead.'));
        return;
    }

    const existing = readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
        .map((e) => e.name);

    const doctrine = existsSync(doctrinePath) ? readFileSync(doctrinePath, 'utf8') : '';
    const d = detect(root);

    console.log(`${bold('Adopting')} ${root}`);
    console.log(dim(`  ${existing.length} hand-written skills · DOCTRINE.md ${doctrine ? `(${doctrine.split('\n').length} lines)` : '(absent)'}\n`));

    // ---- draft the config ---------------------------------------------------
    const gates = doctrine ? extractGates(doctrine) : {};
    const brakes = doctrine ? extractBrakes(doctrine) : [];
    const statuses = doctrine ? extractStatuses(doctrine) : [];
    const coauthor = doctrine ? extractCoauthor(doctrine) : null;
    const ranking = doctrine ? extractRanking(doctrine) : null;

    const profileName = values.profile ?? pickProfile(existing, loadProfile);
    const profile = loadProfile(profileName);

    const cfg = {
        repo: {
            name: d.name,
            slug: d.slug ?? '',
            human: 'Brandon',
        },
        profile: profileName,
        backend: d.backend,
        tracker: {
            description: `\`${d.slug ?? d.name}\``,
            project: null,
            owner: (d.slug ?? '/').split('/')[0],
            statuses: statuses.length ? statuses : undefined,
            status: statuses.length ? guessStatusMap(statuses) : undefined,
            ranking: ranking ?? undefined,
            milestones: [],
        },
        routing: { model: '**opus for everything** (spawned agents included).', executor_default: 'orchestrator-inline' },
        gates: Object.keys(gates).length ? gates : d.gates,
        brakes,
        branch: { minor_edits_direct: doctrine ? extractMinorEditsDirect(doctrine) : true },
        commit: { coauthor: coauthor ?? 'Claude Opus 5 <noreply@anthropic.com>' },
        deploy: d.deploy ?? { test: '', prod: '' },
    };

    // ---- report what was extracted, and what it could not reach -------------
    console.log(bold('Extracted into .cycle/config.jsonc:'));
    console.log(dim('  (a draft read off prose — read every line before trusting it)'));
    report('backend', cfg.backend, d.remote ? `from origin (${d.remote})` : 'defaulted');
    report('gates', (cfg.gates.commands ?? []).length ? cfg.gates.commands.join(' · ') : '(none found)', 'DOCTRINE §4');
    report('brakes', brakes.length ? brakes.join(' · ') : '(none found)', 'DOCTRINE §5');
    report('statuses', statuses.map((s) => s.name).join(' · ') || '(none found)', 'DOCTRINE §1');
    report('coauthor', cfg.commit.coauthor, coauthor ? 'DOCTRINE §8' : 'defaulted');
    report('profile', profileName, `${existing.length} skills present`);

    // A repo whose git remote and whose tracker doctrine disagree is mid-migration, and
    // rendering it against either backend alone would quietly pick a winner. Say so.
    const doctrineBackend = /gh project|gh issue|gh pr |gh-project\.mjs/.test(doctrine)
        ? 'github'
        : /forgejo/i.test(doctrine)
          ? 'forgejo'
          : null;
    if (doctrineBackend && doctrineBackend !== cfg.backend) {
        console.log(`\n${yellow('!')} backend mismatch — this repo is mid-migration:`);
        console.log(`    git remote says ${bold(cfg.backend)} (${d.remote})`);
        console.log(`    DOCTRINE still describes ${bold(doctrineBackend)} commands`);
        console.log(dim('    → pick one before rendering: set "backend" in config.jsonc deliberately.'));
        console.log(dim(`      adopt drafted "${cfg.backend}" from the remote, but it is not casting a vote.`));
    }

    if (coauthor && !/Opus 5|Claude Opus 5/.test(coauthor)) {
        console.log(`\n${yellow('!')} the extracted Co-Authored-By trailer looks stale: ${dim(coauthor)}`);
        console.log(dim('  this is exactly the drift the-cycle exists to fix — update it in config, once.'));
    }

    // ---- what adopt cannot decide -------------------------------------------
    const notPortable = existing.filter((s) => !(profile.skills ?? []).includes(s));
    const missing = (profile.skills ?? []).filter((s) => !existing.includes(s));

    console.log(`\n${bold('Needs your judgment:')}`);
    if (notPortable.length) {
        console.log(`  ${cyan('•')} ${notPortable.length} skill(s) here are not in the "${profileName}" profile:`);
        console.log(`      ${notPortable.join(', ')}`);
        console.log(dim('      → keep them as-is (unmanaged), or add them to a profile upstream'));
    }
    if (missing.length) {
        console.log(`  ${cyan('•')} ${missing.length} profile skill(s) don't exist here yet: ${missing.join(', ')}`);
        console.log(dim('      → they will be created new by the render'));
    }
    console.log(`  ${cyan('•')} Every existing skill will be REPLACED by its rendered version.`);
    console.log(dim('      → diff each one before committing; anything this repo learned that the'));
    console.log(dim('        template does not know is a change to make UPSTREAM, not to keep here.'));

    // Rendering is the easy half; the half that bites is a render that SUCCEEDS while
    // dropping everything this repo knew. Run it read-only too — being told what you
    // are about to lose is worth most *before* you have committed to anything.
    let plan;
    try {
        plan = planRender(root, stripUndefined(cfg));
    } catch (e) {
        console.log(`\n${yellow('!')} render is not satisfiable yet:`);
        console.log(`    ${e.message.split('\n').join('\n    ')}`);
        plan = null;
    }
    if (plan) reportLoss(root, plan, ctx);

    if (!values.write) {
        console.log(`\n${dim('Read-only. Re-run with --write to create .cycle/config.jsonc + overlays/.')}`);
        console.log(dim('No skill file is touched either way — `cycle update` does that, once you are ready.'));
        return;
    }

    // ---- write only .cycle/ -------------------------------------------------
    mkdirSync(join(root, '.cycle', 'overlays'), { recursive: true });
    const cfgPath = join(root, '.cycle', 'config.jsonc');
    if (existsSync(cfgPath)) {
        console.log(`\n${yellow('!')} .cycle/config.jsonc already exists — leaving it alone.`);
    } else {
        writeFileSync(cfgPath, renderConfig(stripUndefined(cfg)));
        console.log(`\n${green('✓')} wrote ${relative(root, cfgPath)}`);
    }
}

/**
 * The part adopt was missing: say what the render would throw away.
 *
 * Overlays are optional by design — a greenfield install with none of them renders a
 * complete pipeline, and that must stay true. Optionality is not the bug. Silence is.
 */
function reportLoss(root, plan, ctx) {
    const { CYCLE_HOME, readJsonc } = ctx;
    const manifestPath = join(CYCLE_HOME, 'templates', 'overlays.jsonc');
    const manifest = existsSync(manifestPath) ? readJsonc(manifestPath) : {};
    const pointsByTemplate = overlayPointsByTemplate(CYCLE_HOME);

    const casualties = [];
    for (const file of plan) {
        if (!file.rel.startsWith(join('.claude', 'skills'))) continue;
        if (!existsSync(file.path)) continue;
        const lost = contentLoss(readFileSync(file.path, 'utf8'), file.content);
        if (lost.length) {
            casualties.push({ file, lost, points: pointsByTemplate.get(file.template) ?? [] });
        }
    }

    if (!casualties.length) {
        console.log(`${green('✓')} renders cleanly, and no existing content is left behind`);
        console.log(dim('  run `cycle update --dry-run` to see the diffs'));
        return;
    }

    const weight = (c) => c.lost.reduce((m, l) => m + l.lines, 0);
    casualties.sort((a, b) => weight(b) - weight(a));
    const totalLines = casualties.reduce((n, c) => n + weight(c), 0);
    console.log(
        `\n${yellow('!')} ${bold(String(totalLines))} line(s) across ${bold(String(casualties.length))} file(s) are ${bold('not in the rendered output')}:\n`,
    );

    const SHOWN = 5;
    const wanted = new Set();
    for (const { file, lost, points } of casualties) {
        // A file with exactly one overlay point has an unambiguous destination, so
        // name it. DOCTRINE's eight get routed per-§N below instead of listed here,
        // where they would wrap into an unreadable smear.
        const via = points.length === 1 ? dim(`  → overlays/${points[0]}.md`) : '';
        console.log(`  ${cyan(file.rel)}${via}`);
        if (points.length === 1) wanted.add(points[0]);
        for (const l of lost.slice(0, SHOWN)) {
            const target = points.length > 1 ? overlayFor(l.title, points, manifest) : null;
            if (target) wanted.add(target);
            const where = target ? dim(` → overlays/${target}.md`) : '';
            console.log(
                `      ${l.title.slice(0, 44).padEnd(44)} ${String(l.lines).padStart(4)} lines  ${dim(`${l.carried}% carried`)}${where}`,
            );
        }
        if (lost.length > SHOWN) console.log(dim(`      … and ${lost.length - SHOWN} smaller section(s)`));
        console.log('');
    }

    if (wanted.size) {
        console.log(`  ${bold('Write these before rendering:')}`);
        for (const name of wanted) {
            console.log(`    ${cyan(`.cycle/overlays/${name}.md`)}`);
            if (manifest[name]?.purpose) console.log(dim(`      ${manifest[name].purpose}`));
            if (manifest[name]?.shape) console.log(dim(`      shape: ${manifest[name].shape}`));
        }
        console.log('');
    }

    // The blunt version, because the previous behaviour here was a green tick.
    console.log(dim('  This is a heuristic — a section the template rewrote in its own words reads as'));
    console.log(dim('  carried; one it never knew about reads as lost. Read them before deciding.'));
    console.log(dim('  Content that is genuinely portable belongs UPSTREAM, not in an overlay.'));
    console.log(`\n  ${yellow('`cycle update` will not warn you again — it just writes.')}`);
}

function report(label, value, source) {
    console.log(`  ${green('✓')} ${label.padEnd(10)} ${value}  ${dim(`(${source})`)}`);
}

/** Smallest profile that covers what the repo already has. */
function pickProfile(existing, loadProfile) {
    for (const name of ['lean', 'standard', 'full']) {
        const p = loadProfile(name);
        if ((p.skills ?? []).filter((s) => existing.includes(s)).length >= existing.length - 2) return name;
    }
    return 'full';
}

/** Map an extracted status table onto the three the skills transition between. */
function guessStatusMap(statuses) {
    const find = (re) => statuses.find((s) => re.test(s.name))?.name;
    return {
        pickable: find(/todo|ready/i) ?? statuses[0]?.name ?? 'Todo',
        active: find(/progress|in-progress/i) ?? statuses[1]?.name ?? 'In Progress',
        done: find(/done|review/i) ?? statuses.at(-1)?.name ?? 'Done',
    };
}

const stripUndefined = (o) => JSON.parse(JSON.stringify(o));
