#!/usr/bin/env node
//
// forgejo-merge.mjs — the poll-then-merge guard for the Forgejo-backed pipeline.
//
// Replaces the inline `gh pr checks --watch --fail-fast && gh pr merge` snippet
// (DOCTRINE §6). Forgejo Actions has NO server-side auto-merge-on-green, so — as on
// GitHub — the guard IS the enforcement: wait for CI to REGISTER, block until it
// FINISHES, and merge (squash + delete branch) ONLY if the combined commit-status is
// `success`. On failure it surfaces each failing check's run URL, prints the tail of
// that job's log (via fj-ex — see ci-logs.sh), and exits non-zero.
//
// Run it in the BACKGROUND (the poll takes minutes; a foreground sleep is harness-
// blocked). The merge gate is the verified `GET /commits/{sha}/status` endpoint:
// combined `state` (success|pending|failure|error) + per-job `statuses[]`
// ({context, state, target_url}) — the `gh statusCheckRollup` replacement.
//
// Usage:
//   node scripts/forgejo-merge.mjs <pr#>                        # poll → merge on green
//   node scripts/forgejo-merge.mjs <pr#> --dry-run              # poll + decide, but never merge
//   node scripts/forgejo-merge.mjs <pr#> --closes 517,519       # close exactly this set on merge
//   node scripts/forgejo-merge.mjs <pr#> --closes none          # close NOTHING (suppresses the body-regex fallback —
//                                                               # required for multi-phase PRs whose body mentions closing later)
//                                                                # (skips the PR-body regex scan)
//   node scripts/forgejo-merge.mjs poll  <sha>                  # just print the combined status once
//   node scripts/forgejo-merge.mjs watch <sha>                  # poll a sha to a terminal state, no merge
//
// Auth/env: same as forgejo-project.mjs (FORGEJO_API / FORGEJO_TOKEN[_FILE] / FORGEJO_REPO).
// Tunables: FJ_POLL_SECS (5), FJ_REGISTER_TIMEOUT_SECS (300), FJ_FINISH_TIMEOUT_SECS (2400).
//
// Exit codes: 0 merged (or dry-run would-merge / already-merged) · 1 CI failed —
// not merged · 2 timed out waiting · 3 Forgejo unreachable.
//
// Closes referenced issues itself after a successful merge (#517): a squash merge via
// this API carries only the PR title into the merge commit, not the PR body, so
// Forgejo's own `Closes #<n>` keyword scan (which keys off the merge commit message)
// never sees the reference and the issue is left open. Explicit close sidesteps that
// entirely rather than depending on undocumented keyword-scan behavior.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// No hardcoded host: the rendered shim passes FORGEJO_API from .cycle/config.jsonc,
// and failing that we derive it from this checkout's own origin. A baked-in default
// would point every repo at one person's instance — the same class of bug as the
// default repo slug that misfiled 7 issues on 2026-07-22.
const API = process.env.FORGEJO_API || (() => {
    try {
        const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return `${new URL(url.replace(/^[^@]+@([^:]+):/, 'https://$1/')).origin}/api/v1`;
    } catch {
        return '';
    }
})();
if (!API) {
    console.error('forgejo: set FORGEJO_API, or run from a checkout whose origin points at your Forgejo');
    process.exit(1);
}
const WEB = API.replace(/\/api\/v1\/?$/, ''); // target_url comes back repo-relative

// Repo target (global-tool aware): an explicit FORGEJO_REPO wins; else derive
// owner/repo from THIS repo's `origin` remote when it points at the Forgejo host
// — so the one global command works in any repo with zero config, capturing the
// remote's exact casing (e.g. brandon/Ensemble). Fails loudly if neither applies:
// a silent default repo turns a wrong cwd into writes against the wrong tracker.
function resolveRepo(api) {
    if (process.env.FORGEJO_REPO) {
        return process.env.FORGEJO_REPO.split('/');
    }
    let host = '';
    try {
        host = new URL(api).host;
    } catch {
        /* keep host empty → skip the check */
    }
    try {
        const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (!host || url.includes(host)) {
            const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
            if (m) {
                return [m[1], m[2]];
            }
        }
    } catch {
        /* not a repo / no origin → fall through */
    }
    console.error(
        'forgejo-merge: cannot resolve target repo: cwd is not inside a git repo with a Forgejo-host origin and FORGEJO_REPO is unset — set FORGEJO_REPO=owner/name or run from the repo checkout',
    );
    process.exit(1);
}
const [OWNER, REPO] = resolveRepo(API);
const TOKEN_FILE = process.env.FORGEJO_TOKEN_FILE ?? join(homedir(), '.config/forgejo/token');
const POLL_SECS = Number(process.env.FJ_POLL_SECS ?? 5);
const REGISTER_TIMEOUT = Number(process.env.FJ_REGISTER_TIMEOUT_SECS ?? 300);
const FINISH_TIMEOUT = Number(process.env.FJ_FINISH_TIMEOUT_SECS ?? 2400);

function token() {
    const t = process.env.FORGEJO_TOKEN ?? readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!t) {
        throw new Error(`empty token (${TOKEN_FILE})`);
    }
    return t;
}

function done(msg, code) {
    (code === 0 ? console.log : console.error)(`forgejo-merge: ${msg}`);
    process.exit(code);
}

// `soft: true` returns a synthetic failed response on a network error instead of
// exiting the process — for calls made AFTER the merge already succeeded, where a
// blip must not report exit code 3 ("Forgejo unreachable — not merged"), which
// would be a lie once the merge has landed.
async function api(method, path, body, { soft } = {}) {
    let res;
    try {
        res = await fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `token ${token()}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch (e) {
        if (soft) {
            return { status: 0, ok: false, data: null, text: e.message };
        }
        done(`Forgejo unreachable (${method} ${path}): ${e.message}`, 3);
    }
    const text = await res.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            /* keep raw text for the error message */
        }
    }
    return { status: res.status, ok: res.ok, data, text };
}

// The verified merge gate. Returns { state, statuses:[{context,status,target_url}] }.
// NOTE: the combined object's state is `state`, but each per-check state is under
// `status` (Forgejo/gitea quirk), and target_url is repo-relative.
async function combinedStatus(sha) {
    const r = await api('GET', `/repos/${OWNER}/${REPO}/commits/${sha}/status`);
    if (!r.ok) {
        done(`status ${sha}: ${r.status} ${r.data?.message ?? r.text.slice(0, 200)}`, 1);
    }
    return r.data;
}

function summarize(s) {
    const parts = (s.statuses ?? []).map((c) => `${c.context}=${c.status}`);
    return `${s.state}${parts.length ? ` [${parts.join(', ')}]` : ''}`;
}

// How many trailing log lines to print per failing job. Enough to carry a stack
// trace or a vitest failure block; short enough to stay readable in a poll log.
const TAIL_LINES = Number(process.env.FJ_LOG_TAIL_LINES ?? 40);

// Turn a repo-relative target_url (/owner/repo/actions/runs/323/jobs/0) into the
// run/job indices fj-ex wants. Returns null for any shape we don't recognize.
function parseRunJob(targetUrl) {
    const m = /\/actions\/runs\/(\d+)\/jobs\/(\d+)/.exec(targetUrl ?? '');
    return m ? { run: m[1], job: m[2] } : null;
}

// Print the tail of a failing job's log so a red gate is self-explaining at the
// point of failure instead of only linking a URL only a browser can open. This
// Forgejo build has no job-log API (every documented route 404s), so the body has
// to come from fj-ex's authenticated web-UI scrape.
//
// Strictly best-effort: fj-ex may be missing, or its session cookie expired, and
// neither is a reason to change the CI verdict. Any failure here degrades to the
// URL we already printed. Never let it throw — it runs on the path that is ALREADY
// reporting a failure, and masking that with a tooling error would be worse than
// the observability gap it exists to close.
function printFailingLogTail(targetUrl) {
    const loc = parseRunJob(targetUrl);
    if (!loc) return;
    const fj = process.env.FJ_EX ?? join(homedir(), '.cargo/bin/fj-ex');
    let out;
    try {
        out = execFileSync(
            fj,
            [
                'actions',
                'logs',
                'job',
                '--repo',
                `${OWNER}/${REPO}`,
                '--run-index',
                loc.run,
                '--job-index',
                loc.job,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 },
        );
    } catch {
        console.error(
            `    (log tail unavailable — need \`cargo install forgejo-cli-ex\` and a live` +
                ` session: \`fj-ex auth login --host ${new URL(WEB).host} --username ${OWNER}\`)`,
        );
        return;
    }
    const lines = out.split('\n').filter((l) => l.trim());
    if (!lines.length) return;
    console.error(`    ── last ${Math.min(TAIL_LINES, lines.length)} log lines ──`);
    for (const l of lines.slice(-TAIL_LINES)) {
        // Drop the runner's ISO timestamp prefix; it's noise at this width.
        console.error(`    ${l.replace(/^\S+Z /, '')}`);
    }
    console.error(`    ── end (full log: ci-logs ${loc.run} ${loc.job}) ──`);
}

// Poll a sha until CI both REGISTERS (≥1 status) and FINISHES (state ≠ pending).
// Returns the terminal combined-status object, or exits 2 on timeout.
async function pollToTerminal(sha) {
    const start = Date.now();
    let registered = false;
    for (;;) {
        const s = await combinedStatus(sha);
        const n = (s.statuses ?? []).length;
        const elapsed = (Date.now() - start) / 1000;

        if (!registered) {
            if (n > 0) {
                registered = true;
                console.log(
                    `forgejo-merge: CI registered (${n} check${n > 1 ? 's' : ''}) — ${summarize(s)}`,
                );
            } else if (elapsed > REGISTER_TIMEOUT) {
                done(`no checks registered for ${sha} after ${REGISTER_TIMEOUT}s`, 2);
            }
        }
        // `pending` with zero statuses = not registered yet; keep waiting.
        if (registered && s.state !== 'pending') {
            return s;
        }
        if (registered && elapsed > FINISH_TIMEOUT) {
            done(
                `checks did not finish for ${sha} after ${FINISH_TIMEOUT}s — last: ${summarize(s)}`,
                2,
            );
        }
        await sleep(POLL_SECS * 1000);
    }
}

// Strip fenced code blocks and inline code spans (backtick-delimited markdown) —
// a `Closes #<n>` a human/agent writes for real is prose; one inside backticks is
// either an example or command syntax, never a live directive (#519 — a PR body that
// quoted `Closes #1, #2` as an illustrative example got matched as real and
// false-closed issue #1). The inline-span pattern uses a backreference on the
// backtick run length (CommonMark: an N-backtick delimiter closes on the next
// N-backtick run), so a doubled `` `` `` delimiter — used to embed a literal
// backtick inside the span — is stripped too, not just single backticks.
// Known gap: an unclosed/unbalanced backtick isn't a real span per CommonMark, so
// it's deliberately left un-stripped here (stripping it needs a heuristic, not a
// markdown rule, and risks eating real content) — not expected in this pipeline's
// own PR bodies; the durable fix is to stop parsing body text for this at all (see
// the follow-up filed alongside #519).
function stripCodeSpans(text) {
    return text.replace(/```[\s\S]*?```/g, ' ').replace(/(`+)[\s\S]*?\1/g, ' ');
}

// Issue numbers referenced by a `Closes #<n>` / `Fixes #<n>` / `Resolves #<n>` (and
// closed/fixed/resolved variants) line in the PR body (GitHub/Forgejo's standard
// closing-keyword set, case-insensitive), outside any code span. De-duped, in
// first-seen order.
function closesReferences(body) {
    const seen = new Set();
    const out = [];
    for (const m of stripCodeSpans(body ?? '').matchAll(
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi,
    )) {
        const n = Number(m[1]);
        if (!seen.has(n)) {
            seen.add(n);
            out.push(n);
        }
    }
    return out;
}

// A closed issue is done — a lingering `status/*` label on it is stale by definition
// (there is no `status/shipped`; the close IS the terminal state). Board-backed
// trackers flip a column on close; label-namespace trackers have nothing to flip, so
// the guard drops the namespace itself. Best-effort and soft throughout: the merge
// and the close have already landed, so a label hiccup is reported, never fatal.
async function clearStatusLabels(issueNum) {
    const labels = await api(
        'GET',
        `/repos/${OWNER}/${REPO}/issues/${issueNum}/labels`,
        undefined,
        { soft: true },
    );
    if (!labels.ok || !Array.isArray(labels.data)) return;
    for (const l of labels.data) {
        if (!l?.name?.startsWith('status/')) continue;
        const r = await api(
            'DELETE',
            `/repos/${OWNER}/${REPO}/issues/${issueNum}/labels/${l.id}`,
            undefined,
            { soft: true },
        );
        if (r.ok || r.status === 204) {
            console.log(`forgejo-merge: #${issueNum} — dropped stale label ${l.name} (closed = done)`);
        } else {
            console.error(
                `forgejo-merge: #${issueNum} — could not drop ${l.name}: ${r.status} ${r.data?.message ?? r.text?.slice(0, 200)}`,
            );
        }
    }
}

// Close every issue the PR closes, after a successful merge. Best-effort per issue
// (already-closed is fine; a failure is reported but doesn't fail the merge, which
// already happened) — never left silent, unlike the keyword-scan gap this replaces.
// Uses `soft` API calls (§ api()) so a network blip here can't misreport exit code 3
// ("unreachable — not merged") after the merge has already landed.
//
// `explicitCloses` (from `--closes`) takes priority and skips the PR-body regex scan
// entirely — this is the pipeline's own hot path, so no future markdown quirk in a
// pipeline-authored body can misfire it (#520, the structural follow-up to #517/#519).
// The regex scan is now only the fallback for an ad-hoc invocation with no --closes.
// Returns true iff every referenced issue closed cleanly.
async function closeReferencedIssues(prNum, body, explicitCloses) {
    const viaExplicit = explicitCloses != null;
    const issueNums = viaExplicit ? explicitCloses : closesReferences(body);
    const source = viaExplicit ? '--closes' : 'body regex';
    if (issueNums.length === 0) {
        console.log(
            `forgejo-merge: PR #${prNum} — no Closes/Fixes/Resolves reference in body — nothing to close`,
        );
        return true;
    }
    console.log(
        `forgejo-merge: closing ${issueNums.length} issue(s) via ${source}: ${issueNums.map((n) => `#${n}`).join(', ')}`,
    );
    let allOk = true;
    for (const n of issueNums) {
        // Courtesy audit trail on the issue (soft — a comment hiccup never affects
        // the close outcome); preserved from ensemble's merge script on unification.
        await api(
            'POST',
            `/repos/${OWNER}/${REPO}/issues/${n}/comments`,
            {
                body: `Closed by PR #${prNum} (squash-merged).`,
            },
            { soft: true },
        );
        const r = await api(
            'PATCH',
            `/repos/${OWNER}/${REPO}/issues/${n}`,
            { state: 'closed' },
            { soft: true },
        );
        if (r.ok) {
            console.log(`forgejo-merge: closed #${n} (via ${source})`);
            await clearStatusLabels(n);
        } else {
            allOk = false;
            console.error(
                `forgejo-merge: failed to close #${n}: ${r.status} ${r.data?.message ?? r.text.slice(0, 200)}`,
            );
        }
    }
    return allOk;
}

async function mergePr(prNum, { dryRun, closes } = {}) {
    const pr = await api('GET', `/repos/${OWNER}/${REPO}/pulls/${prNum}`);
    if (!pr.ok) {
        done(`PR #${prNum}: ${pr.status} ${pr.data?.message ?? pr.text.slice(0, 200)}`, 1);
    }
    if (pr.data.merged) {
        done(`PR #${prNum} already merged — nothing to do`, 0);
    }
    const sha = pr.data.head?.sha;
    const branch = pr.data.head?.ref;
    if (!sha) {
        done(`PR #${prNum} has no head sha`, 1);
    }
    console.log(`forgejo-merge: PR #${prNum} (${branch}) @ ${sha.slice(0, 8)} — waiting for CI`);

    const s = await pollToTerminal(sha);

    if (s.state !== 'success') {
        const failed = (s.statuses ?? []).filter((c) => c.status !== 'success');
        console.error(`forgejo-merge: CI ${s.state} — NOT merging PR #${prNum}`);
        for (const c of failed) {
            const url = c.target_url
                ? c.target_url.startsWith('http')
                    ? c.target_url
                    : WEB + c.target_url
                : '';
            console.error(`  ✗ ${c.context}: ${c.status}${url ? ` → ${url}` : ''}`);
            printFailingLogTail(c.target_url);
        }
        process.exit(1);
    }

    if (dryRun) {
        done(`CI success — would merge PR #${prNum} (squash + delete ${branch}) [dry-run]`, 0);
    }

    const m = await api('POST', `/repos/${OWNER}/${REPO}/pulls/${prNum}/merge`, {
        Do: 'squash',
        delete_branch_after_merge: true,
    });
    // Forgejo returns 200 (body) or 204 (empty) on a successful merge.
    if (!m.ok) {
        done(
            `merge PR #${prNum} failed: ${m.status} ${m.data?.message ?? m.text.slice(0, 200)}`,
            1,
        );
    }
    console.log(`forgejo-merge: merged PR #${prNum} (squash) + deleted ${branch}`);
    const closedOk = await closeReferencedIssues(prNum, pr.data.body, closes);
    done(
        `done with PR #${prNum}${closedOk ? '' : ' (WARNING: one or more issue closes failed — see above)'}`,
        0,
    );
}

// Parses the flags after <pr#>: --dry-run (bare) and --closes <n,n,...> (takes the
// next arg). Order-independent; any other token is a usage error.
function parseMergeFlags(args) {
    let dryRun = false;
    let closes = null;
    for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === '--dry-run') {
            dryRun = true;
        } else if (a === '--closes') {
            i += 1;
            const val = args[i];
            if (val === undefined) {
                done('--closes requires a comma-separated list of issue numbers, or "none"', 1);
            }
            // `--closes none`: merge and close NOTHING — and crucially, suppress
            // the body-regex fallback. A multi-phase PR ("Phase 2a of #539 …
            // which will close #539 later") is exactly the body that misfires
            // the regex (bit on PR #544, 2026-07-12, after #517/#519/#520 —
            // editing the body post-launch doesn't help; the guard snapshots
            // it at registration). Pipeline rule: ALWAYS pass --closes,
            // with `none` when nothing should close.
            if (val === 'none') {
                closes = [];
                continue;
            }
            const nums = val
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .map(Number);
            if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n <= 0)) {
                done(
                    `--closes needs a comma-separated list of positive issue numbers (or "none"), got: ${val}`,
                    1,
                );
            }
            closes = nums;
        } else {
            done(`unknown argument: ${a}`, 1);
        }
    }
    return { dryRun, closes };
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'poll') {
    const [arg] = rest;
    if (!arg) {
        done('usage: forgejo-merge.mjs poll <sha>', 1);
    }
    console.log(summarize(await combinedStatus(arg)));
} else if (cmd === 'watch') {
    const [arg] = rest;
    if (!arg) {
        done('usage: forgejo-merge.mjs watch <sha>', 1);
    }
    const s = await pollToTerminal(arg);
    done(`terminal: ${summarize(s)}`, s.state === 'success' ? 0 : 1);
} else {
    const prNum = Number(cmd);
    if (Number.isNaN(prNum)) {
        done(
            'usage: forgejo-merge.mjs <pr#> [--dry-run] [--closes <n,n,...>] | poll <sha> | watch <sha>',
            1,
        );
    }
    const { dryRun, closes } = parseMergeFlags(rest);
    await mergePr(prNum, { dryRun, closes });
}
