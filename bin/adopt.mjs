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

    // A dry render surfaces missing overlays as errors, which is the most useful
    // next instruction adopt can give.
    try {
        planRender(root, stripUndefined(cfg));
        console.log(`${green('✓')} renders cleanly — run \`cycle update --dry-run\` to see the diffs`);
    } catch (e) {
        console.log(`${yellow('!')} render is not satisfiable yet:`);
        console.log(`    ${e.message.split('\n').join('\n    ')}`);
    }
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
