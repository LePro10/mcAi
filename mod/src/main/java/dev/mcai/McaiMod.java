package dev.mcai;

import dev.mcai.bridge.Bridge;
import dev.mcai.command.McaiCommands;
import dev.mcai.config.McaiConfig;
import dev.mcai.item.McaiItems;
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

	/** The bridge of the running server, or null. */
	public static Bridge bridge() {
		return bridge;
	}

	@Override
	public void onInitialize() {
		ChunkTickets.register();
		McaiItems.register();
		McaiCommands.register();
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			McaiConfig config = McaiConfig.load(FabricLoader.getInstance().getConfigDir().resolve("mcai.json"));
			Bridge b = new Bridge(server, config);
			bridge = b;
			if (config.autoConnect) {
				b.start();
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
		LOG.info("mcAI {} initialized", FabricLoader.getInstance().getModContainer(MOD_ID)
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev"));
	}
}
