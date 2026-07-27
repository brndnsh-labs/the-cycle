#!/usr/bin/env bash
#
# ci-logs.sh — read Forgejo Actions CI logs from the terminal.
#
# Works around the observability gap on our Forgejo (15.0.3~gitea-1.22.0): that
# build exposes NO job-log API endpoint (`/actions/jobs/{id}/logs` 404s, as does
# every documented variant), so the only way to a log body is scraping the web UI
# with a session cookie. `fj-ex` (github.com/JKamsker/forgejo-cli-ex, installed via
# `cargo install forgejo-cli-ex`) does exactly that. This wrapper is the friendly
# front door to it.
#
# Repo targeting matches the other tools in this bin/ (see README "Zero-config repo
# targeting"): FORGEJO_REPO wins, else the CURRENT repo's `origin` remote. As a
# global command it therefore works from any checkout with no per-repo copy.
#
# One-time setup:  fj-ex auth login --host git.brndn.zip --username brandon
#   (stores a session cookie; re-run when it expires. Needs TOTP 2FA, not a
#    security key — fj-ex can't drive a WebAuthn ceremony.)
#
# Usage:
#   ci-logs                    # logs for the latest run (all jobs)
#   ci-logs --failed           # logs for the most recent FAILED run ("what broke")
#   ci-logs <run-number>       # logs for a specific run (e.g. ci-logs 283)
#   ci-logs <run> <job>        # one job of a run (job index is 0-based)
#   ci-logs --list             # recent runs + status, at a glance
#
# Job separators (`== job N ==`) go to stderr; log content to stdout — so
# `ci-logs --failed 2>/dev/null | grep -i error` stays clean.
#
set -euo pipefail

# Locate fj-ex: explicit override, then the cargo-install default, then PATH.
FJ="${FJ_EX:-}"
if [ -z "$FJ" ]; then
    if [ -x "$HOME/.cargo/bin/fj-ex" ]; then FJ="$HOME/.cargo/bin/fj-ex"
    elif command -v fj-ex >/dev/null 2>&1; then FJ="$(command -v fj-ex)"
    else
        echo "ci-logs: fj-ex not found. Install it with: cargo install forgejo-cli-ex" >&2
        echo "         (or set FJ_EX=/path/to/fj-ex)" >&2
        exit 127
    fi
fi

# Resolve the target repo the same way forgejo/forgejo-merge do, and fail loudly
# rather than defaulting — a silent default reads someone else's CI as if it were
# yours. FORGEJO_REPO is passed through explicitly; otherwise fj-ex infers from the
# origin remote of the repo we cd into.
REPO_ARGS=()
if [ -n "${FORGEJO_REPO:-}" ]; then
    REPO_ARGS=(--repo "$FORGEJO_REPO")
else
    if ! root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
        echo "ci-logs: cwd is not inside a git repo and FORGEJO_REPO is unset —" >&2
        echo "         run from the repo checkout or set FORGEJO_REPO=owner/name" >&2
        exit 1
    fi
    cd "$root"
fi

# Fail early with an actionable hint if the session cookie is missing/expired,
# rather than letting each subcommand emit a raw auth error.
if ! "$FJ" auth status >/dev/null 2>&1; then
    echo "ci-logs: not logged in (or the session cookie expired)." >&2
    echo "         Re-auth with: fj-ex auth login --host git.brndn.zip --username brandon" >&2
    exit 1
fi

case "${1:-}" in
    --list | -l)
        exec "$FJ" actions runs "${REPO_ARGS[@]}" --limit 20
        ;;
    --failed | -f)
        # Find the most recent FAILED run, then dump its logs. NOTE: fj-ex's own
        # `--status failure` server filter is broken against this Forgejo (returns
        # empty even when failures exist), so we pull the recent runs and filter
        # client-side. Runs come newest-first. Prefer jq; fall back to an awk pass
        # that relies on runIndex preceding status within each run object.
        runs_json="$("$FJ" actions runs "${REPO_ARGS[@]}" --limit 30 --json 2>/dev/null || true)"
        if command -v jq >/dev/null 2>&1; then
            idx="$(printf '%s' "$runs_json" |
                jq -r 'first(.runs[] | select(.status=="Failure") | .runIndex) // empty')"
        else
            idx="$(printf '%s' "$runs_json" | awk '
        /"runIndex":/ { gsub(/[^0-9]/,""); i=$0 }
        /"status":[[:space:]]*"Failure"/ { print i; exit }')"
        fi
        if [ -z "$idx" ]; then
            echo "ci-logs: no failed run found in recent history." >&2
            exit 0
        fi
        echo "== failed run #$idx ==" >&2
        exec "$FJ" actions logs run "${REPO_ARGS[@]}" --run-index "$idx"
        ;;
    "")
        exec "$FJ" actions logs run "${REPO_ARGS[@]}" --latest
        ;;
    -h | --help)
        sed -n '3,29p' "$0"
        exit 0
        ;;
    -*)
        echo "ci-logs: unknown option '$1' (try --failed, --list, <run> [job], or no arg)" >&2
        exit 2
        ;;
    *)
        # A bare number → that run; a second number → one job within it.
        if printf '%s' "$1" | grep -qE '^[0-9]+$'; then
            if [ $# -ge 2 ] && printf '%s' "$2" | grep -qE '^[0-9]+$'; then
                exec "$FJ" actions logs job "${REPO_ARGS[@]}" --run-index "$1" --job-index "$2"
            fi
            exec "$FJ" actions logs run "${REPO_ARGS[@]}" --run-index "$1"
        fi
        echo "ci-logs: expected a run number, got '$1'" >&2
        exit 2
        ;;
esac
