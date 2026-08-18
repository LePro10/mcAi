# mcAI — Agent Guide für nächste AI Session

## System-Übersicht

```
Minecraft Server (PaperMC 1.21.4)  ←→  Bot Daemon (Mineflayer)  ←→  MCP Server  ←→  opencode
     :25565                               :8765 HTTP API                stdio          Agents
```

## Wichtige Dateien

| Datei | Zweck |
|-------|-------|
| `mcp-minecraft/bot-daemon.mjs` | Haupt-Bot mit Persistent RCON, HTTP API, Build-Processing |
| `mcp-minecraft/src/index.ts` | MCP Server (TypeScript → dist/index.js) |
| `.opencode/agents/mc-orchestrator.md` | Orchestrator Prompt (DeepSeek V4 Pro) |
| `.opencode/agents/mc-worker-ds.md` | Worker Prompt (DeepSeek V4 Flash) |
| `.opencode/opencode.jsonc` | MCP Config (mcai Server) |
| `start.sh` | Startet MC Server + Bot Daemon |
| `stop.sh` | Stoppt alle Prozesse |

## Aktuelle Architektur

### Bot Daemon (`bot-daemon.mjs`)
- **Persistent RCON**: Eine TCP-Connection wird gehalten (kein Reconnect pro Command)
- **HTTP API**: localhost:8765 mit Endpoints für Commands, World State, Chat, etc.
- **Build Processing**: Spawned opencode als Child Process bei `!build` Chat-Command
- **Chat Rate Limiter**: 500ms zwischen Nachrichten
- **Bot-Chat Fallback**: Wenn RCON nach 2s nicht antwortet, nutzt Bot `bot.chat("/command")`

### MCP Server (`src/index.ts`)
- **14 Tools**: mc_get_world_state, mc_fill_region, mc_setblock, mc_execute_command, etc.
- **Kein Teleport-Spam**: Commands laufen server-side via RCON
- **Prefix**: Tools werden als `mc_*` registriert (kein `mcai_` Prefix mehr)

### Wichtige Endpoints
```
GET  /status              → Bot-Status, Position, Biome, RCON-Status
GET  /queue               → Pending Build-Requests
GET  /world?x1=...        → Blöcke in Region (max 50000)
GET  /biome?x=...         → Biome an Position
GET  /entities?radius=50  → Entities im Radius
GET  /player/:name        → Spieler-Position
GET  /activity?limit=30   → Build-Log

POST /command             → Minecraft Command ausführen (RCON)
POST /chat                → Chat-Nachricht senden
POST /tp                  → Bot teleportieren (nur einmal am Build-Start)
POST /item                → Bot Item geben
POST /queue/:id           → Build-Status updaten
```

## Bekannte Probleme & Lösungen

### 1. RCON Auth-Bug (GEFIXT)
**Problem**: RCON hat SUCCESS als FAILURE erkannt (`pktType === 2` + `pktId === 0` = SUCCESS, nicht FAILED)
**Lösung**: `_processBuffer()` Logik korrigiert

### 2. Bot wird gekickt (GEFIXT)
**Problem**: Bot wurde vor jedem Command teleportiert → Server kickt wegen Spam
**Lösung**: Teleports entfernt, Commands laufen server-side via RCON

### 3. MCP Tools nicht verfügbar (GEFIXT)
**Problem**: opencode hat lokale Config nicht geladen, AI sah nur Blender-Tools
**Lösung**: mcai-Config in globale `~/.config/opencode/opencode.jsonc` hinzugefügt

### 4. Watchdog Race Condition (GEFIXT)
**Problem**: Watchdog + bot-daemon haben beide Builds getriggert
**Lösung**: Watchdog aus start.sh entfernt

### 5. Biome immer "unknown" (GEFIXT)
**Problem**: Biome wurde vom Block IN der Bot-Position gelesen (solid block)
**Lösung**: Surface-Scan von y=320 nach unten

## Build-Workflow

1. User tippt `!build <prompt>` im Minecraft-Chat
2. Bot fängt Command auf, schreibt Request in `build_queue.json`
3. Bot spawned opencode als Child Process mit `--agent mc-orchestrator`
4. Orchestrator plant Build (JSON-Structure oder Block-für-Block)
5. MCP Tools werden aufgerufen (mc_fill_region, mc_setblock, etc.)
6. Commands gehen über HTTP API → RCON → Minecraft Server
7. Bei Erfolg: `mc_mark_build_done` → Queue-Status update
8. Bot sendet Fertig-Nachricht im Chat

## Performance-Optimierungen

### RCON
- Persistent Connection (kein Reconnect pro Command)
- 5s Timeout für Commands
- Bot-Chat Fallback nach 2s

### Build-Processing
- Kurzer Prompt (~150 Zeichen statt 500+)
- Kein Teleport vor jedem Command
- 50ms Delay zwischen Commands (statt 500ms+)

### AI
- Sofort-Modus für kleine Builds (≤3x3x3): Direkt bauen, keine Analyse
- Plan-Modus für große Builds: Analyse → Plan → Loop
- DeepSeek V4 Pro für Orchestrator, Flash für Worker

## Nützliche Commands

### Server-Management
```bash
./start.sh              # Startet alles
./stop.sh               # Stoppt alles
tail -f mcp-minecraft/bot.log  # Logs beobachten
```

### Minecraft Commands
```
!build <prompt>         # Build anfordern
!thinking               # AI-Status anzeigen
!status                 # System-Status
!cancel                 # Aktuellen Build abbrechen
```

### Debugging
```bash
curl http://127.0.0.1:8765/status
curl http://127.0.0.1:8765/queue
curl http://127.0.0.1:8765/activity?limit=50
```

## Next Steps (IMPLEMENTATION_PLAN.md)

1. **JSON Structure Builder** (Woche 1)
   - `mc_build_structure` Tool
   - JSON → Commands Konverter
   - Layer-Typen (solid, hollow, roof, etc.)

2. **Welt-Scanner mit JSON-Output** (Woche 1-2)
   - `mc_get_world_state_json` Tool
   - Strukturierte JSON-Ausgabe mit Stats

3. **Copy/Paste System** (Woche 2)
   - `mc_copy_to_clipboard` / `mc_paste_from_clipboard`
   - WorldEdit-Integration

4. **Struktur Speichern/Laden** (Woche 2-3)
   - `mc_save_structure` / `mc_load_structure`
   - JSON-Dateien in `structures/` Verzeichnis

5. **Batch Operations** (Woche 3)
   - `mc_replace_blocks` / `mc_fill_pattern`
   - Checkerboard, Stripes, Random-Mix

6. **Adaptive Terrain Integration** (Woche 3-4)
   - `mc_get_terrain_profile` Tool
   - Fundament folgt dem Terrain

7. **Stil-Bibliothek** (Woche 4)
   - `mc_get_style` Tool
   - Medieval, Modern, Fantasy, etc.

## Wichtige Konstanten

```javascript
const MC_USERNAME = "AIBuilder";
const RCON_PORT = 25575;
const RCON_PASSWORD = "mcai2026";
const HTTP_PORT = 8765;
const MC_PORT = 25565;
```

## Offline-Mode UUID für AIBuilder
```
596f2548-5d8a-d0c5-f20e-51e97bf6c5f3
```
(Bereits in ops.json mit Level 4)

## Tipps für nächste Session

1. **Teste RCON zuerst**: `curl -X POST http://127.0.0.1:8765/command -H 'Content-Type: application/json' -d '{"command":"time set day"}'`
2. **Check MCP Tools**: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp-minecraft/dist/index.js`
3. **Bot-Log beobachten**: `tail -f mcp-minecraft/bot.log` während Builds
4. **Queue managen**: `cat build_queue.json` um Status zu sehen
5. **Bei RCON-Problemen**: Bot-Daemon neu starten, nicht den MC Server
