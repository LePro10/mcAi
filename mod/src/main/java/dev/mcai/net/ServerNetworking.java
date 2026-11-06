package dev.mcai.net;

import com.google.gson.JsonObject;
import dev.mcai.McaiMod;
import dev.mcai.bridge.Bridge;
import dev.mcai.build.BuildPermissions;
import dev.mcai.selection.Selection;
import dev.mcai.selection.Selections;
import dev.mcai.ui.Msg;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.fabricmc.fabric.api.entity.event.v1.ServerEntityLevelChangeEvents;
import net.minecraft.server.level.ServerPlayer;

/** Server side of the mod payloads: receivers (validated, rate-limited) and join/dimension sync. */
public final class ServerNetworking {
	private static final Set<String> ACTIONS = Set.of("cancel", "undo", "redo", "confirm", "reject", "reply", "status");
	private static final long MIN_ACTION_INTERVAL_MS = 250;
	private static final Map<UUID, Long> LAST_ACTION = new HashMap<>();
	private static final Map<UUID, Long> LAST_BUILD = new HashMap<>();

	private ServerNetworking() {
	}

	public static void register() {
		McaiPayloads.register();
		ServerPlayNetworking.registerGlobalReceiver(McaiPayloads.BuildRequest.TYPE, (payload, ctx) -> {
			Bridge b = McaiMod.bridge();
			ServerPlayer p = ctx.player();
			if (throttled(LAST_BUILD, p)) {
				return; // a (possibly forged) flood of requests: no log/chat spam
			}
			McaiMod.LOG.info("mcai: build request from {} ({} chars, style {}, size {}, selection {}, {})", p.getGameProfile().name(),
					payload.prompt().length(), payload.style(), payload.size(), payload.useSelection(), payload.mode());
			if (b == null) {
				p.sendSystemMessage(Msg.error(Msg.tr("mcai.build.offline", "The mcAI engine is not connected.")));
				return;
			}
			b.builds().request(p, payload.prompt(), payload.style(), payload.size(), payload.useSelection(), payload.mode());
		});
		ServerPlayNetworking.registerGlobalReceiver(McaiPayloads.JobAction.TYPE, (payload, ctx) -> {
			ServerPlayer p = ctx.player();
			Bridge b = McaiMod.bridge();
			if (b == null || !ACTIONS.contains(payload.action()) || throttled(LAST_ACTION, p)) {
				return;
			}
			if (payload.action().equals("status")) {
				b.status().send(p);
				sendSelection(p);
				return;
			}
			if (!BuildPermissions.canBuild(p, McaiMod.config())) {
				p.sendSystemMessage(Msg.error(Msg.tr("mcai.build.no_permission", "You are not allowed to start AI builds (needs permission level %s).",
						McaiMod.config().buildPermissionLevel)));
				return;
			}
			JsonObject req = new JsonObject();
			req.addProperty("player", p.getGameProfile().name());
			String type;
			if (payload.action().equals("reply")) {
				type = "player_reply";
				req.addProperty("text", payload.arg());
			} else {
				type = "job_control";
				req.addProperty("action", payload.action());
			}
			EngineReplies.forward(b, p, type, req);
		});
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> server.execute(() -> {
			Bridge b = McaiMod.bridge();
			if (b != null) {
				b.status().send(handler.player);
			}
			sendSelection(handler.player);
		}));
		ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
			LAST_ACTION.remove(handler.player.getUUID());
			LAST_BUILD.remove(handler.player.getUUID());
		});
		ServerEntityLevelChangeEvents.AFTER_PLAYER_CHANGE_LEVEL.register((player, origin, destination) -> sendSelection(player));
	}

	/** Server thread (Fabric runs play payload receivers there). */
	private static boolean throttled(Map<UUID, Long> last, ServerPlayer p) {
		long now = System.currentTimeMillis();
		Long prev = last.put(p.getUUID(), now);
		return prev != null && now - prev < MIN_ACTION_INTERVAL_MS;
	}

	/** Mod clients render the selection themselves. */
	public static void sendSelection(ServerPlayer p) {
		if (!ServerPlayNetworking.canSend(p, McaiPayloads.SelectionSync.TYPE)) {
			return;
		}
		Selection s = Selections.get(p);
		ServerPlayNetworking.send(p, s == null ? new McaiPayloads.SelectionSync("", null, null)
				: new McaiPayloads.SelectionSync(s.dimension(), s.pos1(), s.pos2()));
	}

	public static boolean hasMod(ServerPlayer p) {
		return ServerPlayNetworking.canSend(p, McaiPayloads.Status.TYPE);
	}
}
