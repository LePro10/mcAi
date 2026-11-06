package dev.mcai;

import dev.mcai.bridge.Bridge;
import dev.mcai.command.McaiCommands;
import dev.mcai.config.McaiConfig;
import dev.mcai.engine.EngineLauncher;
import dev.mcai.item.McaiItems;
import dev.mcai.net.ServerNetworking;
import dev.mcai.selection.SelectionOutline;
import dev.mcai.selection.Selections;
import dev.mcai.world.ChunkTickets;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Common (server-side) entrypoint: wires the engine bridge to the server lifecycle. */
public final class McaiMod implements ModInitializer {
	public static final String MOD_ID = "mcai";
	public static final Logger LOG = LoggerFactory.getLogger("mcai");

	private static volatile Bridge bridge;
	private static volatile McaiConfig config = new McaiConfig();

	/** The bridge of the running server, or null. */
	public static Bridge bridge() {
		return bridge;
	}

	/** Config of the running server (defaults before the first server start). */
	public static McaiConfig config() {
		return config;
	}

	@Override
	public void onInitialize() {
		ChunkTickets.register();
		McaiItems.register();
		McaiCommands.register();
		ServerNetworking.register();
		ServerLifecycleEvents.SERVER_STARTING.register(server -> {
			config = McaiConfig.load(FabricLoader.getInstance().getConfigDir().resolve("mcai.json"));
			// start early so the engine is up by the time the world is loaded
			EngineLauncher.ensureRunning(config, !server.isDedicatedServer(), FabricLoader.getInstance().getGameDir());
		});
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			try {
				Bridge b = new Bridge(server, config);
				bridge = b;
				if (config.autoConnect) {
					b.start();
				}
			} catch (RuntimeException e) {
				// never take the world down with us: the game runs on without mcAI
				LOG.error("mcai: could not start the engine bridge — mcAI is disabled for this world", e);
			}
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			Bridge b = bridge;
			if (b != null) {
				b.tick();
			}
			SelectionOutline.tick(server);
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			Bridge b = bridge;
			bridge = null;
			if (b != null) {
				b.stop();
			}
			Selections.reset();
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			// a dedicated server stops the engine it started; in singleplayer the engine keeps
			// running across worlds and is stopped when the game exits (client entrypoint)
			if (server.isDedicatedServer()) {
				EngineLauncher.stopIfOwned();
			}
		});
		LOG.info("mcAI {} initialized", FabricLoader.getInstance().getModContainer(MOD_ID)
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev"));
	}
}
