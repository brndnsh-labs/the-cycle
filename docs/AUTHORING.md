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
| A table or list only this repo could write | **an overlay** |
| A rule every skill in the repo shares | **DOCTRINE**, cited as `§N` |

**The failure mode to avoid is inlining a repo fact into prose.** That is exactly how the three
original copies drifted: every skill restated `npm run typecheck`, and so every skill had to be
edited when it changed. If you're typing a command, a person's name, or a project number into a
template, stop — it belongs in config.

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

## Adding a skill

1. Write `templates/skills/<name>.md.tmpl`. Frontmatter needs `name` (matching the filename) and
   `description`.
2. Add it to the profiles that should install it.
3. `cycle lint` — catches what rendering can't: a `§N` that points at nothing, a verb only one
   backend binds called outside a `{{#if backend.…}}`, a `/other-skill` reference absent from a
   profile that installs yours, and any command you inlined instead of binding.
4. `npm test` — the render suite will build it on every profile × backend and check the
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
