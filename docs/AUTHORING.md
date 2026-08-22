# Authoring templates

A template is a skill with its repo-specific values pulled out. The test of a good one: it should
read correctly in *any* repo that fills in the config, and it should be impossible to tell which
repo it was extracted from.

## The template language

Deliberately small. If you find yourself wanting more, the thing you want is probably an overlay.

| Tag | Does |
| --- | --- |
| `{{repo.name}}` | scalar lookup; arrays join with `, ` |
| `{{brakes\|join: · }}` | join with an explicit separator (trailing space is preserved) |
| `{{#if path}}…{{/if}}` | render when truthy (non-empty array/string, not `false`/`null`) |
| `{{#unless path}}…{{/unless}}` | the inverse |
| `{{#each list}}…{{.}}…{{/each}}` | `{{.}}` is the item; `{{.field}}` indexes it |
| `{{> overlay:name}}` | inject `.cycle/overlays/name.md` — **required**, missing is fatal |
| `{{> overlay?:name}}` | same, **optional** — missing renders nothing |
| `{{@verb "arg"}}` | expand a backend verb; `$1`–`$9` are the args |
| `{{harness.X}}` / `{{#if harness.X}}` | a harness-target field or capability — see `docs/HARNESSES.md` |

Three rules the engine enforces, each because the alternative failed silently:

- **An unresolved path is a hard error.** A skill rendered with a hole in it is worse than no skill.
- **`${{ … }}` passes through untouched**, so GitHub Actions expressions survive.
- **A tag alone on its line contributes no line.** Otherwise a `{{#if}}` that renders nothing leaves
  a blank behind, and a skill's shape would depend on which optional sections happened to apply.

Verb arguments may themselves be lookups: `{{@set_status "<n>" "{{tracker.status.active}}"}}`.

## What belongs where

This is the whole design decision, so it's worth being explicit.

| Kind of content | Goes in |
| --- | --- |
| Procedure, judgment, safety rules, output formats | **the template** |
| A value that varies per repo (a command, a name, a number) | **`.cycle/config.jsonc`** |
| A command that varies per *tracker* | **a backend verb** |
| A tool name or capability that varies per *AI harness* | **a `harness.*` field** (`docs/HARNESSES.md`) |
| A table or list only this repo could write | **an overlay** |
| A rule every skill in the repo shares | **DOCTRINE**, cited as `§N` |

**The failure mode to avoid is inlining a repo fact into prose.** That is exactly how the three
original copies drifted: every skill restated `npm run typecheck`, and so every skill had to be
edited when it changed. If you're typing a command, a person's name, or a project number into a
template, stop — it belongs in config. The same applies to a harness-specific path or tool name —
`.claude/skills/DOCTRINE.md` and `AskUserQuestion` were both literal strings in every skill until
Codex support made them wrong in a second tree; use `{{harness.doctrine_path}}` / `{{harness.ask}}`
instead of naming one harness's mechanics in portable prose.

### Commit attribution is runtime state

A `Co-Authored-By` identity is not a repo fact or a harness fact. The active model can change while
the repo and harness stay the same, so templates include the trailer only when the active runtime
explicitly supplies a truthful identity for that work. Otherwise they omit it. Do not add a static
identity to `.cycle/config.jsonc` or derive one from `harness.display`, a model name, or an older
commit. Existing `commit.coauthor` config values are retired and ignored on render.

The `harness.attribution` line is separate: it names the coding product in the PR body and remains
the durable harness-level provenance marker. It does not claim which model authored a commit.

## Overlays

Some skills are portable procedure wrapped around irreducibly local content: `/review`'s reviewer
routing table, `/scout`'s lens bodies, a repo's dependency landmines. Those inject at a named point.

Overlays are rendered with the same context, so they can use the full template language.

Every point is registered in `templates/overlays.jsonc` with its purpose, the shape its content
should take, and when it's worth having. That file is what `cycle install --plan` hands to a
guided setup, so **an overlay point with no manifest entry is one nothing will ever draft for** —
`cycle lint` treats the omission as an error, in both directions.

Current overlay points (all optional):

| Overlay | Injected into |
| --- | --- |
| `doctrine-preamble` | DOCTRINE, before §1 — the "lean by design" style posture note |
| `doctrine-tracker` · `doctrine-labels` · `doctrine-routing` | DOCTRINE §1 / §2 / §3 |
| `doctrine-gates` | DOCTRINE §4 — track-specific DoD, repo gotchas the gates enforce |
| `doctrine-autonomy` | DOCTRINE §5 — repo-specific autonomy nuance |
| `doctrine-deploy` · `doctrine-tracker-mechanics` | DOCTRINE §6 / §7 |
| `review-routing` | `/review` — the path→reviewer table |
| `scout-lenses` | `/scout` — what each lens looks for *here* |
| `dep-update-landmines` | `/dep-update` — the high-scrutiny dependency list |
| `deploy` | `/deploy-test` and `/deploy-prod` — the actual topology |
| `implement` · `done` | tail of those skills, for repo-specific steps |
| `unblock` | tail of `/unblock` — a domain-specific hands-on lane (e.g. a by-ear verdict set) |
| `cycle` | tail of `/cycle` — per-issue-type DoD/reviewer/merge-tail, when one gate-green-means-merge shape doesn't fit every kind of work |
| `flake` | tail of `/flake` — repo-specific repro commands and fix specifics (never a separate registry file — the tracker is the durable record) |

## Adding a skill

1. Write `templates/skills/<name>.md.tmpl`. Frontmatter needs `name` (matching the filename) and
   `description`.
2. Add it to the profiles that should install it.
3. `cycle lint` — catches what rendering can't: a `§N` that points at nothing, a verb no
   backend binds, a `/other-skill` reference absent from a profile that installs yours, and any
   command you inlined instead of binding.
4. `npm test` — the render suite will build it on every profile × backend × harness and check the
   frontmatter, the absence of unrendered syntax, and idempotency.
5. Render it into a scratch repo and **read the output**. Tests prove it renders; only reading
   proves it says something true.

## Changing a template that repos already have

1. Edit the template here.
2. In each consuming repo: `cycle check` (what would change), then `cycle update --dry-run`, then
   `cycle update`.
3. If a repo has locally drifted, `update` refuses. That's the design — resolve it by folding the
   local edit **into the template**, not by forcing over it. A local edit that's genuinely
   repo-specific means you found a missing config value or overlay point.

## Formatters and drift

Drift detection hashes a rendered file's raw bytes (`stripProvenance` then `hashContent` — both in
`bin/cycle.mjs`), so a markdown formatter that reflows line wrapping — prettier, dprint — reads as
a hand edit even though the prose is identical. Left alone, that permanently blocks `cycle update`
for that repo: every run refuses the "edit" and `--force` becomes a habit, which eventually
clobbers a genuine local change.

The fix is keeping the formatter off rendered skill trees entirely, not loosening the hash — a
looser hash would let a real reflow-only hand edit pass silently, which is the failure this
detector exists to catch. `cycle install` and `cycle update` detect a configured prettier or dprint
setup and, if the configured harness roots aren't already excluded, print the exact lines to add
(`.prettierignore` entries, or a dprint `excludes` glob) — never written automatically, same
reasoning as the `gh label create` lines they sit next to: a repo's own tooling config isn't
`cycle`'s to touch without the operator asking for it.
