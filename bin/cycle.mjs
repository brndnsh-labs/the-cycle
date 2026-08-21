#!/usr/bin/env node
// cycle — render the-cycle's work pipeline into a repo, and keep it honest.
//
// Zero dependencies, Node ESM. The CLI is this file plus one lazily-imported
// sibling (lint.mjs), resolved relative to this file — it is installed via a
// symlink from ~/.local/bin (see install.sh), and relative sibling imports
// survive that with no module-resolution games.
//
// Commands: install · update · check · eject · render (debug)
//
// A note on provenance. Each rendered file carries a comment recording the template
// it came from and a hash of its own content. The upstream commit is deliberately
// NOT in that comment — if it were, every commit to the-cycle would rewrite every
// file in every consuming repo and produce pure-noise diffs. The sha lives once in
// .cycle/state.json, and "upstream drift" is computed the useful way: by re-rendering
// and reporting which files would actually change.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as nodeUtil from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CYCLE_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const supportsColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
// util.styleText arrived after the initial Node 20 release. Keep the declared
// >=20 floor honest instead of crashing during module evaluation on early 20.x.
const paint = (style, s) => (supportsColor && nodeUtil.styleText ? nodeUtil.styleText(style, s) : s);
const bold = (s) => paint('bold', s);
const dim = (s) => paint('dim', s);
const red = (s) => paint('red', s);
const green = (s) => paint('green', s);
const yellow = (s) => paint('yellow', s);
const cyan = (s) => paint('cyan', s);

class CycleError extends Error {}

const fail = (msg, hint) => {
    throw new CycleError(hint ? `${msg}\n  ${dim(hint)}` : msg);
};

// ---------------------------------------------------------------------------
// JSONC — comments and trailing commas, without a dependency
// ---------------------------------------------------------------------------

/** Strip // and /* *\/ comments that are not inside a string literal. */
export function stripJsonComments(text) {
    let out = '';
    let inString = false;
    let inLine = false;
    let inBlock = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (inLine) {
            if (c === '\n') { inLine = false; out += c; }
            continue;
        }
        if (inBlock) {
            if (c === '*' && next === '/') { inBlock = false; i++; }
            continue;
        }
        if (inString) {
            out += c;
            if (c === '\\') { out += next ?? ''; i++; continue; }
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === '/' && next === '/') { inLine = true; i++; continue; }
        if (c === '/' && next === '*') { inBlock = true; i++; continue; }
        out += c;
    }
    // trailing commas before } or ]
    return out.replace(/,(\s*[}\]])/g, '$1');
}

export function readJsonc(path) {
    if (!existsSync(path)) fail(`not found: ${path}`);
    const raw = readFileSync(path, 'utf8');
    try {
        return JSON.parse(stripJsonComments(raw));
    } catch (e) {
        fail(`invalid JSONC in ${path}`, e.message);
    }
}

function readJson(path) {
    const raw = readFileSync(path, 'utf8');
    try {
        return JSON.parse(raw);
    } catch (e) {
        fail(`invalid JSON in ${path}`, e.message);
    }
}

// ---------------------------------------------------------------------------
// template engine
// ---------------------------------------------------------------------------
//
// Supported tags:
//   {{a.b.c}}              scalar; arrays join with ", "
//   {{a.b|join: · }}       scalar with an explicit separator
//   {{#if a.b}}…{{/if}}    truthy block (non-empty array/string, not false/null)
//   {{#unless a.b}}…{{/unless}}
//   {{#each list}}…{{.}}…{{/each}}     {{.}} is the item; {{.field}} indexes it
//   {{> overlay:name}}     inject .cycle/overlays/name.md
//   {{@verb "arg"}}        expand a backend verb; $1..$9 are the args
//
// `${{ … }}` passes through untouched so GitHub Actions expressions survive.
// An unresolved path is a hard error — a silently-empty skill is worse than a
// failed render.

const BLOCK_OPENERS = new Set(['if', 'unless', 'each']);

function resolvePath(ctx, path) {
    if (path === '.') return ctx.__item;
    let cur = path.startsWith('.') ? ctx.__item : ctx;
    const parts = (path.startsWith('.') ? path.slice(1) : path).split('.').filter(Boolean);
    for (const p of parts) {
        if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, p)) return undefined;
        cur = cur[p];
    }
    return cur;
}

function truthy(v) {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.trim() !== '';
    return Boolean(v);
}

/**
 * Split a verb call into its name and arguments. Quotes are PRESERVED on the
 * arguments — `{{@issue_create "<title>"}}` should render a shell-safe
 * `--title "<title>"`, not a bare `--title <title>` that a reader might paste.
 * The verb name itself is unquoted.
 */
function splitArgs(s) {
    const out = [];
    const re = /"[^"]*"|'[^']*'|\S+/g;
    let m;
    while ((m = re.exec(s))) out.push(m[0]);
    if (out.length) out[0] = out[0].replace(/^["']|["']$/g, '');
    return out;
}

/**
 * Index of the `}}` closing the tag that opens at `open`, allowing nested tags.
 * A verb argument may itself be a lookup — `{{@set_status "<n>" "{{status.active}}"}}` —
 * so a naive indexOf('}}') would close on the inner tag and mangle the call.
 */
function findTagEnd(src, open) {
    let depth = 1;
    let i = open + 2;
    while (i < src.length - 1) {
        if (src[i] === '{' && src[i + 1] === '{') { depth++; i += 2; continue; }
        if (src[i] === '}' && src[i + 1] === '}') {
            depth--;
            if (depth === 0) return i;
            i += 2;
            continue;
        }
        i++;
    }
    return -1;
}

/**
 * A tag alone on its own line contributes no text — only its effect. Without this,
 * every {{#if}} that renders nothing leaves a blank line behind, so a skill's shape
 * would depend on which optional sections happened to apply.
 *
 * Returns the line bounds plus whether the tag is the only thing on that line.
 */
function standaloneSpan(src, tagStart, tagEnd) {
    const lineStart = src.lastIndexOf('\n', tagStart - 1) + 1;
    let lineEnd = src.indexOf('\n', tagEnd);
    if (lineEnd === -1) lineEnd = src.length;
    const standalone =
        src.slice(lineStart, tagStart).trim() === '' && src.slice(tagEnd, lineEnd).trim() === '';
    return { standalone, lineStart, lineEnd };
}

/** Find the index of the `{{/name}}` that closes the block opened at `from`. */
function findBlockEnd(src, from, name) {
    let depth = 1;
    let i = from;
    const open = new RegExp(`\\{\\{#${name}\\b`, 'g');
    const close = new RegExp(`\\{\\{/${name}\\}\\}`, 'g');
    while (depth > 0) {
        open.lastIndex = i;
        close.lastIndex = i;
        const o = open.exec(src);
        const c = close.exec(src);
        if (!c) return -1;
        if (o && o.index < c.index) { depth++; i = o.index + 2; continue; }
        depth--;
        if (depth === 0) return c.index;
        i = c.index + 2;
    }
    return -1;
}

export function renderTemplate(src, ctx, opts = {}) {
    const { where = '<template>', overlays = null, verbs = {}, depth = 0 } = opts;
    if (depth > 12) fail(`template recursion too deep in ${where}`);
    let out = '';
    let i = 0;

    while (i < src.length) {
        const open = src.indexOf('{{', i);
        if (open === -1) { out += src.slice(i); break; }

        // `${{ … }}` — GitHub Actions expression, not ours.
        if (open > 0 && src[open - 1] === '$') {
            out += src.slice(i, open + 2);
            i = open + 2;
            continue;
        }

        const close = findTagEnd(src, open);
        if (close === -1) fail(`unclosed {{ in ${where}`, src.slice(open, open + 60));
        // rawTag keeps surrounding whitespace: a `join:` separator may legitimately
        // end in a space ({{brakes|join: · }} means " · ", not "·").
        const rawTag = src.slice(open + 2, close);
        const tag = rawTag.trim();
        const after = close + 2;

        // Block and partial tags obey the standalone-line rule; scalars never do
        // (a value alone on a line is content, and its line must survive).
        const structural = /^[#/>]/.test(tag);
        const span = structural ? standaloneSpan(src, open, after) : { standalone: false };
        out += src.slice(i, span.standalone ? span.lineStart : open);

        // ---- block tags -------------------------------------------------
        if (tag.startsWith('#')) {
            const [kw, ...rest] = tag.slice(1).split(/\s+/);
            if (!BLOCK_OPENERS.has(kw)) fail(`unknown block {{#${kw}}} in ${where}`);
            const path = rest.join(' ').trim();
            const endIdx = findBlockEnd(src, after, kw);
            if (endIdx === -1) fail(`missing {{/${kw}}} in ${where}`);

            const closeEnd = endIdx + `{{/${kw}}}`.length;
            const closeSpan = standaloneSpan(src, endIdx, closeEnd);
            const bodyStart = span.standalone ? span.lineEnd + 1 : after;
            const bodyEnd = closeSpan.standalone ? closeSpan.lineStart : endIdx;
            const body = src.slice(bodyStart, Math.max(bodyStart, bodyEnd));
            const value = resolvePath(ctx, path);

            if (kw === 'each') {
                if (value !== undefined && !Array.isArray(value)) {
                    fail(`{{#each ${path}}} in ${where} is not a list`);
                }
                for (const item of value ?? []) {
                    out += renderTemplate(body, { ...ctx, __item: item }, { ...opts, depth: depth + 1 });
                }
            } else {
                const want = kw === 'if';
                if (truthy(value) === want) {
                    out += renderTemplate(body, ctx, { ...opts, depth: depth + 1 });
                }
            }
            i = closeSpan.standalone ? closeSpan.lineEnd + 1 : closeEnd;
            continue;
        }

        if (tag.startsWith('/')) fail(`stray ${`{{${tag}}}`} in ${where}`);

        // ---- overlay injection -------------------------------------------
        // `overlay:name`  — required; a missing file is a hard error.
        // `overlay?:name` — optional; a missing file renders nothing. For sections a
        //                   repo may legitimately not have (no track-specific DoD,
        //                   no dependency landmines yet).
        if (tag.startsWith('>')) {
            const ref = tag.slice(1).trim();
            const m = /^overlay(\?)?:(.+)$/.exec(ref);
            if (!m) fail(`unknown partial "${ref}" in ${where}`);
            const optional = m[1] === '?';
            const name = m[2].trim();
            if (!overlays) fail(`overlay "${name}" requested outside a repo render (${where})`);
            const file = join(overlays, `${name}.md`);
            const resume = span.standalone ? span.lineEnd + 1 : after;
            if (!existsSync(file)) {
                if (optional) { i = resume; continue; }
                fail(
                    `${where} needs overlay "${name}", which does not exist`,
                    `create ${relative(process.cwd(), file)} — see docs/AUTHORING.md`,
                );
            }
            out += renderTemplate(readFileSync(file, 'utf8').trimEnd(), ctx, {
                ...opts,
                where: file,
                depth: depth + 1,
            });
            if (span.standalone) out += '\n';
            i = resume;
            continue;
        }

        // ---- backend verb -------------------------------------------------
        if (tag.startsWith('@')) {
            const [name, ...args] = splitArgs(tag.slice(1));
            const tmpl = verbs[name];
            if (tmpl === undefined) {
                fail(
                    `unknown backend verb "@${name}" in ${where}`,
                    `known verbs: ${Object.keys(verbs).sort().join(', ') || '(none)'}`,
                );
            }
            // Both the verb string and its arguments are templates: a backend can embed
            // config ("gh project item-list {{tracker.project}}"), and a call site can
            // pass one ({{@set_status "<n>" "{{tracker.status.active}}"}}).
            const sub = { ...opts, where: `backend verb @${name}`, depth: depth + 1 };
            const rendered = args.map((a) => renderTemplate(a, ctx, sub));
            let cmd = renderTemplate(tmpl, ctx, sub);
            cmd = cmd.replace(/\$(\d)/g, (_, d) => rendered[Number(d) - 1] ?? '');
            out += cmd.trim();
            i = after;
            continue;
        }

        // ---- scalar ---------------------------------------------------------
        const bar = rawTag.indexOf('|');
        const pathPart = (bar === -1 ? rawTag : rawTag.slice(0, bar)).trim();
        const filterPart = bar === -1 ? '' : rawTag.slice(bar + 1);
        const value = resolvePath(ctx, pathPart);
        if (value === undefined || value === null) {
            fail(
                `unresolved {{${tag}}} in ${where}`,
                'add it to .cycle/config.jsonc, or fix the path in the template',
            );
        }
        let sep = ', ';
        if (filterPart) {
            const m = /^\s*join:([\s\S]*)$/.exec(filterPart);
            if (!m) fail(`unknown filter "${filterPart.trim()}" in ${where}`);
            sep = m[1];
        }
        out += Array.isArray(value) ? value.join(sep) : String(value);
        i = after;
    }

    return out;
}

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

// Every managed file is markdown today, but the stamp is a comment in whatever language
// it lands in — same fields either way, only the wrapper changes. The non-markdown
// entries are what let a template render something other than prose without the
// provenance and drift machinery needing to learn a new trick.
const COMMENT = {
    '.md': ['<!-- ', ' -->'],
    '.mjs': ['// ', ''],
    '.js': ['// ', ''],
    '.sh': ['# ', ''],
};
const commentStyle = (rel) => COMMENT[extname(rel)] ?? COMMENT['.md'];

const PROV_RE = /^(?:<!--\s*|\/\/\s*|#\s*)cycle:rendered .*$/m;

const provenanceLine = (template, hash, rel) => {
    const [open, close] = commentStyle(rel);
    return `${open}cycle:rendered template=${template} hash=${hash} — managed by the-cycle; edit the template, not this file${close}`;
};

/**
 * Content with the provenance line removed — what we hash, at render and at check.
 *
 * The line's OWN newline goes with it, and any leading blank lines are dropped.
 * Otherwise a file with no frontmatter (DOCTRINE.md) keeps a leading newline the
 * pre-stamp body never had, its hash never matches, and `check` reports drift on a
 * file rendered ten seconds ago.
 */
export function stripProvenance(text) {
    return text
        .replace(/^(?:<!--\s*|\/\/\s*|#\s*)cycle:rendered .*\n?/m, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '');
}

export const hashContent = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

export function readProvenance(text) {
    const m = PROV_RE.exec(text);
    if (!m) return null;
    const template = /template=(\S+)/.exec(m[0])?.[1];
    const hash = /hash=(\S+)/.exec(m[0])?.[1];
    return template && hash ? { template, hash } : null;
}

/**
 * Insert the provenance comment after frontmatter (so the frontmatter stays the
 * first thing in the file and Claude Code parses it) and stamp the hash of the
 * final content-minus-provenance.
 */
export function stampProvenance(body, template, rel = template) {
    const hash = hashContent(stripProvenance(body));
    const line = provenanceLine(template, hash, rel);
    // Whatever must stay on line 1 stays on line 1: frontmatter (or the harness won't
    // parse the skill) and a shebang (or the kernel won't run the file).
    const head = /^---\n[\s\S]*?\n---\n/.exec(body) ?? /^#![^\n]*\n/.exec(body);
    if (head) {
        const at = head[0].length;
        return `${body.slice(0, at)}${line}\n${body.slice(at)}`;
    }
    return `${line}\n${body}`;
}

// ---------------------------------------------------------------------------
// repo + config
// ---------------------------------------------------------------------------

function git(args, cwd = process.cwd()) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
        const msg = e.stderr?.toString?.().trim() ?? '';
        if (msg) console.error(dim(`git ${args.join(' ')} failed: ${msg}`));
        return '';
    }
}

function findRepoRoot(start = process.cwd()) {
    const root = git(['rev-parse', '--show-toplevel'], start);
    if (!root) fail('not inside a git repository', 'cycle operates on a repo; run `git init` first');
    return root;
}

const configPath = (root) => join(root, '.cycle', 'config.jsonc');
const statePath = (root) => join(root, '.cycle', 'state.json');
const overlayDir = (root) => join(root, '.cycle', 'overlays');

function loadConfig(root) {
    const p = configPath(root);
    if (!existsSync(p)) {
        fail('this repo has no .cycle/config.jsonc', 'run `cycle install` first');
    }
    return readJsonc(p);
}

function loadBackend(name) {
    const p = join(CYCLE_HOME, 'backends', `${name}.jsonc`);
    if (!existsSync(p)) {
        const have = readdirSync(join(CYCLE_HOME, 'backends'))
            .filter((f) => f.endsWith('.jsonc'))
            .map((f) => basename(f, '.jsonc'));
        fail(`unknown backend "${name}"`, `available: ${have.join(', ')}`);
    }
    return readJsonc(p);
}

function loadProfile(name) {
    const p = join(CYCLE_HOME, 'profiles', `${name}.jsonc`);
    if (!existsSync(p)) {
        const have = readdirSync(join(CYCLE_HOME, 'profiles'))
            .filter((f) => f.endsWith('.jsonc'))
            .map((f) => basename(f, '.jsonc'));
        fail(`unknown profile "${name}"`, `available: ${have.join(', ')}`);
    }
    return readJsonc(p);
}

function loadHarness(name) {
    const p = join(CYCLE_HOME, 'harnesses', `${name}.jsonc`);
    if (!existsSync(p)) {
        const have = readdirSync(join(CYCLE_HOME, 'harnesses'))
            .filter((f) => f.endsWith('.jsonc'))
            .map((f) => basename(f, '.jsonc'));
        fail(`unknown harness "${name}"`, `available: ${have.join(', ')}`);
    }
    return readJsonc(p);
}

// Which harness trees a render targets. Absent/empty means "just Claude Code" — every
// config written before this field existed renders exactly as it always did.
const harnessNames = (cfg) => (cfg.harnesses?.length ? cfg.harnesses : ['claude']);

/** The `harness.*` object templates branch on — one instance per configured harness. */
function buildHarnessContext(h) {
    return {
        name: h.name,
        display: h.display,
        root: h.root,
        doctrine_path: `${h.root}/DOCTRINE.md`,
        has_menus: h.capabilities?.has_menus ?? false,
        has_subagents: h.capabilities?.has_subagents ?? false,
        attribution: h.notes?.attribution ?? '',
        ask: h.notes?.ask ?? '',
    };
}

/** False for an npm/npx install — CYCLE_HOME has no .git to probe (same signal upstreamSha() uses). */
const cycleHomeIsClone = () => !!git(['rev-parse', '--short', 'HEAD'], CYCLE_HOME);

/** config + backend semantics, as the object templates resolve paths against. */
function buildContext(cfg, backend) {
    const gates = { ...(cfg.gates ?? {}) };
    // §4 prints a block of gate commands. A repo can spell that block out itself
    // (to add explanatory inline comments); otherwise derive it from the named
    // gates, so the same command never has to be written twice and drift inside
    // one config file is impossible.
    if (!gates.commands) {
        gates.commands = Object.entries(gates)
            .filter(([, v]) => typeof v === 'string' && v.trim())
            .map(([, v]) => v);
    }
    const dependencyManifests = cfg.deps?.manifests ?? [];
    const knownLockfiles = new Set([
        'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'Cargo.lock',
        'go.sum', 'uv.lock', 'poetry.lock', 'Gemfile.lock',
    ]);
    // Configs written before deps.lockfile existed still carry the same fact in
    // deps.manifests. Preserve their meaning on the next `cycle update`.
    const inferredLockfile = dependencyManifests.find((path) => knownLockfiles.has(basename(path))) ?? '';
    const hasDependencyManager = cfg.deps?.has_manager
        ?? Boolean(cfg.deps?.outdated || dependencyManifests.length);
    return {
        ...cfg,
        gates,
        tracker: {
            ...(cfg.tracker ?? {}),
            // The whole status vocabulary as one comma-joined list, for the backend's
            // set_status verb: its ordered calls clear every status label before adding
            // the target, which keeps the successful end state mutually exclusive
            // without a read/replace cycle.
            // Derived rather than configured so the list can never disagree with the
            // table §1 renders from the same source.
            status_labels: (cfg.tracker?.statuses ?? []).map((s) => s.name).join(','),
        },
        deps: {
            has_manager: hasDependencyManager,
            outdated: '', audit: '', audit_fix: '', update: '', install: '', manifests: [],
            ...(cfg.deps ?? {}),
            lockfile: cfg.deps?.lockfile ?? inferredLockfile,
            // Pre-formatted for prose: the join filter can't wrap each item in backticks.
            manifests_md: dependencyManifests.map((m) => `\`${m}\``).join(', '),
        },
        // `backend_overrides` lets one repo correct a backend-wide default that is
        // really a per-repo fact. `auto_merge` is the motivating case: it is a
        // branch-protection property, not a forge property, and the two disagree
        // across repos on the same backend (a public repo on a Free org can be
        // protected; a private one cannot be protected at all). Backend defaults stay
        // safe-by-default, and a repo opts in only when the forge genuinely enforces
        // it — `cycle check --verify-forge` is what stops that claim from drifting.
        backend: {
            name: cfg.backend,
            ...(backend.semantics ?? {}),
            ...(cfg.backend_overrides ?? {}),
            notes: backend.notes ?? {},
        },
        profile: { name: cfg.profile, ...(cfg.profileFlags ?? {}) },
    };
}

// ---------------------------------------------------------------------------
// render plan
// ---------------------------------------------------------------------------

const templatePath = (rel) => join(CYCLE_HOME, 'templates', rel);

/**
 * Compute every file this repo should contain, as { path, rel, content, template }.
 * Pure: no writes. `install`, `update` and `check` all go through this.
 */
/**
 * Check the backend's declared requirements before rendering anything. Without this
 * a missing project number surfaces as "unresolved {{tracker.project}} in backend
 * verb @board_list" — technically true, useless as instruction.
 */
function validateConfig(root, cfg, backend) {
    const missing = Object.entries(backend.requires ?? {}).filter(([path]) => {
        const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg);
        return v === undefined || v === null || v === '';
    });
    if (missing.length) {
        const lines = missing.map(([path, why]) => `  ${bold(path)} — ${why}`).join('\n');
        fail(
            `the ${cfg.backend} backend needs ${missing.length} value(s) set in .cycle/config.jsonc:\n${lines}`,
            'set them, then re-run `cycle update`',
        );
    }

    const absentManifests = (cfg.deps?.manifests ?? []).filter((path) => !existsSync(join(root, path)));
    if (absentManifests.length) {
        fail(
            `configured dependency manifest${absentManifests.length === 1 ? '' : 's'} missing: ${absentManifests.join(', ')}`,
            'fix deps.manifests in .cycle/config.jsonc, or add the intended file, then re-run `cycle update`',
        );
    }
}

function planRender(root, cfg) {
    const backend = loadBackend(cfg.backend);
    const profile = loadProfile(cfg.profile);
    validateConfig(root, cfg, backend);
    const ctx = buildContext(cfg, backend);
    const verbs = backend.verbs ?? {};
    const overlays = overlayDir(root);
    const plan = [];

    const render = (tmplRel, outRel, extra, base = ctx) => {
        const src = templatePath(tmplRel);
        if (!existsSync(src)) fail(`missing template ${tmplRel}`, `expected at ${src}`);
        const body = renderTemplate(readFileSync(src, 'utf8'), extra ? { ...base, ...extra } : base, {
            where: tmplRel,
            overlays,
            verbs,
        });
        // An absent optional overlay or a false {{#if}} leaves its blank lines
        // behind; collapse them so output doesn't depend on which sections applied.
        const tidy = `${body.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
        plan.push({
            rel: outRel,
            path: join(root, outRel),
            content: stampProvenance(tidy, tmplRel, outRel),
            template: tmplRel,
        });
    };

    // One full skill tree per configured harness (default: just Claude Code). The
    // doctrine spine and every skill are identical prose across harnesses — only the
    // output root and the {{harness.*}} branches inside the templates differ.
    for (const name of harnessNames(cfg)) {
        const harness = loadHarness(name);
        const harnessCtx = { ...ctx, harness: buildHarnessContext(harness) };
        render('DOCTRINE.md.tmpl', join(harness.root, 'DOCTRINE.md'), undefined, harnessCtx);
        for (const skill of profile.skills ?? []) {
            render(join('skills', `${skill}.md.tmpl`), join(harness.root, skill, harness.skill_file), undefined, harnessCtx);
        }
    }

    // A render is markdown and nothing else. Backends used to also declare `shims` —
    // executables rendered into the repo to reach a canonical script in the-cycle's
    // helpers/ — but that existed only for the Projects v2 board, and retiring the
    // board retired the whole mechanism along with helpers/ and shim.mjs.tmpl.
    return plan;
}

// ---------------------------------------------------------------------------
// diffing
// ---------------------------------------------------------------------------

/** Line diff via LCS. Files here are ~200 lines; O(n·m) is free. */
export function lineDiff(a, b) {
    const x = a.split('\n');
    const y = b.split('\n');
    const n = x.length;
    const m = y.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (x[i] === y[j]) { ops.push([' ', x[i]]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', x[i]]); i++; }
        else { ops.push(['+', y[j]]); j++; }
    }
    while (i < n) ops.push(['-', x[i++]]);
    while (j < m) ops.push(['+', y[j++]]);
    return {
        ops,
        added: ops.filter((o) => o[0] === '+').length,
        removed: ops.filter((o) => o[0] === '-').length,
    };
}

function printDiff(rel, a, b, { context = 2 } = {}) {
    const { ops, added, removed } = lineDiff(a, b);
    console.log(`${bold(rel)}  ${green(`+${added}`)} ${red(`-${removed}`)}`);
    const keep = new Set();
    ops.forEach((op, idx) => {
        if (op[0] === ' ') return;
        for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep.add(k);
    });
    let lastShown = -1;
    for (let idx = 0; idx < ops.length; idx++) {
        if (!keep.has(idx)) continue;
        if (lastShown !== -1 && idx > lastShown + 1) console.log(dim('   …'));
        const [kind, text] = ops[idx];
        const line = `${kind} ${text}`;
        console.log(kind === '+' ? green(line) : kind === '-' ? red(line) : dim(line));
        lastShown = idx;
    }
    console.log();
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const upstreamSha = () => {
    const sha = git(['rev-parse', '--short', 'HEAD'], CYCLE_HOME);
    if (sha) {
        const dirty = git(['status', '--porcelain'], CYCLE_HOME);
        return dirty ? `${sha}-dirty` : sha;
    }
    // No .git here — an npm/npx install, not a clone. Fall back to the package
    // version rather than reporting "unknown" for every render this copy ever does.
    try {
        const pkg = JSON.parse(readFileSync(join(CYCLE_HOME, 'package.json'), 'utf8'));
        if (pkg.version) return `v${pkg.version}`;
    } catch {
        /* fall through */
    }
    return 'unknown';
};

function writeState(root, plan) {
    const files = {};
    for (const f of plan) files[f.rel] = readProvenance(f.content)?.hash ?? '';
    const state = { upstream: upstreamSha(), files };
    writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

function readState(root) {
    const p = statePath(root);
    if (!existsSync(p)) return null;
    return readJson(p);
}

// ---------------------------------------------------------------------------
// inspection: what does this repo look like?
// ---------------------------------------------------------------------------

/**
 * Package-manager commands, keyed by the lockfile that identifies the ecosystem.
 *
 * /dep-update used to spell `npm outdated` into its prose, which made the one skill in
 * the set that couldn't be installed in a repo written in anything else — and did it in
 * exactly the way docs/AUTHORING.md uses as its cautionary example.
 *
 * Order matters: the first match wins, so more specific lockfiles come first.
 */
const ECOSYSTEMS = [
    ['pnpm-lock.yaml', {
        outdated: 'pnpm outdated', audit: 'pnpm audit', audit_fix: 'pnpm audit --fix',
        update: 'pnpm update', install: 'pnpm install', lockfile: 'pnpm-lock.yaml', manifests: ['package.json', 'pnpm-lock.yaml'],
    }],
    ['yarn.lock', {
        outdated: 'yarn outdated', audit: 'yarn npm audit', audit_fix: '',
        update: 'yarn up', install: 'yarn install', lockfile: 'yarn.lock', manifests: ['package.json', 'yarn.lock'],
    }],
    ['package-lock.json', {
        outdated: 'npm outdated', audit: 'npm audit', audit_fix: 'npm audit fix',
        update: 'npm update', install: 'npm install', lockfile: 'package-lock.json', manifests: ['package.json', 'package-lock.json'],
    }],
    ['Cargo.toml', {
        outdated: 'cargo outdated', audit: 'cargo audit', audit_fix: '',
        update: 'cargo update', install: 'cargo build', lockfile: 'Cargo.lock', manifests: ['Cargo.toml', 'Cargo.lock'],
    }],
    ['go.mod', {
        outdated: 'go list -u -m all', audit: 'govulncheck ./...', audit_fix: '',
        update: 'go get -u ./...', install: 'go mod tidy', lockfile: 'go.sum', manifests: ['go.mod', 'go.sum'],
    }],
    ['uv.lock', {
        outdated: 'uv pip list --outdated', audit: '', audit_fix: '',
        update: 'uv lock --upgrade', install: 'uv sync', lockfile: 'uv.lock', manifests: ['pyproject.toml', 'uv.lock'],
    }],
    ['poetry.lock', {
        outdated: 'poetry show --outdated', audit: '', audit_fix: '',
        update: 'poetry update', install: 'poetry install', lockfile: 'poetry.lock', manifests: ['pyproject.toml', 'poetry.lock'],
    }],
    ['Gemfile.lock', {
        outdated: 'bundle outdated', audit: 'bundle audit', audit_fix: '',
        update: 'bundle update', install: 'bundle install', lockfile: 'Gemfile.lock', manifests: ['Gemfile', 'Gemfile.lock'],
    }],
];

const NPM_WITHOUT_LOCKFILE = {
    has_manager: true,
    outdated: 'npm outdated', audit: '', audit_fix: '',
    update: 'npm update --package-lock=false', install: 'npm install --package-lock=false',
    lockfile: '', manifests: ['package.json'],
};

const NO_DEPENDENCY_WORKFLOW = {
    has_manager: false,
    outdated: '', audit: '', audit_fix: '', update: '', install: '',
    lockfile: '', manifests: [],
};

/** Best-effort defaults so the interview is confirmations, not data entry. */
export function detect(root) {
    const out = { gates: {} };
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
        const pkg = readJson(pkgPath);
        out.name = pkg.name;
        const s = pkg.scripts ?? {};
        for (const [key, candidates] of Object.entries({
            typecheck: ['typecheck', 'type-check', 'tsc'],
            test: ['test'],
            lint: ['lint', 'check'],
        })) {
            const hit = candidates.find((c) => s[c]);
            if (hit) out.gates[key] = `npm run ${hit}`;
        }
        if (out.gates.test === 'npm run test') out.gates.test = 'npm test';
    }
    out.name ??= basename(root);

    const remote = git(['remote', 'get-url', 'origin'], root);
    if (remote) {
        out.remote = remote;
        const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
        if (m) out.slug = `${m[1]}/${m[2]}`;
    }
    // The only backend the-cycle binds today. A future addition (docs/BACKENDS.md's
    // "adding a backend" contract) restores host-sniffing here; until then there is
    // nothing to sniff for.
    out.backend = 'github';

    // A repo can already show which AI harness(es) it runs — a .claude/ tree, an
    // AGENTS.md or .agents/ tree (Codex), a .github/skills convention (Copilot CLI).
    // A guess worth confirming, like everything else here — not proof of intent.
    const harnessSignals = [
        ['.claude', 'claude'],
        ['AGENTS.md', 'codex'],
        ['.agents', 'codex'],
        [join('.github', 'skills'), 'copilot'],
    ];
    const harnesses = [...new Set(
        harnessSignals.filter(([marker]) => existsSync(join(root, marker))).map(([, h]) => h),
    )];
    if (harnesses.length) out.harnesses = harnesses;

    if (existsSync(join(root, 'scripts', 'deploy.sh'))) {
        out.deploy = { test: './scripts/deploy.sh test', prod: './scripts/deploy.sh prod' };
    }

    const ecosystem = ECOSYSTEMS.find(([marker]) => existsSync(join(root, marker)))?.[1];
    if (ecosystem) {
        out.deps = {
            ...ecosystem,
            manifests: ecosystem.manifests.filter((path) => existsSync(join(root, path))),
            lockfile: existsSync(join(root, ecosystem.lockfile)) ? ecosystem.lockfile : '',
        };
    } else if (existsSync(pkgPath)) {
        out.deps = NPM_WITHOUT_LOCKFILE;
    }
    return out;
}

// A formatter that reflows a rendered skill's markdown (prettier, dprint) changes
// only whitespace, but the drift hash is over raw bytes — so a reflow reads as a
// hand edit and permanently blocks `cycle update` until someone passes --force.
// The fix is to keep the formatter off these files entirely, not to weaken the
// hash. Detected and reported, never auto-written — same reasoning as the `gh
// label create` lines below: a command this runs should be one the operator ran
// on purpose, and a third-party tool's config isn't this command's to touch.
const PRETTIER_MARKERS = [
    '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml',
    '.prettierrc.json5', '.prettierrc.toml',
    '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.ts',
    '.prettierrc.cts', '.prettierrc.mts',
    'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
    'prettier.config.ts', 'prettier.config.cts', 'prettier.config.mts',
];
function usesPrettier(root) {
    if (PRETTIER_MARKERS.some((m) => existsSync(join(root, m)))) return true;
    const packageYamlPath = join(root, 'package.yaml');
    if (existsSync(packageYamlPath)) {
        // Prettier recognizes a top-level `prettier` key in package.yaml. Keep
        // this deliberately narrow so an unrelated nested key does not make a
        // non-Prettier repo look configured.
        const packageYaml = readFileSync(packageYamlPath, 'utf8');
        if (/^(?:prettier|["']prettier["'])\s*:/m.test(packageYaml)) return true;
    }
    const pkgPath = join(root, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const pkg = readJson(pkgPath);
    return Boolean(pkg.prettier ?? pkg.devDependencies?.prettier ?? pkg.dependencies?.prettier);
}

const DPRINT_CONFIGS = ['dprint.json', 'dprint.jsonc', '.dprint.json', '.dprint.jsonc'];
const findDprintConfig = (root) => DPRINT_CONFIGS.map((f) => join(root, f)).find((p) => existsSync(p)) ?? null;

function negationMayReincludeRoot(entry, root) {
    if (typeof entry !== 'string' || !entry.startsWith('!')) return false;
    const pattern = entry.slice(1).replace(/^\/+/, '');
    if (pattern === root || pattern.startsWith(`${root}/`)) return true;

    // A slashless gitignore pattern applies at any depth. Managed harness trees
    // contain markdown only, so a literal non-markdown basename (for example
    // `!dist.js`) is provably unrelated; wildcard or markdown patterns are not.
    if (!pattern.includes('/')) return /[*?\[]/.test(pattern) || pattern.endsWith('.md');

    // For globbed paths, compare the literal prefix on either side of the first
    // wildcard. An empty prefix (`!**/DOCTRINE.md`) may match anywhere.
    const wildcard = pattern.search(/[*?\[]/);
    if (wildcard === -1) return false;
    const prefix = pattern.slice(0, wildcard);
    return prefix === '' || root.startsWith(prefix) || prefix.startsWith(`${root}/`);
}

function ignorePatternsCoverRoot(patterns, root) {
    let covered = false;
    for (const rawEntry of patterns) {
        const entry = typeof rawEntry === 'string' ? rawEntry.trim() : rawEntry;
        if (entry === root || entry === `${root}/` || entry === `${root}/**`) {
            covered = true;
            continue;
        }
        // Both formatter ignore formats use ordered gitignore-style patterns. A
        // relevant later negation reopens the tree; a later exact whole-tree
        // exclude restores coverage.
        if (covered && negationMayReincludeRoot(entry, root)) covered = false;
    }
    return covered;
}

/**
 * Missing formatter-ignore entries for the currently configured harness roots, as
 * ready-to-paste blocks — or `[]` if every detected formatter already covers them
 * (or none is detected). Best-effort: a malformed dprint config is reported as
 * "can't verify", never a crash.
 */
function formatterGuidance(root, cfg) {
    const roots = harnessNames(cfg).map((h) => loadHarness(h).root);
    const blocks = [];

    if (usesPrettier(root)) {
        const ignorePath = join(root, '.prettierignore');
        const have = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8').split('\n') : [];
        const missing = roots.filter((r) => !ignorePatternsCoverRoot(have, r));
        if (missing.length) {
            blocks.push([
                'prettier reformats markdown here, which will fight `cycle update`\'s drift detection.',
                `add these lines to ${relative(root, ignorePath)} (create it if missing):`,
                ...missing.map((r) => `  ${r}/`),
            ]);
        }
    }

    const dprintPath = findDprintConfig(root);
    if (dprintPath) {
        let excludes = [];
        try {
            const parsed = readJsonc(dprintPath);
            excludes = Array.isArray(parsed.excludes) ? parsed.excludes : [];
        } catch {
            blocks.push([`dprint config at ${relative(root, dprintPath)} could not be parsed — check its "excludes" by hand.`]);
            excludes = null;
        }
        if (excludes) {
            // Only a glob that denotes the whole subtree counts as coverage — a prefix
            // match like `startsWith` would also accept `.claude/skills/README.md`,
            // which excludes one file and leaves every actual SKILL.md (nested one
            // level deeper) still exposed to reflow. Erring toward an extra reminder
            // beats erring toward a silent gap.
            const missing = roots.filter((r) => !ignorePatternsCoverRoot(excludes, r));
            if (missing.length) {
                blocks.push([
                    'dprint reformats markdown here, which will fight `cycle update`\'s drift detection.',
                    `add these globs to ${relative(root, dprintPath)}'s "excludes" array:`,
                    ...missing.map((r) => `  "${r}/**"`),
                ]);
            }
        }
    }

    return blocks;
}

function printFormatterGuidance(blocks) {
    if (!blocks.length) return;
    console.log(`\n${yellow('formatter:')} a reflow-only edit will read as local drift until this is addressed —`);
    for (const block of blocks) {
        for (const line of block) console.log(`  ${dim(line)}`);
        console.log('');
    }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

// Starting points only — a repo edits these in config.jsonc. These are label names;
// the `status:` prefix namespaces them away from `bug`/`enhancement`/`backlog` and
// makes the set clearable as a group. Keyed by backend (rather than a flat array) so
// a future backend with its own natural vocabulary drops in alongside this one
// instead of overwriting it.
//
// There is deliberately no `status:done`: a closed issue is done (§1), so the last
// transition the pipeline writes is in-review, and the merge's `Closes #n` finishes
// the story. A Done state would be a second source of truth that can disagree with
// the close — which is exactly what went stale on the board this replaced.
const DEFAULT_STATUSES = {
    github: [
        { name: 'status:ready', meaning: 'scoped + pickable', action: '`/next` ranks & picks; `/implement`/`/cycle` build' },
        { name: 'status:in-progress', meaning: 'being built', action: "don't re-pick" },
        { name: 'status:in-review', meaning: 'built, under review / PR open', action: "don't re-pick" },
        { name: 'status:blocked', meaning: 'blocked on a dependency', action: 'skip; name the blocker' },
        { name: 'status:needs-decision', meaning: 'blocked on a human call', action: "surface it; **don't build**" },
    ],
};

/**
 * The config a fresh install starts from: everything `detect` could infer, plus
 * defensible defaults for everything it couldn't. Shared by the interview and by
 * `--plan`, so a guided setup and a manual one begin from exactly the same draft.
 */
function applyConfigSets(cfg, sets = []) {
    for (const assignment of sets) {
        const equals = assignment.indexOf('=');
        const path = equals < 1 ? '' : assignment.slice(0, equals);
        if (!path || equals === assignment.length - 1) {
            fail(`invalid --set value "${assignment}"`, 'use `--set path=value`');
        }
        const keys = path.split('.');
        let parent = cfg;
        for (const key of keys.slice(0, -1)) {
            if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) {
                fail(`unknown config path "${path}"`, 'use a dotted path from the install draft');
            }
            parent = parent[key];
        }
        const leaf = keys.at(-1);
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, leaf)) {
            fail(`unknown config path "${path}"`, 'use a dotted path from the install draft');
        }
        const raw = assignment.slice(equals + 1);
        try { parent[leaf] = JSON.parse(raw); } catch { parent[leaf] = raw; }
    }
    return cfg;
}

export function draftConfig(root, { backend: wanted, profile, set } = {}) {
    const d = detect(root);
    const backend = wanted ?? d.backend;
    const cfg = {
        // First name only — the skills address this person directly, dozens of times
        // per file ("ask Brandon", "on his nod"); a full name reads like a form.
        repo: {
            name: d.name,
            slug: d.slug ?? '',
            human: (git(['config', 'user.name'], root) || 'the maintainer').split(/\s+/)[0],
        },
        profile: profile ?? 'lean',
        backend,
        // Which harness trees to render. Detected from filesystem markers when
        // present (see `detect`), else Claude Code only. See harnesses/*.jsonc and
        // docs/HARNESSES.md.
        harnesses: d.harnesses ?? ['claude'],
        tracker: {
            description: `**GitHub issues** (\`${d.slug ?? ''}\`)`,
            statuses: DEFAULT_STATUSES[backend] ?? DEFAULT_STATUSES.github,
            // The four the skills actually write, named separately so a repo can
            // rename its vocabulary without the skills caring.
            status: { pickable: 'status:ready', active: 'status:in-progress', done: 'status:in-review', decision: 'status:needs-decision' },
            ranking: '**milestone first** (a real numbered epic beats no milestone), then **issue number** (lower first)',
            milestones: [],
        },
        routing: {
            model: "Use the active harness's default model unless the task explicitly requires another.",
            executor_default: 'orchestrator-inline',
        },
        gates: Object.keys(d.gates).length ? d.gates : { typecheck: 'npm run typecheck', test: 'npm test' },
        // /dep-update's package-manager commands. Detected from an ecosystem marker;
        // blank where the ecosystem has no equivalent (plenty have no audit-fix).
        deps: d.deps ?? NO_DEPENDENCY_WORKFLOW,
        brakes: ['auth / tokens / secrets', 'schema / data migration', 'anything destructive or irreversible'],
        branch: { minor_edits_direct: true },
        deploy: d.deploy ?? { test: '', prod: '' },
    };
    return { cfg: applyConfigSets(cfg, set), detected: d };
}

async function cmdInstall(args) {
    const root = findRepoRoot();
    const { values } = parseArgs({
        args,
        options: {
            profile: { type: 'string' },
            backend: { type: 'string' },
            set: { type: 'string', multiple: true },
            yes: { type: 'boolean', short: 'y' },
            plan: { type: 'boolean' },
        },
        allowPositionals: true,
    });

    if (values.plan) return cmdPlan(root, values);

    if (existsSync(configPath(root)) && !values.yes) {
        fail('this repo already has .cycle/config.jsonc', 'use `cycle update` to re-render, or pass --yes to overwrite');
    }

    const { cfg } = draftConfig(root, { backend: values.backend, profile: values.profile, set: values.set });

    if (!values.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ask = async (q, def) => (await rl.question(`${q} ${dim(`[${def}]`)} `)).trim() || def;
        console.log(bold('\nSetting up the-cycle. Enter accepts the detected value.\n'));
        cfg.repo.name = await ask('Repo display name', cfg.repo.name);
        cfg.repo.human = await ask('Who does this pipeline interrupt?', cfg.repo.human);
        cfg.profile = await ask('Profile (lean/standard/full)', cfg.profile);
        const harnesses = await ask('Harnesses (comma-separated, from the registry)', cfg.harnesses.join(', '));
        cfg.harnesses = harnesses.split(',').map((s) => s.trim()).filter(Boolean);
        // No interactive question for backend itself: github is the only one the-cycle
        // binds today, so asking would be a confirm-the-only-answer prompt. `--backend`
        // still overrides it (draftConfig above), for whenever a second one exists.
        for (const [path, why] of Object.entries(loadBackend(cfg.backend).requires ?? {})) {
            const keys = path.split('.');
            const leaf = keys.pop();
            const parent = keys.reduce((o, k) => (o[k] ??= {}), cfg);
            parent[leaf] = await ask(`${path} — ${why}`, parent[leaf] ?? '');
        }
        cfg.gates.typecheck = await ask('Typecheck gate', cfg.gates.typecheck ?? '');
        cfg.gates.test = await ask('Test gate', cfg.gates.test ?? '');
        const brakes = await ask('Always-brake surfaces (comma-separated)', cfg.brakes.join(', '));
        cfg.brakes = brakes.split(',').map((s) => s.trim()).filter(Boolean);
        rl.close();
    }

    loadProfile(cfg.profile);
    loadBackend(cfg.backend);
    for (const h of harnessNames(cfg)) loadHarness(h);

    mkdirSync(join(root, '.cycle'), { recursive: true });
    mkdirSync(overlayDir(root), { recursive: true });
    writeFileSync(configPath(root), renderConfig(cfg));

    const plan = planRender(root, cfg);
    for (const f of plan) {
        mkdirSync(dirname(f.path), { recursive: true });
        writeFileSync(f.path, f.content);
    }
    writeState(root, plan);

    console.log(`\n${green('✓')} rendered ${bold(String(plan.length))} files from the-cycle@${upstreamSha()}`);
    for (const f of plan) console.log(`  ${dim(f.rel)}`);
    console.log(`\n${dim('next:')} review .cycle/config.jsonc, then commit. \`cycle check\` reports drift.`);

    // The status vocabulary is labels, and `gh` errors on a label the repo doesn't
    // have — loudly, which is the behaviour we want, but only if these exist. Printed
    // rather than created: `install` renders files and touches no network, and the
    // one place that rule bends should be a command the operator ran on purpose.
    const statuses = cfg.tracker?.statuses ?? [];
    if (statuses.length) {
        console.log(`\n${dim('labels:')} the status vocabulary must exist in the repo — create any that don't:`);
        for (const s of statuses) {
            console.log(`  ${dim(`gh label create "${s.name}" --description ${JSON.stringify(s.meaning ?? '')} --force`)}`);
        }
    }

    printFormatterGuidance(formatterGuidance(root, cfg));

    if (!cycleHomeIsClone()) {
        console.log(
            `${dim('note:')} this ran from an npm/npx install, not a durable clone. The rendered skills ` +
                'stand alone and will keep working, but `cycle update`/`check` and the /cycle-setup ' +
                `skill need the-cycle on disk — clone it to ${bold(join(homedir(), 'code', 'the-cycle'))} ` +
                'and run install.sh (or export CYCLE_HOME).',
        );
    }
}

/**
 * `cycle install --plan` — everything a guided setup needs, as JSON on stdout.
 *
 * The split matters: this command decides *what must be known*, and something with
 * judgment decides *what the answers are*. The renderer stays pure and testable, and
 * a model filling this in can never emit a skill — only data the renderer consumes.
 * It writes nothing, so running it is always safe.
 */
function cmdPlan(root, values) {
    const { cfg, detected } = draftConfig(root, { backend: values.backend, profile: values.profile, set: values.set });
    const backend = loadBackend(cfg.backend);
    const profiles = readdirSync(join(CYCLE_HOME, 'profiles'))
        .filter((f) => f.endsWith('.jsonc'))
        .map((f) => basename(f, '.jsonc'));
    const harnesses = readdirSync(join(CYCLE_HOME, 'harnesses'))
        .filter((f) => f.endsWith('.jsonc'))
        .map((f) => basename(f, '.jsonc'));

    const overlayManifest = existsSync(templatePath('overlays.jsonc')) ? readJsonc(templatePath('overlays.jsonc')) : {};

    console.log(JSON.stringify({
        root,
        existing_config: existsSync(configPath(root)) ? relative(root, configPath(root)) : null,
        // What the filesystem and git could tell us. Everything here is a guess worth
        // confirming, not a fact — `name` comes from package.json, which is often the
        // npm slug rather than what a person calls the project.
        detected: {
            name: detected.name,
            slug: detected.slug ?? null,
            remote: detected.remote ?? null,
            backend: detected.backend,
            gates: detected.gates,
            deploy: detected.deploy ?? null,
            harnesses: detected.harnesses ?? null,
        },
        draft: cfg,
        // The decisions a draft cannot make for itself.
        questions: [
            {
                path: 'profile',
                asks: 'How much machinery should this repo take on?',
                why: 'Machinery is opt-in — a repo should take a lane when it has earned it, not by default. Start lean unless the repo already does the thing.',
                options: profiles,
                default: cfg.profile,
            },
            {
                path: 'harnesses',
                asks: 'Which AI coding harnesses should this pipeline render into?',
                why: 'Each configured harness gets its own complete, independent skill tree — same doctrine, same procedure, only the discovery root and harness-conditional prose differ. Detect what the repo already runs: a .claude/ tree suggests Claude Code, AGENTS.md or a .agents/ tree suggests Codex, a .github/ convention suggests Copilot CLI. Multiple can be configured together.',
                options: harnesses,
                default: cfg.harnesses,
            },
            {
                path: 'repo.human',
                asks: 'Who does this pipeline interrupt?',
                why: 'Skills address this person directly and often. A first name reads right; a full name reads like a form.',
                default: cfg.repo.human,
            },
            {
                path: 'gates',
                asks: 'What must pass before work is done?',
                why: 'Read from package.json scripts when present. Verify they actually run here, and add any gate the project has that a script name would not reveal.',
                default: cfg.gates,
            },
            {
                path: 'brakes',
                asks: 'What surfaces must never be changed without asking first?',
                why: 'The always-stop list in DOCTRINE §5. Derive it from what this codebase can actually break irreversibly — auth, migrations, money, anything user-visible and destructive. Generic defaults are close to useless here.',
                default: cfg.brakes,
            },
            {
                path: 'tracker.statuses',
                asks: 'What is the status vocabulary, and what does each value mean?',
                why: 'The table skills read to decide what is pickable. Each `name` is a real label on the issue, and the set is cleared as a group on every transition, so keep the shared `status:` prefix. The labels must exist in the repo — `cycle install` prints the `gh label create` lines.',
                default: cfg.tracker.statuses,
            },
            ...Object.entries(backend.requires ?? {}).map(([path, why]) => ({
                path,
                asks: `${path} is required by the ${cfg.backend} backend`,
                why,
                default: path.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg) ?? null,
            })),
        ],
        // Optional by design: an install with no overlays renders a complete pipeline.
        // These are where a repo says the things only it can say.
        overlays: Object.entries(overlayManifest).map(([name, o]) => ({
            name,
            path: relative(root, join(overlayDir(root), `${name}.md`)),
            exists: existsSync(join(overlayDir(root), `${name}.md`)),
            ...o,
        })),
        write: {
            config: relative(root, configPath(root)),
            overlays_dir: relative(root, overlayDir(root)),
            then: 'cycle update',
        },
    }, null, 2));
}

/** config.jsonc with comments, so the file explains itself when Brandon opens it. */
function renderConfig(cfg) {
    return `// the-cycle bindings for this repo.
// Everything repo-specific lives here; the skills in configured harness trees are rendered
// from shared templates and should not be hand-edited (\`cycle check\` will tell you
// if they have been). Re-render with \`cycle update\` after changing this file.
${JSON.stringify(cfg, null, 2)}
`;
}

/**
 * Verify forge-facts declared in config against the live forge.
 *
 * Opt-in, and deliberately NOT part of a plain `cycle check`: rendering and drift
 * detection stay offline and deterministic, so they work on a plane and produce the
 * same answer for everyone. This is the one place the tool looks outward.
 *
 * Returns a list of human-readable mismatches. A probe that cannot run (no `gh`, not
 * authenticated, no network) is reported as a skip, never as a mismatch — an
 * unanswerable question must not read as a failed answer.
 */
export function verifyForge(cfg, { exec = execFileSync } = {}) {
    const problems = [];
    const slug = cfg.repo?.slug;
    if (cfg.backend !== 'github') return { problems, skipped: `backend ${cfg.backend} has no forge probe` };
    if (!slug) return { problems, skipped: 'repo.slug not set in .cycle/config.jsonc' };

    let repoJson;
    try {
        repoJson = JSON.parse(
            exec('gh', ['api', `repos/${slug}`, '--jq', '{allow_auto_merge,delete_branch_on_merge}'], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            }),
        );
    } catch {
        return { problems, skipped: `could not query ${slug} (gh missing, unauthenticated, or offline)` };
    }

    const declared = Boolean(cfg.backend_overrides?.auto_merge ?? false);
    const live = Boolean(repoJson.allow_auto_merge);

    if (declared && !live) {
        problems.push(
            `auto_merge declared true but ${slug} has allow_auto_merge=false — ` +
            'the rendered doctrine tells agents to use `gh pr merge --auto`, which will error. ' +
            'Re-enable it on the repo, or drop backend_overrides.auto_merge.',
        );
    } else if (!declared && live) {
        problems.push(
            `${slug} allows auto-merge but config does not declare it — agents are running a ` +
            'polling merge guard for a job the forge would do server-side. Set ' +
            'backend_overrides.auto_merge to true (only if branch protection is configured).',
        );
    }

    // auto_merge is only SAFE with required status checks: with none, `--auto` merges
    // on the spot. Declaring it without protection is the dangerous direction, so probe
    // it specifically rather than trusting the repo flag alone.
    if (declared) {
        try {
            const contexts = JSON.parse(
                exec('gh', ['api', `repos/${slug}/branches/main/protection`, '--jq', '.required_status_checks.contexts'], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
                }),
            );
            if (!Array.isArray(contexts) || contexts.length === 0) {
                problems.push(
                    `auto_merge declared true but ${slug}'s main has no required status checks — ` +
                    '`--auto` would merge immediately with nothing to wait on. Configure required ' +
                    'checks, or drop backend_overrides.auto_merge.',
                );
            }
        } catch {
            problems.push(
                `auto_merge declared true but branch protection on ${slug} could not be read ` +
                '(often means it is not configured, or the plan does not allow it). Unverified — ' +
                'confirm before relying on it.',
            );
        }
    }

    return { problems, skipped: null };
}

function cmdCheck(args) {
    const root = findRepoRoot();
    const { values } = parseArgs({
        args,
        options: {
            quiet: { type: 'boolean', short: 'q' },
            'verify-forge': { type: 'boolean' },
        },
        allowPositionals: true,
    });
    const cfg = loadConfig(root);
    const plan = planRender(root, cfg);
    const state = readState(root);

    const local = [];
    const upstream = [];
    const missing = [];

    for (const f of plan) {
        if (!existsSync(f.path)) { missing.push(f); continue; }
        const current = readFileSync(f.path, 'utf8');
        const prov = readProvenance(current);
        if (!prov) { local.push({ ...f, why: 'no provenance header — not managed by the-cycle' }); continue; }
        if (hashContent(stripProvenance(current)) !== prov.hash) {
            local.push({ ...f, why: 'hand-edited since render' });
        }
        if (stripProvenance(current) !== stripProvenance(f.content)) {
            upstream.push({ ...f, current });
        }
    }

    const orphans = Object.keys(state?.files ?? {}).filter((rel) => !plan.some((f) => f.rel === rel));

    if (!values.quiet) {
        console.log(`${bold('the-cycle')} ${dim(`profile=${cfg.profile} backend=${cfg.backend} harnesses=${harnessNames(cfg).join(',')}`)}`);
        console.log(dim(`rendered from ${state?.upstream ?? 'unknown'}; the-cycle is now at ${upstreamSha()}\n`));
    }

    if (missing.length) {
        console.log(red(`✗ ${missing.length} file(s) missing — run \`cycle update\``));
        for (const f of missing) console.log(`    ${f.rel}`);
    }
    if (local.length) {
        console.log(yellow(`! ${local.length} file(s) locally drifted (edited in place)`));
        for (const f of local) console.log(`    ${f.rel}  ${dim(f.why)}`);
        console.log(dim('    → fold the change into the template, or `cycle eject <skill>` to own it here'));
    }
    if (upstream.length) {
        console.log(cyan(`↑ ${upstream.length} file(s) would change on re-render`));
        for (const f of upstream) {
            const { added, removed } = lineDiff(stripProvenance(f.current), stripProvenance(f.content));
            console.log(`    ${f.rel}  ${green(`+${added}`)} ${red(`-${removed}`)}`);
        }
        console.log(dim('    → `cycle update` to apply, `cycle update --dry-run` to see the diff'));
    }
    if (orphans.length) {
        console.log(dim(`· ${orphans.length} file(s) no longer in this profile: ${orphans.join(', ')}`));
    }
    if (!missing.length && !local.length && !upstream.length) {
        console.log(green('✓ clean — every managed file matches its template'));
    }

    // Forge verification is opt-in: a plain `cycle check` stays offline so it is
    // deterministic and works unauthenticated. File drift and forge drift are separate
    // failures and are reported separately, but either one fails the command.
    let forgeProblems = [];
    if (values['verify-forge']) {
        const { problems, skipped } = verifyForge(cfg);
        forgeProblems = problems;
        if (skipped) {
            console.log(dim(`· forge check skipped — ${skipped}`));
        } else if (problems.length) {
            console.log(red(`✗ ${problems.length} forge fact(s) disagree with .cycle/config.jsonc`));
            for (const p of problems) console.log(`    ${p}`);
        } else {
            console.log(green('✓ forge matches the declared config'));
        }
    }

    process.exitCode = missing.length || local.length || upstream.length || forgeProblems.length ? 1 : 0;
}

function cmdUpdate(args) {
    const root = findRepoRoot();
    const { values } = parseArgs({
        args,
        options: { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' } },
        allowPositionals: true,
    });
    const cfg = loadConfig(root);
    const plan = planRender(root, cfg);
    const guidance = formatterGuidance(root, cfg);

    const writes = [];
    const conflicts = [];

    for (const f of plan) {
        const exists = existsSync(f.path);
        const current = exists ? readFileSync(f.path, 'utf8') : null;
        if (exists && stripProvenance(current) === stripProvenance(f.content)) continue; // idempotent no-op

        if (exists) {
            const prov = readProvenance(current);
            const edited = !prov || hashContent(stripProvenance(current)) !== prov.hash;
            if (edited && !values.force) { conflicts.push({ ...f, current }); continue; }
        }
        writes.push({ ...f, current });
    }

    if (conflicts.length) {
        console.log(yellow(`! refusing to overwrite ${conflicts.length} locally-edited file(s):`));
        for (const f of conflicts) console.log(`    ${f.rel}`);
        console.log(dim('  fold the edits into the template, `cycle eject <skill>`, or re-run with --force\n'));
    }

    if (!writes.length) {
        console.log(conflicts.length ? dim('nothing else to update.') : green('✓ already up to date — nothing to write'));
        printFormatterGuidance(guidance);
        process.exitCode = conflicts.length ? 1 : 0;
        return;
    }

    for (const f of writes) {
        if (f.current) printDiff(f.rel, stripProvenance(f.current), stripProvenance(f.content));
        else console.log(`${bold(f.rel)}  ${green('new')}`);
    }

    if (values['dry-run']) {
        console.log(dim(`\n(dry run — ${writes.length} file(s) would change)`));
        printFormatterGuidance(guidance);
        return;
    }

    for (const f of writes) {
        mkdirSync(dirname(f.path), { recursive: true });
        writeFileSync(f.path, f.content);
    }
    writeState(root, plan);
    console.log(`${green('✓')} updated ${bold(String(writes.length))} file(s) to the-cycle@${upstreamSha()}`);
    printFormatterGuidance(guidance);
    if (conflicts.length) process.exitCode = 1;
}

function cmdEject(args) {
    const root = findRepoRoot();
    const [name] = args;
    if (!name) fail('usage: cycle eject <skill>');
    const cfg = loadConfig(root);

    // A repo can render this skill into more than one harness tree; eject every copy
    // that exists, so "own it here" doesn't leave a still-managed twin re-rendering
    // the ejected file's sibling tree out from under it.
    const paths = harnessNames(cfg)
        .map((n) => loadHarness(n))
        .map((h) => join(root, h.root, name, h.skill_file))
        .filter((p) => existsSync(p));
    if (!paths.length) fail(`no rendered skill "${name}" in any configured harness`);

    const state = readState(root) ?? { files: {} };
    let ejected = 0;
    for (const path of paths) {
        const text = readFileSync(path, 'utf8');
        if (!readProvenance(text)) continue; // already unmanaged in this tree
        writeFileSync(path, stripProvenance(text).replace(/^\n+/, ''));
        delete state.files[relative(root, path)];
        ejected++;
        console.log(`${green('✓')} ejected ${dim(relative(root, path))}`);
    }
    if (!ejected) fail(`${name} is already unmanaged in every configured harness`);
    writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`);

    console.log(`${bold(name)} is now yours to maintain in this repo`);
    console.log(dim(`  remove it from the "${cfg.profile}" profile, or it will be re-rendered by \`cycle update\``));
}

function cmdRender(args) {
    const root = findRepoRoot();
    const cfg = loadConfig(root);
    const plan = planRender(root, cfg);
    const [only] = args;
    for (const f of plan) {
        if (only && !f.rel.includes(only)) continue;
        console.log(`${dim(`── ${f.rel} ${'─'.repeat(Math.max(0, 60 - f.rel.length))}`)}\n${f.content}`);
    }
}

const USAGE = `${bold('cycle')} — render the-cycle's work pipeline into a repo

  ${bold('cycle install')} [--profile lean|standard|full] [--backend github] [--set path=value]... [-y]
      Interview, write .cycle/config.jsonc, render the skills.

  ${bold('cycle install --plan')}
      Print what a setup needs to decide — detected values, the open questions
      and why each matters, every overlay point — as JSON, and write nothing.
      This is what /cycle-setup reads; useful on its own to see the shape.

  ${bold('cycle check')} [-q] [--verify-forge]
      Report drift on two axes: locally edited files, and files a re-render
      would change. Exits non-zero on any drift.
      --verify-forge additionally checks facts this repo *declares* about its
      forge (backend_overrides.auto_merge) against the live repo. Opt-in
      because it needs network + auth; without it, check stays offline.

  ${bold('cycle update')} [--dry-run] [--force]
      Re-render. Shows a diff; refuses to clobber hand-edited files without --force.

  ${bold('cycle lint')} [-q]
      Check the-cycle's own consistency: §N citations, verb bindings, overlay
      docs, profiles, cross-skill references. -q hides warnings. For working
      on the-cycle itself, not on a consuming repo.

  ${bold('cycle eject')} <skill>
      Stop managing one skill; strip its provenance header.

  ${bold('cycle render')} [filter]
      Print rendered output to stdout without writing. Debugging aid.

  Renders into every harness in .cycle/config.jsonc's "harnesses" array (default
  ["claude"] — .claude/skills/). See harnesses/*.jsonc and docs/HARNESSES.md.
`;

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    switch (cmd) {
        case 'install': return cmdInstall(rest);
        case 'check': return cmdCheck(rest);
        case 'update': return cmdUpdate(rest);
        case 'eject': return cmdEject(rest);
        case 'render': return cmdRender(rest);
        case 'lint': {
            const { cmdLint } = await import('./lint.mjs');
            return cmdLint(rest, { CYCLE_HOME, bold, dim, red, yellow, green });
        }
        case undefined:
        case '-h':
        case '--help': console.log(USAGE); return;
        case '--version': console.log(upstreamSha()); return;
        default: fail(`unknown command "${cmd}"`, 'run `cycle --help`');
    }
}

// Only run as a CLI when invoked directly. install.sh symlinks this file into
// ~/.local/bin, so argv[1] is the symlink — compare real paths, not literal ones.
function invokedDirectly() {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (invokedDirectly()) {
    main().catch((e) => {
        if (e instanceof CycleError) {
            console.error(`${red('✗')} ${e.message}`);
            process.exit(1);
        }
        console.error(e.stack ?? String(e));
        process.exit(1);
    });
}
