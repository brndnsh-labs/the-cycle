# AGENTS.md

Repository guidance for AI coding agents working on the-cycle.

## Start here

- Read `CLAUDE.md`. The historical filename remains, but its repository guidance applies to every
  supported harness.
- Read the doctrine in your rendered harness tree: `.agents/skills/DOCTRINE.md` for Codex or
  `.claude/skills/DOCTRINE.md` for Claude Code. Both trees are generated from the same templates.
- The normal local gates are `node bin/cycle.mjs lint`, `npm test`, and
  `node bin/cycle.mjs check`.
- Tests create temporary git repositories and spawn child processes. If a restricted sandbox
  rejects those operations with `EPERM`, rerun the same gate in an environment that permits them;
  do not weaken or skip the test.

## Current documentation

Use Context7 whenever work depends on current library, framework, SDK, API, CLI, or cloud-service
documentation. Resolve the library ID first, then query one concept at a time. It is not required
for ordinary refactoring, business-logic debugging, code review, or general programming concepts.
