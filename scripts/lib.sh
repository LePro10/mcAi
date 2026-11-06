# shellcheck shell=bash
# Shared helpers for ./mcai and scripts/server.sh (bash 3.2+, macOS + Linux). Source, don't run.

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENGINE_DIR="$ROOT/engine"
MCAI_HOME="${MCAI_HOME:-$HOME/.mcai}"
export MCAI_HOME
LOG_DIR="$MCAI_HOME/logs"
ENGINE_LOG="$LOG_DIR/engine.log"
ENGINE_PID="$MCAI_HOME/engine.pid"
NODE="${MCAI_NODE:-$(command -v node 2>/dev/null || true)}"

# ---------------------------------------------------------------- output
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  B=$'\033[1m' D=$'\033[2m' R=$'\033[31m' G=$'\033[32m' Y=$'\033[33m' BL=$'\033[34m' C=$'\033[36m' N=$'\033[0m'
else
  B='' D='' R='' G='' Y='' BL='' C='' N=''
fi
step() { printf '\n%s==>%s %s%s%s\n' "$B$BL" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
info() { printf '  %s•%s %s\n' "$D" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
err()  { printf '  %s✘%s %s\n' "$R" "$N" "$*" >&2; }
# die <message> [exit code] [fix hint]
die()  { printf '\n%s✘ %s%s\n' "$R" "$1" "$N" >&2; [[ -n "${3:-}" ]] && printf '  %sfix:%s %s\n' "$B" "$N" "$3" >&2; exit "${2:-1}"; }

# ---------------------------------------------------------------- preflight
need_node() {
  [[ -n "$NODE" && -x "$NODE" ]] || die "Node.js not found" 1 "install Node.js ≥ 22.18 (https://nodejs.org) — e.g. 'brew install node'"
  local v; v=$("$NODE" -p 'process.versions.node')
  local maj=${v%%.*} rest=${v#*.}; local min=${rest%%.*}
  if (( maj < 22 || (maj == 22 && min < 18) )); then
    die "Node.js $v is too old (need ≥ 22.18: TypeScript runs natively)" 1 "update Node.js (https://nodejs.org)"
  fi
}

# Install engine dependencies if missing or older than package-lock.json. $1 = dry-run flag
need_engine_deps() {
  local lock="$ENGINE_DIR/package-lock.json" mark="$ENGINE_DIR/node_modules/.package-lock.json"
  if [[ -d "$ENGINE_DIR/node_modules" && -f "$mark" && ! "$lock" -nt "$mark" ]]; then return 0; fi
  if [[ "${1:-}" == dry ]]; then info "[dry-run] would run 'npm ci' in engine/"; return 0; fi
  command -v npm >/dev/null || die "npm not found" 1 "install Node.js with npm (https://nodejs.org)"
  info "installing engine dependencies (npm ci) …"
  (cd "$ENGINE_DIR" && npm ci --no-audit --no-fund --loglevel=error) || die "npm ci failed in $ENGINE_DIR" 1 "check your network/npm registry access, then: (cd engine && npm ci)"
}

# Prints a JAVA_HOME with Java ≥ 25 (JAVA_HOME, ~/.mcai-tools/jdk-*, java_home, the launcher's runtime, PATH).
java_home() { "$NODE" "$ROOT/scripts/lib/common.mjs" java-home 25; }
need_java() {
  JAVA_HOME_FOUND=$(java_home) || die "Java 25 not found (needed for the server and to build the mod)" 1 \
    "install a JDK 25 (e.g. https://adoptium.net) or set JAVA_HOME; after the Minecraft Launcher has started 26.3 once, its bundled Java is found automatically"
  JAVA_BIN="$JAVA_HOME_FOUND/bin/java"
}

claude_bin() {
  local p
  p=$("$NODE" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(c.claudePath)console.log(c.claudePath)}catch{}' "$MCAI_HOME/config.json" 2>/dev/null)
  [[ -n "${MCAI_CLAUDE:-}" ]] && p="$MCAI_CLAUDE"
  [[ -z "$p" ]] && p=$(command -v claude 2>/dev/null || true)
  [[ -n "$p" ]] && command -v "$p" >/dev/null 2>&1 && echo "$p"
}
check_claude() {
  local cb; cb=$(claude_bin || true)
  if [[ -z "$cb" ]]; then
    warn "Claude Code CLI ('claude') not found — the engine needs it for AI builds"
    info "install: npm install -g @anthropic-ai/claude-code   then run 'claude' once and log in (/login)"
    return 1
  fi
  ok "claude: $("$cb" --version 2>/dev/null | head -n1) ${D}($cb)${N}"
  info "not logged in yet? run '${B}claude${N}' once and use /login (a Claude subscription or API key is required)"
}

# ---------------------------------------------------------------- engine
# engine_json_field <field>  (port|token|pid) — empty if no engine.json
engine_json_field() {
  [[ -f "$MCAI_HOME/engine.json" ]] || return 1
  "$NODE" -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];if(v===undefined)process.exit(1);console.log(v)}catch{process.exit(1)}' "$MCAI_HOME/engine.json" "$1"
}
pid_alive() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }
engine_pid() { local p; p=$(engine_json_field pid 2>/dev/null) && pid_alive "$p" && echo "$p"; }
engine_port() { engine_json_field port 2>/dev/null; }
engine_url() { echo "http://127.0.0.1:$(engine_port)"; }
# engine_status → JSON of /api/status (exit 1 if not answering)
engine_status() {
  local port; port=$(engine_port) || return 1
  curl -fsS --max-time 4 "http://127.0.0.1:$port/api/status" 2>/dev/null
}
# json_get '<json>' 'expr on j'  e.g. json_get "$s" 'j.mod.connected'
json_get() { "$NODE" -e 'const j=JSON.parse(process.argv[1]);const v=eval(process.argv[2]);console.log(v===undefined||v===null?"":v)' "$1" "$2" 2>/dev/null; }

engine_running() { engine_pid >/dev/null && engine_status >/dev/null; }

# engine_start <sim|minecraft> [seed]
engine_start() {
  local mode="$1" seed="${2:-}" st backend want
  [[ "$mode" == sim ]] && want=sim || want=minecraft
  if engine_pid >/dev/null; then
    if st=$(engine_status); then
      backend=$(json_get "$st" 'j.backend')
      if [[ "$backend" == "$want" ]]; then ok "engine already running (pid $(engine_pid), $backend world) — $(engine_url)"; return 0; fi
      if [[ "$(json_get "$st" 'j.jobs.active')" != 0 ]]; then
        die "the running engine is in '$backend' mode and has active build jobs" 1 "wait for them or cancel them, then: ./mcai stop && ./mcai ${MCAI_CMD:-start}"
      fi
      info "engine is running in '$backend' mode — restarting it in '$want' mode"
      engine_stop quiet
    else
      die "an engine process (pid $(engine_pid)) exists but does not answer on port $(engine_port)" 1 "./mcai stop   (or kill $(engine_pid))"
    fi
  fi
  need_engine_deps
  mkdir -p "$LOG_DIR"; chmod 700 "$MCAI_HOME" 2>/dev/null || true
  # rotate logs > 10 MB
  if [[ -f "$ENGINE_LOG" ]] && (( $(wc -c < "$ENGINE_LOG") > 10485760 )); then mv -f "$ENGINE_LOG" "$ENGINE_LOG.1"; fi
  local args=(serve)
  [[ "$want" == sim ]] && args+=(--sim) && [[ -n "$seed" ]] && args+=(--seed "$seed")
  printf '\n----- %s  mcai %s -----\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${args[*]}" >> "$ENGINE_LOG"
  ( cd "$ENGINE_DIR" && exec nohup "$NODE" src/cli.ts "${args[@]}" >> "$ENGINE_LOG" 2>&1 < /dev/null ) &
  local pid=$!
  echo "$pid" > "$ENGINE_PID"
  local i
  for i in $(seq 1 60); do
    if ! pid_alive "$pid"; then
      tail -n 20 "$ENGINE_LOG" >&2
      rm -f "$ENGINE_PID"
      die "the engine exited during startup (log: $ENGINE_LOG)" 1 "./mcai doctor"
    fi
    if [[ "$(engine_json_field pid 2>/dev/null)" == "$pid" ]] && engine_status >/dev/null; then
      ok "engine started (pid $pid, $want world) — $(engine_url)  ${D}log: $ENGINE_LOG${N}"
      return 0
    fi
    sleep 0.5
  done
  die "the engine did not answer within 30 s (log: $ENGINE_LOG)" 1 "./mcai logs engine"
}

engine_stop() {
  local pid; pid=$(engine_pid || true)
  [[ -z "$pid" && -f "$ENGINE_PID" ]] && pid=$(cat "$ENGINE_PID") && ! pid_alive "$pid" && pid=""
  if [[ -z "$pid" ]]; then [[ "${1:-}" == quiet ]] || info "engine not running"; rm -f "$ENGINE_PID"; return 0; fi
  kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 40); do pid_alive "$pid" || break; sleep 0.5; done
  if pid_alive "$pid"; then warn "engine did not stop within 20 s — killing it"; kill -KILL "$pid" 2>/dev/null || true; sleep 0.5; fi
  rm -f "$ENGINE_PID"
  # a killed engine leaves its engine.json behind; remove it only if it is the one we stopped
  [[ "$(engine_json_field pid 2>/dev/null)" == "$pid" ]] && rm -f "$MCAI_HOME/engine.json"
  [[ "${1:-}" == quiet ]] || ok "engine stopped"
}

open_url() {
  if [[ "$(uname)" == Darwin ]]; then open "$1"; elif command -v xdg-open >/dev/null; then xdg-open "$1" >/dev/null 2>&1 & fi
}
