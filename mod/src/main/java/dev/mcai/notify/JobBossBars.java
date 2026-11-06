package dev.mcai.notify;

import com.google.gson.JsonObject;
import dev.mcai.protocol.Json;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerBossEvent;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.BossEvent;

/**
 * job_update → one boss bar per job, shown to the requesting player (progress + stage).
 * Final states (done/failed/cancelled) show briefly, then the bar is removed. Server thread.
 */
public final class JobBossBars {
	private static final int LINGER_TICKS = 60;

	private static final class Bar {
		final ServerBossEvent event;
		String player;
		int removeAtTick = -1;

		Bar(ServerBossEvent event) {
			this.event = event;
		}
	}

	private final MinecraftServer server;
	private final Map<String, Bar> bars = new HashMap<>();

	public JobBossBars(MinecraftServer server) {
		this.server = server;
	}

	public int count() {
		return bars.size();
	}

	public void update(JsonObject u) {
		String jobId = Json.requireStr(u, "jobId");
		String state = Json.str(u, "state", "building").toLowerCase(Locale.ROOT);
		String stage = Json.str(u, "stage", "");
		double progress = Json.number(u, "progress", 0);
		double cost = Json.number(u, "costUsd", 0);
		Bar bar = bars.computeIfAbsent(jobId, id -> new Bar(new ServerBossEvent(UUID.randomUUID(),
				Component.literal("mcAI"), BossEvent.BossBarColor.BLUE, BossEvent.BossBarOverlay.PROGRESS)));
		boolean terminal = state.equals("done") || state.equals("failed") || state.equals("cancelled");
		bar.event.setColor(color(state));
		bar.event.setProgress((float) Math.clamp(terminal && state.equals("done") ? 1.0 : progress, 0.0, 1.0));
		bar.event.setName(title(state, stage, cost));
		attach(bar, Json.str(u, "player", null));
		bar.removeAtTick = terminal ? server.getTickCount() + LINGER_TICKS : -1;
	}

	private void attach(Bar bar, String playerName) {
		if (playerName == null || playerName.isBlank()) {
			return;
		}
		ServerPlayer p = server.getPlayerList().getPlayerByName(playerName);
		if (!playerName.equals(bar.player) || (p != null && !bar.event.getPlayers().contains(p))) {
			bar.event.removeAllPlayers();
			bar.player = playerName;
			if (p != null) {
				bar.event.addPlayer(p);
			}
		}
	}

	/** Called every server tick: expire finished bars, re-attach players who re-joined. */
	public void tick() {
		if (bars.isEmpty()) {
			return;
		}
		int now = server.getTickCount();
		for (Iterator<Bar> it = bars.values().iterator(); it.hasNext(); ) {
			Bar bar = it.next();
			if (bar.removeAtTick >= 0 && now >= bar.removeAtTick) {
				bar.event.removeAllPlayers();
				it.remove();
			} else if (bar.player != null && bar.event.getPlayers().isEmpty() && now % 20 == 0) {
				ServerPlayer p = server.getPlayerList().getPlayerByName(bar.player);
				if (p != null) {
					bar.event.addPlayer(p);
				}
			}
		}
	}

	public void clear() {
		bars.values().forEach(b -> b.event.removeAllPlayers());
		bars.clear();
	}

	/** English text for clients without the mod's language files (vanilla clients on a dedicated server). */
	private static String fallback(String state) {
		return switch (state) {
			case "queued" -> "queued";
			case "thinking" -> "thinking…";
			case "reviewing" -> "reviewing…";
			case "building" -> "building…";
			case "done" -> "done";
			case "failed" -> "failed";
			case "cancelled" -> "cancelled";
			default -> state;
		};
	}

	private static BossEvent.BossBarColor color(String state) {
		return switch (state) {
			case "queued" -> BossEvent.BossBarColor.WHITE;
			case "thinking", "reviewing" -> BossEvent.BossBarColor.PURPLE;
			case "done" -> BossEvent.BossBarColor.GREEN;
			case "failed" -> BossEvent.BossBarColor.RED;
			case "cancelled" -> BossEvent.BossBarColor.YELLOW;
			default -> BossEvent.BossBarColor.BLUE;
		};
	}

	private static Component title(String state, String stage, double cost) {
		MutableComponent c = Component.literal("mcAI ").withStyle(ChatFormatting.GOLD)
				.append(Component.translatableWithFallback("mcai.job.state." + state, fallback(state)).withStyle(ChatFormatting.WHITE));
		if (!stage.isBlank()) {
			c.append(Component.literal(" · " + stage).withStyle(ChatFormatting.GRAY));
		}
		if (cost > 0) {
			c.append(Component.literal(String.format(Locale.ROOT, "  $%.2f", cost)).withStyle(ChatFormatting.DARK_GRAY));
		}
		return c;
	}
}
