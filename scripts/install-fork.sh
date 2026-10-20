#!/usr/bin/env bash
# scripts/install-fork.sh — install this fork on a machine and keep it pointed at the fork.
#
# A fork install differs from an upstream install in three ways, and this script handles all three:
#
#   1. The code comes from the fork, not from npm's `context-mode` package.
#   2. `/ctx-upgrade` must clone the FORK. Left alone it clones upstream and copies upstream's files
#      over the install, silently dropping every fix the fork carries.
#   3. The npm "a new version is available" check must not compare this build against upstream's
#      release, and OpenCode 2 must load this build rather than npm-installing the `context-mode`
#      package (which is upstream's).
#
# Usage:
#   scripts/install-fork.sh                       # install from the fork repo on GitHub
#   scripts/install-fork.sh --dir /path/to/clone  # install from a local checkout (e.g. this repo)
#   scripts/install-fork.sh --dry-run             # print what would change, change nothing
#
# Options:
#   --repo owner/name   fork repository (default: Scratchydisk/context-mode)
#   --dir PATH          local checkout to install from (default: ~/.local/share/context-mode-fork)
#   --dry-run           print the plan, make no changes
#   --skip-opencode     do not touch the OpenCode config
#   --skip-claude       do not repoint the Claude Code marketplace clone
set -euo pipefail

FORK_REPO="${FORK_REPO:-Scratchydisk/context-mode}"
FORK_DIR="${FORK_DIR:-$HOME/.local/share/context-mode-fork}"
DRY_RUN=0
SKIP_OPENCODE=0
SKIP_CLAUDE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) FORK_REPO="$2"; shift 2 ;;
    --dir) FORK_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-opencode) SKIP_OPENCODE=1; shift ;;
    --skip-claude) SKIP_CLAUDE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    warning:\033[0m %s\n' "$*"; }
run()  { if [ "$DRY_RUN" = "1" ]; then info "[dry-run] $*"; else "$@"; fi; }

command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

# npm 11 gates lifecycle scripts behind an allow-list. Without this, `prepare` (the build) and
# `postinstall` (the better-sqlite3 heal) are skipped and the install is broken. Older npm has no
# such flag and runs everything, so the flag is only added when npm understands it.
ALLOW_SCRIPTS=""
if npm install --help 2>&1 | grep -q -- "--allow-scripts"; then
  ALLOW_SCRIPTS="--allow-scripts=context-mode,better-sqlite3,esbuild"
fi

FORK_JSON="$HOME/.context-mode/fork.json"

say "Fork install"
info "repo:   $FORK_REPO"
info "dir:    $FORK_DIR"
[ "$DRY_RUN" = "1" ] && info "(dry run — nothing is changed)"

# ── 1. Get the source ───────────────────────────────────────────────────────────
if [ -d "$FORK_DIR/.git" ]; then
  say "Updating the existing checkout"
  run git -C "$FORK_DIR" fetch --quiet origin
  run git -C "$FORK_DIR" checkout --quiet --detach FETCH_HEAD
  info "at $(git -C "$FORK_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
else
  say "Cloning $FORK_REPO"
  run git clone --quiet "https://github.com/$FORK_REPO.git" "$FORK_DIR"
fi

# ── 2. Build ────────────────────────────────────────────────────────────────────
say "Installing dependencies and building"
# shellcheck disable=SC2086
run npm --prefix "$FORK_DIR" install --no-audit --no-fund $ALLOW_SCRIPTS
run npm --prefix "$FORK_DIR" run build
if [ "$DRY_RUN" != "1" ] && [ ! -f "$FORK_DIR/build/cli.js" ]; then
  echo "Build did not produce build/cli.js — aborting." >&2
  exit 1
fi

# ── 3. Install globally ─────────────────────────────────────────────────────────
# This replaces the global `context-mode` package. On a machine where it was installed through
# the Claude Code plugin marketplace it is a symlink into ~/.claude/plugins/cache/...; npm
# removes the symlink, not the cache directory it points at.
#
# A local-path install is linked, not copied: the global `context-mode` always runs the code in
# $FORK_DIR, so an edit there takes effect on the next run.
say "Installing globally"
info "this replaces the global 'context-mode' package"
# shellcheck disable=SC2086
run npm install -g --no-audit --no-fund $ALLOW_SCRIPTS "$FORK_DIR"

# ── 4. Point the upgrade at the fork ────────────────────────────────────────────
# Without this, /ctx-upgrade clones upstream and overwrites the install with upstream's files.
say "Pointing the upgrade at the fork"
run mkdir -p "$(dirname "$FORK_JSON")"
if [ "$DRY_RUN" = "1" ]; then
  info "[dry-run] would write $FORK_JSON:"
  info '         {"repo": "'"$FORK_REPO"'"}'
else
  cat > "$FORK_JSON" <<JSON
{
  "repo": "$FORK_REPO",
  "package": ""
}
JSON
  info "wrote $FORK_JSON"
  info "an empty package disables the npm version check (this build is not on npm)"
fi

# ── 5. Repoint the Claude Code marketplace clone ────────────────────────────────
# Claude Code's plugin manager keeps its own clone; /ctx-upgrade syncs it to origin/HEAD, so
# pointing it at the fork keeps /ctx-upgrade pulling fork code.
if [ "$SKIP_CLAUDE" = "1" ]; then
  warn "skipping the Claude Code marketplace clone"
else
  CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/context-mode"
  if [ -d "$CLAUDE_DIR/.git" ]; then
    say "Repointing the Claude Code marketplace clone at the fork"
    run git -C "$CLAUDE_DIR" remote set-url origin "https://github.com/$FORK_REPO.git"
    info "origin -> https://github.com/$FORK_REPO.git"
  else
    warn "no Claude Code marketplace clone at $CLAUDE_DIR — skipping"
    info "if Claude Code installs context-mode, re-run with the clone present, or:"
    info "  git -C '$CLAUDE_DIR' remote set-url origin https://github.com/$FORK_REPO.git"
  fi
fi

# ── 6. Wire OpenCode 2 ──────────────────────────────────────────────────────────
# OpenCode 2 reads the `plugins` array. A bare "context-mode" entry is an npm package name:
# OpenCode would install upstream's build from the registry. The install must therefore point at
# this install's own directory.
if [ "$SKIP_OPENCODE" = "1" ]; then
  warn "skipping the OpenCode config"
elif ! command -v opencode >/dev/null 2>&1; then
  warn "opencode is not on PATH — skipping the OpenCode config"
else
  OC_MAJOR="$(opencode --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1 | cut -d. -f1 || true)"
  if [ "${OC_MAJOR:-0}" -lt 2 ] 2>/dev/null; then
    say "OpenCode ${OC_MAJOR:-?} detected — leaving the config alone"
    info "OpenCode 1 uses the legacy 'plugin' key; the fork's setup writes it"
  else
    say "Wiring OpenCode ${OC_MAJOR}.x"
    info "run: context-mode upgrade   (writes the 'plugins' entry pointing at this install)"
  fi
fi

# ── 7. Verify ───────────────────────────────────────────────────────────────────
say "Done"
if [ "$DRY_RUN" != "1" ]; then
  info "global package: $(npm ls -g context-mode --depth=0 2>/dev/null | grep -o 'context-mode@[^ ]*' | head -1 || echo 'context-mode')"
  info "fork config:    $FORK_JSON"
fi
info "check with:    context-mode doctor"
info "upgrade with:  context-mode upgrade   (pulls $FORK_REPO)"
info "note:          'npm update -g context-mode' still pulls upstream — the package name is the same"
