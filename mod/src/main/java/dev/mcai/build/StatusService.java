package dev.mcai.build;

import dev.mcai.config.EngineEndpoint;
import dev.mcai.config.McaiConfig;
import dev.mcai.engine.EngineLauncher;
import dev.mcai.engine.Problem;
import dev.mcai.net.McaiPayloads;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/** Engine / permission / job status for mod clients (prompt GUI, HUD). Server thread. */
public final class StatusService {
	private final MinecraftServer server;
	private final McaiConfig config;
	private final BooleanSupplier connected;
	private final Supplier<EngineEndpoint> endpoint;
	private final JobTracker jobs;
	private final BuildService builds;

	public StatusService(MinecraftServer server, McaiConfig config, BooleanSupplier connected, Supplier<EngineEndpoint> endpoint,
			JobTracker jobs, BuildService builds) {
		this.server = server;
		this.config = config;
		this.connected = connected;
		this.endpoint = endpoint;
		this.jobs = jobs;
		this.builds = builds;
	}

	/** The problem to show while the engine is not connected (with fix instructions). */
	public Problem offlineProblem() {
		Problem p = EngineLauncher.problem();
		if (p != null) {
			return p;
		}
		if (EngineLauncher.ownsRunningEngine()) {
			return Problem.of("mcai.engine.starting", "Starting the engine…");
		}
		if (server.isDedicatedServer()) {
			return Problem.of("mcai.engine.offline_dedicated", "The engine is not running on the server. The server owner can start it with: mcai serve");
		}
		return Problem.of("mcai.engine.offline", "The engine is not running. Start it with: mcai serve — or set engine.autoStart to true in config/mcai.json");
	}

	/** Viewer URL for chat buttons; empty = none. */
	public String viewerUrl() {
		if (!config.engine.viewerUrl.isBlank()) {
			return config.engine.viewerUrl;
		}
		EngineEndpoint ep = endpoint.get();
		return ep != null && !server.isDedicatedServer() ? "http://127.0.0.1:" + ep.port() + "/" : "";
	}

	public McaiPayloads.Status statusFor(ServerPlayer p) {
		boolean up = connected.getAsBoolean();
		Problem problem = up ? EngineLauncher.warning() : offlineProblem();
		String name = p.getGameProfile().name();
		return new McaiPayloads.Status(up, BuildPermissions.canBuild(p, config),
				problem == null ? "" : problem.key(), problem == null ? List.of() : problem.args(),
				viewerUrl(), jobs.activeFor(name), jobs.activeFor(name).isEmpty() ? "" : "running", builds.cooldownLeft(name));
	}

	public void send(ServerPlayer p) {
		if (ServerPlayNetworking.canSend(p, McaiPayloads.Status.TYPE)) {
			ServerPlayNetworking.send(p, statusFor(p));
		}
	}

	public void broadcast() {
		server.getPlayerList().getPlayers().forEach(this::send);
	}
}
