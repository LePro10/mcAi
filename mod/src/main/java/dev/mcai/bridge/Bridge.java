package dev.mcai.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcai.McaiMod;
import dev.mcai.command.CommandPolicy;
import dev.mcai.config.EngineEndpoint;
import dev.mcai.config.McaiConfig;
import dev.mcai.handlers.BlockHandlers;
import dev.mcai.handlers.CommandHandler;
import dev.mcai.handlers.QueryHandlers;
import dev.mcai.notify.JobBossBars;
import dev.mcai.notify.Notifier;
import dev.mcai.world.Dimensions;
import dev.mcai.world.RegistryDump;
import dev.mcai.world.TickScheduler;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.SharedConstants;
import net.minecraft.server.MinecraftServer;

/**
 * The mod side of the engine protocol (ARCHITECTURE §5) for one running server: owns the
 * WebSocket client, routes requests to handlers, sends responses and mod → engine events.
 * Every handler failure becomes {@code {re, ok:false, error}}; nothing here can crash the server.
 */
public final class Bridge implements EngineClient.Listener {
	private static final Gson GSON = new Gson();

	private final MinecraftServer server;
	private final TickScheduler scheduler;
	private final ScheduledExecutorService io;
	private final ExecutorService workers;
	private final EngineClient client;
	private final BridgeContext ctx;
	private final JobBossBars bossBars;
	private final Notifier notifier;
	private final Map<String, RequestHandler> handlers = new HashMap<>();
	private final Map<String, CompletableFuture<JsonObject>> pending = new ConcurrentHashMap<>();
	private final AtomicLong ids = new AtomicLong();
	private volatile JsonObject registryCache;

	public Bridge(MinecraftServer server, McaiConfig config) {
		this.server = server;
		this.scheduler = new TickScheduler(config.tickBudgetMs);
		this.io = Executors.newSingleThreadScheduledExecutor(r -> daemon(r, "mcai-engine-io"));
		this.workers = Executors.newFixedThreadPool(2, r -> daemon(r, "mcai-engine-worker"));
		this.ctx = new BridgeContext(server, config, scheduler, workers);
		this.bossBars = new JobBossBars(server);
		this.notifier = new Notifier(server);
		this.client = new EngineClient(config, io, this);

		new BlockHandlers(ctx).register(handlers);
		new QueryHandlers(ctx, bossBars::count).register(handlers);
		CommandHandler commands = new CommandHandler(ctx, new CommandPolicy(config, engineCommandExtras()));
		handlers.put("command", commands::handle);
		handlers.put("notify", r -> ctx.onServer(() -> {
			JsonObject out = new JsonObject();
			out.addProperty("delivered", notifier.notify(r));
			return out;
		}));
		handlers.put("job_update", r -> ctx.onServer(() -> {
			bossBars.update(r);
			return new JsonObject();
		}));
	}

	private static Thread daemon(Runnable r, String name) {
		Thread t = new Thread(r, name);
		t.setDaemon(true);
		return t;
	}

	public TickScheduler scheduler() {
		return scheduler;
	}

	public JobBossBars bossBars() {
		return bossBars;
	}

	public boolean connected() {
		return client.isConnected();
	}

	public void start() {
		client.start();
	}

	/** Server thread, every tick. */
	public void tick() {
		scheduler.tick();
		bossBars.tick();
	}

	public void stop() {
		client.stop();
		scheduler.cancelAll("server stopping");
		bossBars.clear();
		io.shutdownNow();
		workers.shutdownNow();
	}

	// ------------------------------------------------------------------ connection events

	@Override
	public void onConnected(EngineEndpoint endpoint) {
		// Registry dump must run on the server thread (tags); cached, as it only changes on restart.
		CompletableFuture<JsonObject> registry = registryCache != null
				? CompletableFuture.completedFuture(registryCache)
				: ctx.onServer(RegistryDump::build).thenApply(r -> registryCache = r);
		registry.thenCombine(ctx.onServer(() -> Dimensions.describe(server)), (reg, dims) -> {
			JsonObject hello = new JsonObject();
			hello.addProperty("modVersion", modVersion());
			hello.addProperty("mcVersion", SharedConstants.getCurrentVersion().name());
			hello.addProperty("world", server.getWorldData().getLevelName());
			hello.addProperty("serverType", server.isDedicatedServer() ? "dedicated" : "integrated");
			hello.add("dimensions", dims);
			hello.add("registry", reg);
			return hello;
		}).thenCompose(hello -> request("hello", hello, 30)).whenComplete((reply, err) -> {
			if (err != null) {
				McaiMod.LOG.warn("mcai: engine did not accept hello: {}", rootMessage(err));
			} else {
				McaiMod.LOG.info("mcai: handshake complete (engine {})", reply.has("engineVersion") ? reply.get("engineVersion").getAsString() : "?");
			}
		});
	}

	@Override
	public void onDisconnected(String reason) {
		pending.values().forEach(f -> f.completeExceptionally(new IllegalStateException("engine disconnected: " + reason)));
		pending.clear();
		// Running world tasks finish normally (the world stays consistent); their answers are dropped.
		server.execute(bossBars::clear);
	}

	@Override
	public void onMessage(String text) {
		JsonObject msg;
		try {
			JsonElement e = JsonParser.parseString(text);
			if (!e.isJsonObject()) {
				return;
			}
			msg = e.getAsJsonObject();
		} catch (RuntimeException e) {
			McaiMod.LOG.warn("mcai: engine sent invalid JSON ({} chars)", text.length());
			return;
		}
		if (msg.has("re")) {
			CompletableFuture<JsonObject> f = pending.remove(msg.get("re").getAsString());
			if (f != null) {
				if (msg.has("ok") && !msg.get("ok").getAsBoolean()) {
					f.completeExceptionally(new IllegalStateException(msg.has("error") ? msg.get("error").getAsString() : "engine error"));
				} else {
					f.complete(msg);
				}
			}
			return;
		}
		String type = msg.has("type") ? msg.get("type").getAsString() : "";
		String id = msg.has("id") && !msg.get("id").isJsonNull() ? msg.get("id").getAsString() : null;
		RequestHandler handler = handlers.get(type);
		if (handler == null) {
			if (id != null) {
				respond(id, CompletableFuture.failedFuture(new IllegalArgumentException("unknown message type '" + type + "'")));
			}
			return;
		}
		CompletableFuture<JsonObject> result;
		try {
			result = handler.handle(msg);
		} catch (Throwable t) {
			result = CompletableFuture.failedFuture(t);
		}
		if (id != null) {
			respond(id, result);
		}
	}

	private void respond(String id, CompletableFuture<JsonObject> result) {
		result.whenCompleteAsync((payload, err) -> {
			JsonObject out = new JsonObject();
			out.addProperty("re", id);
			if (err != null) {
				out.addProperty("ok", false);
				out.addProperty("error", rootMessage(err));
			} else {
				out.addProperty("ok", true);
				if (payload != null) {
					payload.entrySet().forEach(e -> out.add(e.getKey(), e.getValue())); // payload "ok" wins (command)
				}
			}
			client.send(GSON.toJson(out));
		}, workers);
	}

	// ------------------------------------------------------------------ mod → engine

	/** Send a request to the engine and await its {@code re} answer. */
	public CompletableFuture<JsonObject> request(String type, JsonObject payload, int timeoutSeconds) {
		String id = "mod-" + ids.incrementAndGet();
		JsonObject msg = payload.deepCopy();
		msg.addProperty("type", type);
		msg.addProperty("id", id);
		CompletableFuture<JsonObject> f = new CompletableFuture<>();
		pending.put(id, f);
		if (!client.isConnected()) {
			pending.remove(id);
			return CompletableFuture.failedFuture(new IllegalStateException("the mcAI engine is not connected"));
		}
		workers.execute(() -> client.send(GSON.toJson(msg)));
		return f.orTimeout(timeoutSeconds, TimeUnit.SECONDS).whenComplete((r, e) -> pending.remove(id));
	}

	/** Fire-and-forget event (no id). */
	public void event(String type, JsonObject payload) {
		JsonObject msg = payload.deepCopy();
		msg.addProperty("type", type);
		workers.execute(() -> client.send(GSON.toJson(msg)));
	}

	// ------------------------------------------------------------------ helpers

	private static String modVersion() {
		return FabricLoader.getInstance().getModContainer(McaiMod.MOD_ID)
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");
	}

	/** Extra command prefixes from the engine's ~/.mcai/config.json ("commandAllowlist"). */
	private static List<String> engineCommandExtras() {
		Path file = EngineEndpoint.mcaiHome().resolve("config.json");
		List<String> out = new ArrayList<>();
		try {
			if (Files.isRegularFile(file)) {
				JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
				if (o.has("commandAllowlist") && o.get("commandAllowlist").isJsonArray()) {
					o.getAsJsonArray("commandAllowlist").forEach(e -> out.add(e.getAsString()));
				}
			}
		} catch (Exception e) {
			McaiMod.LOG.warn("mcai: could not read {}: {}", file, e.getMessage());
		}
		return out;
	}

	static String rootMessage(Throwable t) {
		while ((t instanceof CompletionException || t.getCause() != null && t instanceof java.util.concurrent.ExecutionException) && t.getCause() != null) {
			t = t.getCause();
		}
		if (t instanceof TimeoutException) {
			return "timed out";
		}
		String m = t.getMessage();
		return m != null && !m.isBlank() ? m : t.getClass().getSimpleName();
	}
}
