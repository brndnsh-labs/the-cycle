# Releasing the-cycle

The durable installation is a clone plus `./install.sh`. The README's `npx --yes
@brndnsh/the-cycle install` command is the bootstrap path for a first render. It fetches the
published package from npm into npx's ephemeral cache, so follow-up `cycle update` / `cycle check`
work still need the durable clone.

`@brndnsh/the-cycle` is publicly published. Publishing a new version remains an explicit external
release gate: making a commit or merging a pull request does not authorize `npm publish`.

## Preflight

Run from a clean checkout:

```sh
npm test
node bin/cycle.mjs lint
node bin/cycle.mjs check
npm pack --dry-run --json
```

Inspect the dry-run file list. It must include the CLI, templates, harness definitions, profiles,
backends, setup skills, and documentation. It must not include this repository's `.cycle/`,
rendered `.claude/` or `.agents/` trees, tests, or CI configuration. The automated package test
checks the same boundary and exercises the packed artifact.

## Publish gate

Before publishing a new version, obtain explicit approval for the exact version and registry.
Publish using the normal npm authentication flow, then verify the registry package with fresh
one-off `npx --yes @brndnsh/the-cycle --version` and `npx --yes @brndnsh/the-cycle install`
invocations.
