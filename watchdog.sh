#!/bin/bash
# mcAI Watchdog — Monitor build queue and trigger opencode
#
# Monitors build_queue.json for new pending requests.
# When a request is found, invokes opencode non-interactively via 'opencode run'.
# Fully automatic: no user interaction needed.

PROJECT_DIR="/home/leandro/projects/mcAI"
QUEUE_FILE="$PROJECT_DIR/build_queue.json"
OPENCODE_BIN="/home/leandro/.opencode/bin/opencode"

echo "=== mcAI Watchdog (autonomous mode) ==="
echo "Queue:  $QUEUE_FILE"
echo "Agent:  mc-orchestrator (DeepSeek V4 Pro)"
echo "Workers: mc-worker-ds (DeepSeek V4 Flash)"
echo ""

LAST_PENDING=0
COOLDOWN=0

while true; do
  PENDING=0

  if [ -f "$QUEUE_FILE" ]; then
    PENDING=$(python3 -c "
import json
with open('$QUEUE_FILE') as f:
    q = json.load(f)
print(sum(1 for r in q if r.get('status') == 'pending'))
" 2>/dev/null || echo "0")
  fi

  if [ "$PENDING" -gt 0 ] && [ "$COOLDOWN" -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "  >>> $PENDING neue Build-Request(s)! <<<"
    echo "  >>> Starte opencode run (mc-orchestrator)..."
    echo "=========================================="
    echo ""

    # Mark all pending as building
    python3 -c "
import json
with open('$QUEUE_FILE') as f:
    q = json.load(f)
for r in q:
    if r['status'] == 'pending':
        r['status'] = 'building'
with open('$QUEUE_FILE', 'w') as f:
    json.dump(q, f)
print('Marked as building')
"

    # Run opencode non-interactively with the orchestrator agent
    cd "$PROJECT_DIR"
    "$OPENCODE_BIN" run \
      --agent mc-orchestrator \
      --dangerously-skip-permissions \
      "Verarbeite ALLE pending Build-Requests aus der Queue (mcai_mcai_mc_get_build_requests). Für jeden Request: mcai_mcai_mc_get_player_position, mcai_mcai_mc_get_biome, mcai_mcai_mc_get_world_state zur Analyse. Dann plane und baue in Phasen mit mcai_mcai_mc_fill_region und mcai_mcai_mc_execute_command. Nutze mc-worker-ds Subagenten für parallele Arbeiten. Nach jeder Phase Fortschritt per mcai_mcai_mc_send_chat melden. Am Ende mit mcai_mcai_mc_mark_build_done abschließen und Token-Report senden. Biome-Integration: oak in plains, spruce in taiga, sandstone in desert, etc. Riesige Bauten bei 'riesig/groß/gewaltig' (60-100+ Blöcke). Mehrere Materialvarianten für Textur-Tiefe."

    echo ""
    echo "=========================================="
    echo "  >>> Build abgeschlossen. Weiter im Monitoring..."
    echo "=========================================="
    echo ""

    # Cooldown to prevent rapid re-triggering
    COOLDOWN=5
  fi

  if [ "$COOLDOWN" -gt 0 ]; then
    COOLDOWN=$((COOLDOWN - 1))
  fi

  LAST_PENDING=$PENDING
  sleep 3
done
