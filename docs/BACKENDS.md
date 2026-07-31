# Backends

The skills never name a tracker. They call **verbs**, and a backend file binds each verb to a
command. Swapping trackers is one line in `.cycle/config.jsonc`.

This isn't speculative generality — it's a mechanical port that has already been done by hand
twice, and the hand-written cheat-sheet that guided it is what this file generalizes.

(There's a second, structurally identical abstraction for *which AI coding tool* runs the rendered
skills — `harnesses/*.jsonc` and `{{harness.*}}` fields, documented in `docs/HARNESSES.md`. Same
idea, different axis: this file is about the tracker, that one is about the harness.)

## The verb vocabulary

| Verb | Args | Purpose |
| --- | --- | --- |
| `issue_list` | — | open issues, as JSON |
| `issue_list_closed` | — | recently closed, for the `--board` view |
| `issue_list_label` | `$1` label | filtered open issues |
| `issue_list_milestone` | `$1` milestone | filtered open issues |
| `issue_view` | `$1` number | one issue incl. body |
| `issue_create` | `$1` title `$2` body `$3` label | file an issue |
| `issue_edit_label` / `issue_unlabel` | `$1` number `$2` label | add / remove a label |
| `issue_comment` | `$1` number `$2` text | comment |
| `issue_close` | `$1` number | close |
| `pr_create` | `$1` branch `$2` title `$3` body | open a PR against `main` |
| `pr_list` / `pr_view` / `pr_close` | `$1` number | PR surface |
| `merge_guard` | `$1` pr `$2` issue | **backgrounded** poll-then-merge on green |
| `set_status` | `$1` number `$2` status | write the status value |
| `set_field` | `$1` number `$2` field `$3` value | write any routing value |
| `batch` | `$1` file | one grouped write for many issues |
| `ci_runs` | — | list CI runs |
| `ci_log` / `ci_log_failed` | `$1` run | read one run's log / its failed steps |
| `board_list` | — | GitHub only — read the board |

A verb's value is itself a template, so it can embed config:
`"board_list": "gh project item-list {{tracker.project}} --owner {{tracker.owner}} --format json"`.

## The places the backends genuinely differ

Everything else is a command swap. These are *semantic*, so skills branch on them via
`{{#if backend.…}}` — and `cycle lint` fails if a declared flag is one no template reads, or a
template branches on a flag a backend never declares:

| | Forgejo | GitHub |
| --- | --- | --- |
| `has_board` | `false` — the issue existing IS enough; routing lives in label namespaces (`status/ready`, `size/s`) | `true` — an issue must be on the board to carry its Projects v2 field values |
| `job_logs` | `wrapper` — no job-log API; logs come from the `ci-logs` scraper | `api` — `gh run view --log` |
| `job_logs_search` | `true` — the wrapper scans back for the most recent *failing* run | `false` — `--log-failed` narrows one run; it never searches back |
| `auto_merge` | `false` — no server-side merge-on-green | `false` unless branch protection exists |

**On `auto_merge`:** a fire-and-forget auto-merge flag is only safe when the forge enforces
required checks. Without branch protection, `gh pr merge --auto` merges *immediately* — there is
nothing for it to wait on. Both backends therefore default to the background poll-then-merge guard.
Set `auto_merge: true` only for a repo that actually has protection configured.

## Reading routing values

- **Forgejo:** find the label with the namespace prefix and strip it —
  `labels.find(l => l.startsWith('status/'))?.slice('status/'.length)`. The helper enforces one
  label per namespace and preserves workflow labels (`bug`, `area:*`, `finding`, `scout`).
- **GitHub:** `gh project item-list` returns `content` plus the fields. It carries **no open/closed
  state**, so intersect with `gh issue list --state open` on `number` — a closed item can linger on
  the board until archived, and the intersection also catches an open issue not yet added.

## Required config

A backend declares what it can't render without, in `requires`. That's validated *before* any
template runs, so a missing value is one clear instruction rather than an "unresolved `{{…}}`"
from four levels inside a verb expansion.

GitHub requires `tracker.project` and `tracker.owner`. Forgejo requires nothing beyond the repo
slug — there's no board to point at.

## Shims and helpers

A backend declares the helper scripts its verbs call. The real logic lives **once**, in
`helpers/`, and each repo commits a thin real-file shim that spawns it:

```jsonc
"shims": [
  {
    "path": "scripts/forgejo.mjs",          // where it lands in the repo
    "helper": "forgejo.mjs",                // which helpers/ file it runs
    "env": { "FORGEJO_REPO": "{{repo.slug}}" }   // this repo's bindings, baked in
  }
]
```

The shim is a **real file, not a symlink**, on purpose: a committed symlink dangles in an isolated
CI checkout (the runner clones one repo, with no siblings), which breaks any gate that checks a
file exists. A real file is always present, and CI never *runs* it — only the local pipeline does.

**`env` is what keeps the helpers portable.** A helper never learns which repo it is being run
from by reading the filesystem — the shim tells it, from `config.jsonc`. Values resolve as
templates and empty ones are dropped, so a blank `tracker.api` falls through to the helper's own
detection instead of overriding it with `""`. An explicitly exported variable still wins over the
baked-in value.

That indirection is not decoration. The hand-written `gh-project.mjs` in one repo opened with
`const OWNER = 'brndnsh'; const REPO = 'brndnsh/mend'; const PROJECT_NUMBER = '4'` — three literals
that made the file unshareable. The Forgejo equivalent had a **default repo slug**, and
`forgejo.mjs` carries the scar in a comment: a mis-set cwd once filed 7 issues into the wrong
tracker. So the helpers now have no defaults at all — an unresolvable target is an error, never a
guess.

### Finding the helpers

The shim looks for the-cycle in this order: `CYCLE_HOME`, then wherever the `cycle` command on
`PATH` really resolves to, then the path it was rendered from, then `~/code/the-cycle`. The `PATH`
probe is what lets a repo work on a second machine that keeps its clone somewhere else — the baked
path alone would pass every test and fail on the other laptop.

## Adding a backend

1. Copy `backends/forgejo.jsonc`.
2. Bind every verb in the table above. A verb a skill calls but the backend doesn't define is a
   hard error at render time, so nothing is silently missing.
3. Set every semantic flag honestly. Getting `auto_merge` wrong is the one that can actually
   lose work.
4. Fill in `notes.routing_read`, `notes.unreachable`, and `notes.done_means` — these splice into
   DOCTRINE §1/§7 where the backends' *prose* has to differ, not just their commands.
5. Put any executable it needs in `helpers/` and declare a shim for it. Every `scripts/*` path a
   verb mentions must have one; `cycle lint` fails the build if it doesn't.
6. `npm test` renders every profile against every backend in `backends/`, runs each shim, and
   checks it reached its helper.

## Unreachable is a stop, not a fallback

Every backend must make this true: if the tracker can't be reached, the skill **stops and says
so**. It never falls back to a cached list, a stale board read, or a frozen markdown tracker.
Guessing tracker state produces confidently wrong work, which is the most expensive failure this
pipeline can have.
