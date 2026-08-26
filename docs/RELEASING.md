# Releasing the-cycle

The public docs lead with the durable installation: a source clone plus `./install.sh`, followed by
`/cycle-setup` in the consuming repository. `npx` is a published-package smoke path and a
deliberate one-off/manual option, not the recommended installation. Keep README and
`docs/INSTALLING.md` aligned with that distinction.

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
one-off commands:

```sh
npx --yes @brndnsh/the-cycle --version
npx --yes @brndnsh/the-cycle install --plan   # run inside a deliberately temporary Git repo
```

The version output must equal the approved release, and the plan must be valid JSON. This verifies
the one-off surface without presenting it as the durable user path. If a release changes the
installer's link layout, its release notes must explicitly name the one-time `install.sh` rerun;
0.2.0 requires that note for users upgrading from 0.1.x.
