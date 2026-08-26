# Developing the-cycle

The repository dogfoods its own generated pipeline. Pipeline prose and bindings belong in
templates, config, overlays, backend definitions, or harness definitions; CLI, evaluator, tests,
and documentation stay in their corresponding source directories. `.claude/skills/**` and
`.agents/skills/**` are rendered output and must not be hand-edited.

See [`CLAUDE.md`](../CLAUDE.md) for the detailed cross-harness repository guidance and
[`AUTHORING.md`](AUTHORING.md) for template and overlay rules.

## Local gates

Run all three before considering repository work complete:

```sh
node bin/cycle.mjs lint
npm test
node bin/cycle.mjs check
```

The gates cover different contracts: lint checks references and bindings, tests exercise the
profile × backend × harness render matrix, and check proves this repository's generated copy still
matches its sources.

Tests create temporary git repositories and spawn child processes. If a restricted sandbox rejects
those operations with `EPERM`, rerun the same gate in an environment that permits them; do not
weaken or skip the test.

Useful read-only render diagnostics are:

```sh
node bin/cycle.mjs render [filter]
node bin/cycle.mjs update --dry-run
```

## Repository layout

```text
.github/workflows/ci.yml    npm test + cycle check on pull requests and pushes to main
AGENTS.md                   cross-harness repository entry point
bin/
  cycle.mjs                 CLI; Node ESM with zero dependencies plus lazy lint.mjs import
install.sh                  links bin/cycle onto PATH and installs the personal setup skill
skills/
  cycle-setup/              guided setup skill linked by install.sh
templates/
  DOCTRINE.md.tmpl          shared rule spine
  skills/*.md.tmpl          one source template per generated skill
  overlays.jsonc            overlay registry and contracts
backends/*.jsonc            tracker verb bindings
harnesses/*.jsonc           discovery paths, tool names, and capability flags
profiles/*.jsonc            skills installed by each profile
eval/                       isolated behavioral comparison runner and fixtures
test/                       exhaustive render, coexistence, CLI, and package tests
docs/
  AUTHORING.md              template and overlay authoring
  BACKENDS.md               tracker vocabulary and backend implementation
  DEVELOPMENT.md            local gates and this layout
  EVALUATION.md             behavioral comparison procedure
  HARNESSES.md              harness vocabulary and implementation
  INSTALLING.md             bootstrap and durable setup paths
  PATTERNS.md               reviewer, hook, and scoped-instruction patterns
  RELEASING.md              package preflight and explicit publish gate
```

Publishing is a separate external action. Follow [`RELEASING.md`](RELEASING.md); a merged pull
request never authorizes `npm publish`.
