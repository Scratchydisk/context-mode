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

# npm 11 gates dependency lifecycle scripts behind an allow-list. The project's own package.json
# carries `allowScripts` for its dependencies (better-sqlite3's native build, esbuild's binary), so
# the project-scoped install needs no flag. A global install has no project package.json to write
# to, so it takes the flag — without it the `prepare` hook (the build) and `postinstall` (the
# better-sqlite3 heal) are skipped and the install is broken. Older npm has no such flag and runs
# everything, so it is only added when npm understands it.
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
# No --allow-scripts here: npm rejects that flag in project-scoped installs. The project's own
# package.json carries `allowScripts` for its dependencies instead.
run npm --prefix "$FORK_DIR" install --no-audit --no-fund
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

# Prefer SSH when this machine has GitHub SSH access: HTTPS cloning over GnuTLS fails with a
# flaky handshake often enough to break the upgrade, and the SSH key is already set up for the push.
FORK_URL="https://github.com/$FORK_REPO.git"
if git ls-remote "git@github.com:$FORK_REPO.git" HEAD >/dev/null 2>&1; then
  FORK_URL="git@github.com:$FORK_REPO.git"
  info "using SSH for the upgrade clone"
else
  info "using HTTPS for the upgrade clone"
fi

if [ "$DRY_RUN" = "1" ]; then
  info "[dry-run] would write $FORK_JSON:"
  info '         {"repo": "'"$FORK_REPO"'", "url": "'"$FORK_URL"'", "package": ""}'
else
  cat > "$FORK_JSON" <<JSON
{
  "repo": "$FORK_REPO",
  "url": "$FORK_URL",
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
    run git -C "$CLAUDE_DIR" remote set-url origin "$FORK_URL"
    info "origin -> $FORK_URL"
  else
    warn "no Claude Code marketplace clone at $CLAUDE_DIR — skipping"
    info "if Claude Code installs context-mode, re-run with the clone present, or:"
    info "  git -C '$CLAUDE_DIR' remote set-url origin $FORK_URL"
  fi
fi

# ── 6. Wire the platforms ───────────────────────────────────────────────────────
# The config writes live in `context-mode upgrade`, not in this script: it knows each platform's
# config shape, the jsonc rules, which key each host version reads, and which registry entries to
# repoint. Calling it here means one command sets a machine up, instead of one command plus a
# reminder to run a second one.
#
#   context-mode upgrade --platform opencode
#     writes the `plugins` array pointing at this install (a bare "context-mode" spec would make
#     OpenCode npm-install upstream's build), and clears the legacy `plugin` key
#   context-mode upgrade --platform claude-code
#     repoints ~/.claude/plugins/known_marketplaces.json at the fork — left at upstream, the next
#     marketplace refresh re-clones upstream and reinstalls the plugin from upstream's build
wire() {
  local platform="$1"
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] would run: context-mode upgrade --platform $platform"
    return 0
  fi
  say "Wiring $platform"
  if node "$FORK_DIR/cli.bundle.mjs" upgrade --platform "$platform"; then
    info "$platform wired"
  else
    warn "the $platform upgrade did not complete — re-run 'context-mode upgrade --platform $platform'"
  fi
}

if [ "$SKIP_OPENCODE" = "1" ]; then
  warn "skipping the OpenCode config"
elif ! command -v opencode >/dev/null 2>&1; then
  warn "opencode is not on PATH — skipping the OpenCode config"
  info "install OpenCode, then run: context-mode upgrade --platform opencode"
else
  OC_MAJOR="$(opencode --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1 | cut -d. -f1 || true)"
  info "OpenCode ${OC_MAJOR:-?} detected"
  wire opencode
fi

if [ "$SKIP_CLAUDE" = "1" ]; then
  warn "skipping the Claude Code config"
elif [ -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ]; then
  wire claude-code
else
  info "no Claude Code config at ${CLAUDE_CONFIG_DIR:-$HOME/.claude} — skipping"
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
if command -v opencode >/dev/null 2>&1; then
  info "restart:       restart OpenCode so it picks up the plugin"
fi
