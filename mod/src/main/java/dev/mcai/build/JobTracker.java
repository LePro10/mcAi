package dev.mcai.build;

import com.google.gson.JsonObject;
import dev.mcai.net.McaiPayloads;
import dev.mcai.protocol.Json;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * Jobs per player as reported by the engine's job_update: forwards them to the player's HUD
 * (mod clients) and remembers which player has a running job. Server thread only.
 */
public final class JobTracker {
	private static final Set<String> TERMINAL = Set.of("done", "failed", "cancelled");

	private record Job(String id, String player, String prompt) {
	}

	private final MinecraftServer server;
	private final Map<String, Job> jobs = new HashMap<>();
	private final Map<String, String> activeByPlayer = new HashMap<>();
	private final Map<String, Integer> endedAtTick = new HashMap<>();
	/** Recently ended job ids: a build_request reply that arrives after its job's final job_update must not revive it. */
	private final Set<String> ended = java.util.Collections.newSetFromMap(new java.util.LinkedHashMap<>(16, 0.75f, false) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, Boolean> e) {
			return size() > 256;
		}
	});
	private Runnable onChange = () -> {
	};

	public JobTracker(MinecraftServer server) {
		this.server = server;
	}

	public void onChange(Runnable r) {
		onChange = r;
	}

	public static boolean terminal(String state) {
		return TERMINAL.contains(state);
	}

	/** A build_request was accepted by the engine. */
	public void accepted(String player, String jobId, String prompt) {
		if (jobId.isEmpty() || ended.contains(jobId)) {
			return;
		}
		jobs.put(jobId, new Job(jobId, player, prompt));
		activeByPlayer.put(player, jobId);
		push(player, new McaiPayloads.JobUpdate(jobId, "queued", 0f, "", "", 0, prompt));
		onChange.run();
	}

	public void update(JsonObject u) {
		String jobId = Json.requireStr(u, "jobId");
		String state = Json.str(u, "state", "building");
		String player = Json.str(u, "player", null);
		Job job = jobs.get(jobId);
		if (job == null && player != null && !ended.contains(jobId)) {
			job = new Job(jobId, player, "");
			jobs.put(jobId, job);
		}
		if (job == null) {
			return;
		}
		boolean end = terminal(state);
		if (end) {
			ended.add(jobId);
			jobs.remove(jobId);
			activeByPlayer.remove(job.player, jobId);
			endedAtTick.put(job.player, server.getTickCount());
		} else {
			activeByPlayer.put(job.player, jobId);
		}
		push(job.player, new McaiPayloads.JobUpdate(jobId, state, (float) Json.number(u, "progress", 0), Json.str(u, "stage", ""),
				Json.str(u, "detail", ""), Json.number(u, "costUsd", 0), job.prompt));
		if (end || !jobId.equals(activeByPlayer.get(job.player))) {
			onChange.run();
		}
	}

	public String activeFor(String player) {
		return activeByPlayer.getOrDefault(player, "");
	}

	/** Did a job of this player end within the last {@code ticks}? (job-end chat gets action buttons) */
	public boolean recentlyEnded(String player, int ticks) {
		Integer t = endedAtTick.get(player);
		return t != null && server.getTickCount() - t <= ticks;
	}

	/** Engine disconnected: running jobs are unknown now. */
	public void engineLost() {
		for (Job job : jobs.values()) {
			push(job.player, new McaiPayloads.JobUpdate(job.id, "failed", 0f, "", "engine disconnected", 0, job.prompt));
		}
		jobs.clear();
		activeByPlayer.clear();
		onChange.run();
	}

	private void push(String playerName, McaiPayloads.JobUpdate payload) {
		ServerPlayer p = server.getPlayerList().getPlayerByName(playerName);
		if (p != null && ServerPlayNetworking.canSend(p, McaiPayloads.JobUpdate.TYPE)) {
			ServerPlayNetworking.send(p, payload);
		}
	}
}
