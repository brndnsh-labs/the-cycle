# Full-pipeline pilot census

Frozen 2026-08-30. This is a descriptive pilot over four real historical changes, not a
representative sample of coding tasks and not a basis for statistical-significance or defect-rate
claims.

## Eligibility rule

Start with every first-parent change merged to `brndnsh-labs/songsiknow` during the two complete
America/New_York calendar days 2026-08-28 and 2026-08-29. Keep a change only when it:

1. closes exactly one work story;
2. changes no more than six files;
3. includes automated regression coverage for the named behavior; and
4. is not documentation, dependency, workflow, deployment, migration, by-ear, physical-device,
   bundle-inspection, or other externally verified work.

The fourth rule keeps the hidden outcome verifier executable and identical across arms. Passing it
does not prove visual quality or production readiness.

## Census

| Merge | Story | Files | Result | Frozen reason |
|---|---:|---:|---|---|
| `31513e8` | #16 | 9 | excluded | More than six files |
| `142078c` | #139 | 6 | eligible | One story and executable regression coverage |
| `6de1d1c` | #134 | 10 | excluded | More than six files |
| `ef80880` | #133 | 3 | eligible | One story and executable regression coverage |
| `eb1b11c` | #117 | 1 | excluded | No automated regression file for the named contrast behavior |
| `d895468` | #33, #34, #35, #36 | 4 | excluded | Closes four stories |
| `546198d` | none | 2 | excluded | Dependency maintenance |
| `3b4ad21` | #132 | 2 | excluded | Acceptance includes physical keyboard/touch verification |
| `2ca6aa2` | #131 | 2 | eligible | One story and executable regression coverage |
| `a724994` | #130 | 2 | eligible | One story and executable regression coverage |
| `e4c84fe` | #129 | 2 | excluded | Acceptance includes production bundle-manifest inspection |
| `ef418ac` | #128 | 5 | excluded | Documentation |
| `07a650e` | #127 | 1 | excluded | Documentation and live deployment-state verification |
| `6f8bf57` | #123 | 2 | eligible | One story and executable regression coverage |
| `655d383` | none | 21 | excluded | Generated workflow maintenance |
| `7bcc3c0` | none | 1 | excluded | Documentation |

## Deterministic selection

The eligible issue set is `123, 130, 131, 133, 139`. Rank each issue by ascending hexadecimal
SHA-256 of `full-pipeline-pilot-v1-2026-08-30:<issue>`:

| Rank | Issue | Digest | Selected |
|---:|---:|---|---|
| 1 | #133 | `0f40a2b147a08a3b80d5284cc7e96c9ec8fbf9b890db2507ca6008410533da93` | yes |
| 2 | #131 | `6c10edd2b50ee48c6be3a2728cef2dfa2ccb679f8eeee5b8b11e5a3a440ad569` | yes |
| 3 | #139 | `c52550befe91414bb9445a62902747ef06ae427273a0d764c38264c971372d73` | yes |
| 4 | #123 | `f264e5438b3883fc40bd1db29b387afd00aeaf7a439ae530e1853be92a77f6ae` | yes |
| 5 | #130 | `f4a651897375166bed6ddf6f53f524ffe4111c701a6d0798c224018587ab225e` | no |

The #130 result is excluded solely by its frozen rank. Its historical review outcome was not used
to select the four cases.
