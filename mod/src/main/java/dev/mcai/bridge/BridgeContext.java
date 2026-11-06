package dev.mcai.bridge;

import dev.mcai.config.McaiConfig;
import dev.mcai.world.BlockPolicy;
import dev.mcai.world.TickScheduler;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.function.Supplier;
import net.minecraft.server.MinecraftServer;

/** What handlers need: the server, the tick scheduler, a worker pool for encoding, the block policy (server thread). */
public record BridgeContext(MinecraftServer server, McaiConfig config, TickScheduler scheduler, ExecutorService workers, BlockPolicy blockPolicy) {
	/** Run on the server thread (between ticks). */
	public <T> CompletableFuture<T> onServer(Supplier<T> work) {
		return CompletableFuture.supplyAsync(work, server);
	}
}
