# Releasing the-cycle

The durable installation is a clone plus `./install.sh`. The README's explicit GitHub package
spec is the bootstrap path for a first render and does not depend on the npm registry. Its
`--allow-git=root` flag permits only the explicitly requested root git package, not transitive git
dependencies.

The package metadata permits publication as `@brndnsh/the-cycle`, but publication is an explicit
external release gate. Making a commit or merging a pull request does not authorize `npm publish`.

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

Before publishing, obtain explicit approval for the exact version and registry. Publish using the
normal npm authentication flow, then verify the registry package with a fresh one-off invocation.
