#!/usr/bin/env bash
# Builds the mod and runs the client game tests (fabric-client-gametest-api-v1) in a real client
# window, then copies the screenshots to docs/renders/mod-*.png.
#
#   tools/client-gametest.sh               singleplayer tests (prompt GUI, HUD, chat, auto-start, offline …)
#   tools/client-gametest.sh --dedicated   + multiplayer permission test against tools/testserver
#                                           (or $MCAI_TESTSERVER_DIR / $MCAI_TESTSERVER_PORT)
#                                           (needs the test server's EULA accepted, see tools/README.md)
#
# The mod starts tools/fake-engine.mjs itself through engine auto-start (no real engine, no AI cost).
# A hung client is killed after 4 minutes (Gradle task timeout).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEDICATED=0
[[ "${1:-}" == "--dedicated" ]] && DEDICATED=1
FAKE_PID=""
cleanup() {
  [[ -n "$FAKE_PID" ]] && kill "$FAKE_PID" 2>/dev/null || true
  if [[ $DEDICATED == 1 ]]; then "$ROOT/tools/testserver.sh" stop >/dev/null || true; fi
}
trap cleanup EXIT

"$ROOT/tools/mcgradle.sh" build -q
if [[ $DEDICATED == 1 ]]; then
  DED_HOME="$(mktemp -d)"
  node "$ROOT/tools/fake-engine.mjs" --home "$DED_HOME" --control-port 8798 >"${TMPDIR:-/tmp}/mcai-fake-engine-dedicated.log" 2>&1 &
  FAKE_PID=$!
  "$ROOT/tools/testserver.sh" stop >/dev/null || true
  MCAI_HOME="$DED_HOME" "$ROOT/tools/testserver.sh" start
  export MCAI_GAMETEST_DEDICATED="127.0.0.1:${MCAI_TESTSERVER_PORT:-25565}|8798"
fi
# macOS may stall an OpenGL window that is completely hidden behind other windows (buffer swap
# blocks); the Gradle task times out after 4 min — retry once in that case.
status=0
for attempt in 1 2; do
  status=0
  LOG="${TMPDIR:-/tmp}/mcai-client-gametest-$attempt.log"
  "$ROOT/tools/mcgradle.sh" runClientGameTest 2>&1 | tee "$LOG" || status=$?
  if [[ $status -ne 0 ]] && grep -q "Timeout has been exceeded" "$LOG" && ! grep -q "AssertionError" "$LOG"; then
    echo "client stalled (hidden window?) — retrying" >&2
    continue
  fi
  break
done
mkdir -p "$ROOT/docs/renders"
for f in "$ROOT"/mod/build/run/clientGameTest/screenshots/*_mod-*.png; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  cp "$f" "$ROOT/docs/renders/${name#*_}"
done
ls "$ROOT"/docs/renders/mod-*.png 2>/dev/null || true
exit $status
