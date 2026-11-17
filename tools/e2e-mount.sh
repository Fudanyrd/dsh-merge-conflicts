#!/usr/bin/env bash
# =============================================================================
# dsh-merge-conflicts mount smoke (CI + local).
#
# Mirrors the dsh-better-sidebar mount lane, adapted for a plugin that
# consumes dsh-better-sidebar instead of shipping it:
#
#   1. Boot a brand-new scratch web profile (the same three-file bootstrap the
#      official installers write);
#   2. Install the pinned dsh-better-sidebar release first, then the packed
#      plugin tarball, through the official `dsh plugin add` channel — the same
#      path a user takes, so `dsh.profile.bundles` coordination is exercised;
#   3. Start a real keyless `dsh web` (`--port 0`, OS-assigned port);
#   4. Run the Playwright headless-render lane (tests/e2e): assert the shell
#      and dsh-better-sidebar host mount, open the plugin's registered tab, and
#      prove the plugin's own view renders without crashing.
#
# Usage:
#   bash scripts/e2e-mount.sh
#
# Environment variables (all optional):
#   DSH_CMD          dsh command; defaults to `dsh` on PATH, falling back to
#                    `npx -y --package @deepseek-ai/dsh@<DSH_VERSION> dsh`.
#   DSH_VERSION      pinned deepseek-harness CLI version (default 0.2.2-rc.1).
#   SIDEBAR_VERSION  pinned dsh-better-sidebar version (default 0.32.0).
#   TARBALL          plugin tarball; defaults to the newest
#                    dsh-merge-conflicts-*.tgz in the repo root.
#   PORT             fixed port (default 0 = OS-assigned).
#   DSH_HOME_BASE    scratch root (default system temp). Always a NEW
#                    subdirectory owned by this invocation; the given base
#                    itself is never written or removed.
#   KEEP_HOME        non-empty keeps the scratch home for debugging.
#
# Exit code = Playwright's exit code; the server and scratch directory are
# cleaned up by an EXIT trap.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DSH_CMD="${DSH_CMD:-dsh}"
DSH_VERSION="${DSH_VERSION:-0.2.2-rc.1}"
SIDEBAR_VERSION="${SIDEBAR_VERSION:-0.32.0}"
PORT="${PORT:-0}"
TARBALL="${TARBALL:-}"
DSH_HOME_BASE="${DSH_HOME_BASE:-}"
KEEP_HOME="${KEEP_HOME:-}"

say()  { printf '\033[32m[merge-conflicts-mount]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[merge-conflicts-mount]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[merge-conflicts-mount]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required (Node >= 20)"
command -v pnpm >/dev/null 2>&1 || die "pnpm is required (dsh plugin forwards to pnpm)"

# ── DSH_CMD resolution ───────────────────────────────────────────────────────
# Prefer `dsh` on PATH; otherwise fall back to npx with the pinned version
# (same as dsh-better-sidebar's e2e-common.sh). DSH_VERSION must be an exact
# version, not a dist-tag.
DSH_NPX_SPEC="@deepseek-ai/dsh@${DSH_VERSION}"
explicit_dsh="$DSH_CMD"
if ! command -v "$DSH_CMD" >/dev/null 2>&1; then
  if command -v npx >/dev/null 2>&1; then
    say "no ${DSH_CMD} on PATH; falling back to npx -y --package ${DSH_NPX_SPEC}"
    DSH_CMD="npx -y --package ${DSH_NPX_SPEC} dsh"
  else
    die "found neither ${DSH_CMD} nor npx; install @deepseek-ai/dsh@${DSH_VERSION} first"
  fi
fi

# The resolved CLI version must match the baseline; when DSH_CMD is set
# explicitly we only warn, not block.
actual_version="$($DSH_CMD --version 2>/dev/null | tr -d '[:space:]' | head -c 64 || true)"
case "$actual_version" in
  "$DSH_VERSION"|"$DSH_VERSION"*) ;;
  *)
    if [ "$explicit_dsh" = "dsh" ] && [ -n "$actual_version" ]; then
      die "dsh on PATH is ${actual_version:-unknown}, this repo's baseline is ${DSH_VERSION}. Install that version or pass it via DSH_CMD."
    fi
    warn "DSH_CMD version is ${actual_version:-unknown}, baseline is ${DSH_VERSION}."
    ;;
esac

# ── tarball resolution ───────────────────────────────────────────────────────
if [ -z "$TARBALL" ]; then
  TARBALL="$(ls -t "$ROOT"/dsh-merge-conflicts-*.tgz 2>/dev/null | head -1 || true)"
  local_count="$(ls "$ROOT"/dsh-merge-conflicts-*.tgz 2>/dev/null | wc -l | tr -d ' ' || true)"
  [ "$local_count" -le 1 ] || warn "found $local_count tarballs; using the newest by mtime: $(basename "$TARBALL")"
fi
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "tarball not found (TARBALL or \$ROOT/dsh-merge-conflicts-*.tgz) — run pnpm build && pnpm pack first"
# pnpm (via dsh plugin) needs a native path: MSYS `/d/...` is not a valid
# Windows path, so convert with cygpath when available (Linux CI keeps `pwd`).
if command -v cygpath >/dev/null 2>&1; then
  TARBALL_ABS="$(cygpath -m "$TARBALL")"
else
  TARBALL_ABS="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
fi
say "tarball: $TARBALL_ABS"

# ── scratch home ─────────────────────────────────────────────────────────────
SCRATCH="$(mktemp -d "${DSH_HOME_BASE:-/tmp}/dsh-merge-conflicts-mount.XXXXXX")"
export DSH_HOME="$SCRATCH/home"
WORKSPACE_DIR="$SCRATCH/workspace"
WEB_LOG="$SCRATCH/web.log"
PROFILE_DIR="$DSH_HOME/profiles/web"
mkdir -p "$PROFILE_DIR" "$WORKSPACE_DIR"
say "scratch home: ${DSH_HOME}"

SERVER_PID=""
cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -z "$KEEP_HOME" ]; then
    rm -rf "$SCRATCH"
  else
    warn "KEEP_HOME is set; keeping $SCRATCH"
  fi
  exit "$code"
}
trap cleanup EXIT

# ── scratch profile bootstrap ────────────────────────────────────────────────
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

minimumReleaseAgeExclude:
  - dsh-better-sidebar
  - dsh-merge-conflicts
  - '@deepseek-ai/*'
EOF

# ── real install path: sidebar host first, then the plugin ───────────────────
say "installing dsh-better-sidebar@${SIDEBAR_VERSION} ..."
( cd "$PROFILE_DIR" && $DSH_CMD plugin --profile web add "dsh-better-sidebar@${SIDEBAR_VERSION}" )

say "installing plugin tarball ..."
( cd "$PROFILE_DIR" && $DSH_CMD plugin --profile web add "file:$TARBALL_ABS" )

# ── assert the mount registered in dsh.profile.bundles ───────────────────────
if ! node -e '
  const fs = require("node:fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const bundles = p.dsh?.profile?.bundles ?? [];
  const missing = ["dsh-better-sidebar", "dsh-merge-conflicts"].filter((id) => !bundles.includes(id));
  const sidebarVersion = (p.dependencies?.["dsh-better-sidebar"] ?? "").replace(/^[~^]/, "");
  const versionOk = sidebarVersion === process.argv[2];
  if (!versionOk) console.error("dsh-better-sidebar version mismatch: " + sidebarVersion + " != " + process.argv[2]);
  process.exit(missing.length === 0 && versionOk ? 0 : 1);
' "$PROFILE_DIR/package.json" "$SIDEBAR_VERSION"; then
  warn "dsh-better-sidebar or dsh-merge-conflicts did not mount correctly (bundles or version mismatch) — mount not registered"
  cat "$PROFILE_DIR/package.json"
  exit 1
fi
say "mount registered: dsh.profile.bundles contains dsh-better-sidebar@${SIDEBAR_VERSION} and dsh-merge-conflicts"

# ── start real dsh web ───────────────────────────────────────────────────────
say "starting dsh web (port=${PORT})..."
$DSH_CMD web --port "$PORT" --no-open > "$WEB_LOG" 2>&1 &
SERVER_PID=$!

URL=""
for _ in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "=== dsh web exited early; log tail ===" >&2
    tail -30 "$WEB_LOG" >&2 || true
    exit 1
  fi
  URL="$(grep -oE 'dsh web: http://127\.0\.0\.1:[0-9]+[^ ]*' "$WEB_LOG" | head -1 | awk '{print $NF}' || true)"
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "=== dsh web not ready within 120s; log tail ===" >&2
  tail -40 "$WEB_LOG" >&2 || true
  exit 1
fi
say "dsh web ready: ${URL}"

# ── headless-render lane ─────────────────────────────────────────────────────
say "running Playwright headless-render lane ..."
DSH_E2E_URL="$URL" DSH_E2E_WORKSPACE="$WORKSPACE_DIR" \
  pnpm exec playwright test

say "passed: plugin mounted on real DSH + dsh-better-sidebar ${SIDEBAR_VERSION} without crashing"
