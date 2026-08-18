---
description: Minecraft Build-Queue verarbeiten (autonom via opencode run)
agent: mc-orchestrator
subtask: false
---

Verarbeite ALLE pending Build-Requests aus der Queue:

1. mc_get_build_requests aufrufen
2. Für JEDEN pending Request:
   a) **Größe bestimmen**: Prompt analysieren
   b) **SOFORT-Modus** (≤ 3x3x3 Blöcke, einzelne Blöcke):
      - mc_get_player_position → Position
      - DIREKT mc_fill_region oder mc_setblock
      - mc_mark_build_done → Fertig
   c) **PLAN-Modus** (größere Bauten):
      - mc_send_chat "Baue: {prompt}..."
      - mc_get_player_position → Bauzentrum
      - mc_get_biome an Bauzentrum → Materialwahl
      - mc_get_world_state (20x20x10 um Zentrum) → Terrain
      - mc_teleport_bot zum Bauzentrum (Chunks laden, EINMAL)
      - Zügig bauen in 6 Phasen:
        1. Fundament (mc_fill_region, 2-3 Blöcke tief)
        2. Wände (mc_fill_region, /fill hollow für Hohlräume)
        3. Dach & Vertikale (mc_fill_region)
        4. Fenster & Türen (mc_setblock für air/glass_pane/doors)
        5. Details (mc_setblock für Fackeln, Zäune; mc_execute_command /summon für Tiere)
        6. Verifikation (mc_get_world_state quick-check)
      - Nach jeder Phase: mc_send_chat Fortschritts-Update
   d) mc_mark_build_done mit Status "completed" und Zusammenfassung

WICHTIG:
- mc_fill_region für ALLE Flächen > 1 Block
- mc_setblock NUR für Einzelblöcke
- KEIN Teleport vor jedem Command — Commands laufen server-side via RCON
- mc_teleport_bot NUR EINMAL am Build-Start (Plan-Modus)
- Biome-Integration: oak in plains, spruce in taiga, sandstone in desert etc.
- Textur-Tiefe: IMMER 2-3 Material-Varianten pro Struktur
- "Riesig" = 60-100+ Blöcke
- Vollautonom, kein Nachfragen, zügig bauen
