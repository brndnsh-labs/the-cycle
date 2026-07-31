# Harnesses

The skills never name an AI coding tool. They call `{{harness.*}}` fields, and a harness file binds
each one to that tool's discovery path, tool names, and capabilities. Rendering into a second
harness is one line in `.cycle/config.jsonc`.

This mirrors `backends/` (`docs/BACKENDS.md`) on purpose — a harness is to *which coding tool runs
the skills* what a backend is to *which tracker they write to*. Read that file first if you haven't;
the two systems are structurally the same idea aimed at a different axis of variation.

## Configuring it

```jsonc
// .cycle/config.jsonc
{
  "harnesses": ["claude", "codex"]   // default: ["claude"] if the field is absent
}
```

`cycle update` then renders one **complete, independent skill tree per harness** — same doctrine,
same procedure, same overlays, only the output root and the harness-conditional prose differ:

```
.claude/skills/DOCTRINE.md        .agents/skills/DOCTRINE.md
.claude/skills/cycle/SKILL.md     .agents/skills/cycle/SKILL.md
...                                ...
```

The backend's helper shims (`scripts/*.mjs`) are **not** duplicated — they're plain Node, harness-
agnostic, and every rendered tree's skills call the same ones.

## The `harness.*` field vocabulary

| Field | Example (claude) | Example (codex) | Purpose |
| --- | --- | --- | --- |
| `harness.name` | `claude` | `codex` | the config key |
| `harness.display` | `Claude Code` | `Codex CLI` | human-readable, for prose |
| `harness.root` | `.claude/skills` | `.agents/skills` | where this tree's skills land |
| `harness.doctrine_path` | `.claude/skills/DOCTRINE.md` | `.agents/skills/DOCTRINE.md` | computed (`root/DOCTRINE.md`) — every skill's "Shared rules in `…`" line |
| `harness.has_menus` | `true` | `true` | a structured, recommendation-first choice tool exists |
| `harness.has_subagents` | `true` | `true` | a native parallel-subagent spawn tool exists |
| `harness.attribution` | `🤖 Generated with [Claude Code](…)` | `🤖 Generated with [Codex CLI](…)` | the §8 PR-body trailer |
| `harness.ask` | `` `AskUserQuestion` `` | `` `ask_user_question` `` | the structured-question tool's name, backticked |

`doctrine_path` is computed by the engine (`buildHarnessContext` in `bin/cycle.mjs`) from `root` —
it isn't a field a harness file declares. Everything else comes straight from the `.jsonc` file.

## The places harnesses genuinely differ

Everything else is the same prose, rendered twice. These are *semantic*, so templates branch on
them via `{{#if harness.…}}` / `{{#unless harness.…}}` — and `cycle lint`'s `harnesses` check fails
the build if a template branches on a field the engine never populates (a typo inside a block is
otherwise silently falsy, not a hard error — see `bin/lint.mjs`):

| | Claude Code | Codex CLI |
| --- | --- | --- |
| `has_menus` | `true` — `AskUserQuestion` | `true` — `ask_user_question` (GA 2026) |
| `has_subagents` | `true` — the Agent tool | `true` — subagents, GA 2026-03-14 |

Both current harnesses happen to have both capabilities — Codex was chosen as the second target
*because* it's nearly a structural copy of Claude Code's model (same open agent-skills format, a
comparable menu tool, comparable subagent support). The `{{#unless harness.has_menus}}` /
`{{#unless harness.has_subagents}}` branches exist for a **future**, less-capable harness (Opencode,
Pi — see the harness-target follow-up issues), and are exercised by the render tests even though no
shipped harness takes that path today.

## Verified discovery paths, not assumed

`harness.root` is the one fact that's expensive to get wrong — a wrong path means the harness never
finds the skills at all, and that failure is silent (no error, just nothing to invoke). Each
`harnesses/*.jsonc` records what it was verified against, in a comment:

- **Claude Code** — `.claude/skills/<name>/SKILL.md`, the format this whole system was built around.
- **Codex CLI** — `.agents/skills/<name>/SKILL.md` at the repo root, confirmed against
  `developers.openai.com/codex/skills` (2026-07). Codex also discovers skills at a parent directory,
  `~/.agents/skills`, `/etc/codex/skills`, and its own built-ins — the repo-root path is what a
  rendered install writes to.

Before adding a harness, re-verify its current discovery path against that tool's own docs at
implementation time — these move, and a stale path here is worse than no harness at all.

## Adding a harness

1. Copy `harnesses/claude.jsonc`.
2. Set `root` and `skill_file` to that tool's real, currently-verified discovery path.
3. Set both capability flags **honestly** — `has_menus: false` with no fallback prose written
   anywhere would mean a rendered skill assumes a tool that doesn't exist there.
4. Fill in `notes.attribution` and `notes.ask`.
5. `cycle lint` — catches a filename/`name` mismatch, a missing required field, and two harnesses
   sharing a `root` (which would let one silently overwrite the other's tree if both were ever
   configured together).
6. `npm test` renders every profile against every backend **and** a second harness in the
   multi-harness suite (`test/render.test.mjs`), and checks frontmatter, provenance, idempotency,
   and that harness-conditional prose actually differs between trees.
7. The acceptance bar is behavioral, same as adopting a repo (`docs/PATTERNS.md`'s spirit, `/cycle-
   adopt`'s Rule 4): render into a real repo and run a session **in that harness** through a full
   `/cycle` on a live issue, merge guard included, before calling the harness supported.
