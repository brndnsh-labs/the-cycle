# Patterns worth copying

Things the three source repos converged on that are **not** worth rendering per-repo — they're
either a skeleton a human fills in, or ten lines of config. Kept here as reference rather than
machinery, on the principle that a repo should only take on what it's earned.

## The reviewer-agent skeleton

Nine domain reviewer agents across the source repos share one structure, and it's the structure —
not any of the domain content — that transfers. Every one is read-only, and every one demands a
verbatim quote for a hard-rule violation.

```markdown
---
name: <domain>-reviewer
description: Use this agent when the diff touches <surface>. Specializes in <the
  invariants>. Invoke for <cases>. NOT for <the explicit negative boundary>.
tools: Read, Grep, Glob, Bash        # read-only — no Edit, no Write
---

## Context
<what this part of the system is, in three sentences, for an agent with no other context>

## The contract (non-negotiable)
1. <invariant, stated as a rule that can be violated>
2. …

## What to read
<the specific files, in the order that makes them make sense>

## Findings to hunt
**NAMED_FINDING_TYPE** (hard rule) — <what it looks like, how to spot it>
**ANOTHER_TYPE** — <…>
<ordered by scan priority, not by severity>

## Severity
P0 / P1 / P2 / NIT — <what each means here specifically>

## Report format
<a worked example, with a verbatim quote and file:line>

## Out of scope
You do not edit code. You read, grep, reason, and report.
<and the specific adjacent things this reviewer must NOT judge>
```

Two conventions worth keeping:

- **Reviewers are strictly read-only; implementers get write tools.** The separation is what makes
  it safe to run reviewers in parallel and to trust their output as observation rather than action.
- **Pin the reviewer to a different model than the implementer.** Same-model review shares
  same-model blind spots; the different prior is the entire value.

## Hooks

Both hooks below are structurally generic and textually repo-specific. Add them to
`.claude/settings.json` by hand — they're too small to template.

**Typecheck on stop.** Silent when green, loud when red:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "output=$(npm run typecheck 2>&1) || echo \"$output\" >&2",
        "statusMessage": "Type checking...",
        "timeout": 60
      }]
    }]
  }
}
```

The `output=$(…) || echo \"$output\" >&2` idiom is the portable part: it stays quiet on success
and surfaces the full failure on stderr where the model will read it.

**Format on edit** — *opt-in, with a caveat:*

```json
{
  "PostToolUse": [{
    "matcher": "Edit|Write",
    "hooks": [{ "type": "command", "command": "npm run format", "timeout": 30 }]
  }]
}
```

⚠️ **This hook is suspected of silently dropping some writes from backgrounded subagents.** It also
reflows lines, which can stale an `old_string` between two edits to the same region — `/patch`
carries a "re-Read before a second Edit" instruction specifically to compensate. Worth having, but
enable it deliberately, and set `hooks.format_on_edit: true` in config so the skills know to
compensate.

## Permissions

`settings.local.json` accretes. One source repo reached ~130 entries, including dozens of one-off
literal commands like `sed -n '300,320p' <exact file>`, plus a stale `gh *` allowlist in a repo
that had migrated off `gh` entirely.

Broad, intentional entries (`Bash(npm run *)`, `Bash(git *)`) are worth keeping; the one-off
literals are noise that never gets reused. `/fewer-permission-prompts` exists to replace this pile
— run it occasionally instead of letting the file grow.

## Scoped agent instruction files

Invariants that only matter inside one directory belong in the harness's scoped instruction file
(`AGENTS.md` for Codex or `CLAUDE.md` for Claude Code) *in that directory*, not in the global memory
index — the index loads wholesale every session, so every line is a tax paid forever, while a
scoped file costs nothing until someone opens that directory.

Leave a one-line pointer in the index saying the detail lives there.
