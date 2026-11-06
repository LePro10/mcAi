package dev.mcai.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcai.bridge.BridgeContext;
import dev.mcai.bridge.RequestHandler;
import dev.mcai.protocol.Json;
import dev.mcai.world.BlockBox;
import dev.mcai.world.Dimensions;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.IntSupplier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.AABB;

/** entities, players, status — quick reads on the server thread (not queued behind builds). */
public final class QueryHandlers {
	private static final int MAX_ENTITIES = 10_000;

	private final BridgeContext ctx;
	private final IntSupplier jobBars;

	public QueryHandlers(BridgeContext ctx, IntSupplier jobBars) {
		this.ctx = ctx;
		this.jobBars = jobBars;
	}

	public void register(Map<String, RequestHandler> handlers) {
		handlers.put("entities", this::entities);
		handlers.put("players", r -> ctx.onServer(this::players));
		handlers.put("status", r -> ctx.onServer(this::status));
	}

	private CompletableFuture<JsonObject> entities(JsonObject req) {
		BlockBox box = BlockBox.fromJson(Json.obj(req, "box"));
		return ctx.onServer(() -> {
			ServerLevel level = Dimensions.level(ctx.server(), Json.str(req, "dimension", null));
			AABB aabb = new AABB(box.minX(), box.minY(), box.minZ(), box.maxX() + 1, box.maxY() + 1, box.maxZ() + 1);
			JsonArray list = new JsonArray();
			for (Entity e : level.getEntities((Entity) null, aabb, e -> !(e instanceof Player))) {
				if (list.size() >= MAX_ENTITIES) {
					break;
				}
				JsonObject o = new JsonObject();
				o.addProperty("id", EntityType.getKey(e.getType()).toString());
				o.addProperty("uuid", e.getStringUUID());
				o.add("pos", Json.array(e.getX(), e.getY(), e.getZ()));
				if (e.hasCustomName()) {
					o.addProperty("name", e.getCustomName().getString());
				}
				list.add(o);
			}
			JsonObject out = new JsonObject();
			out.add("entities", list);
			return out;
		});
	}

	private JsonObject players() {
		JsonArray list = new JsonArray();
		for (ServerPlayer p : ctx.server().getPlayerList().getPlayers()) {
			list.add(describe(p));
		}
		JsonObject out = new JsonObject();
		out.add("players", list);
		return out;
	}

	/** PlayerInfo (engine/src/core/types.ts). */
	public static JsonObject describe(ServerPlayer p) {
		JsonObject o = new JsonObject();
		o.addProperty("name", p.getGameProfile().name());
		o.addProperty("uuid", p.getStringUUID());
		o.add("pos", Json.array(p.getX(), p.getY(), p.getZ()));
		o.addProperty("yaw", p.getYRot());
		o.addProperty("pitch", p.getXRot());
		o.addProperty("dimension", Dimensions.id(p.level()));
		o.addProperty("gameMode", p.gameMode().getName());
		return o;
	}

	private JsonObject status() {
		JsonObject out = new JsonObject();
		out.addProperty("tick", ctx.server().getTickCount());
		out.addProperty("mspt", ctx.server().getAverageTickTimeNanos() / 1_000_000.0);
		out.addProperty("queuedTasks", ctx.scheduler().size());
		out.addProperty("jobBars", jobBars.getAsInt());
		out.addProperty("players", ctx.server().getPlayerList().getPlayerCount());
		return out;
	}
}
