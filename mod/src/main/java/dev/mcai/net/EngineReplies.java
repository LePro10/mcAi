package dev.mcai.net;

import com.google.gson.JsonObject;
import dev.mcai.bridge.Bridge;
import dev.mcai.ui.Msg;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/** Forward a player request to the engine and show the engine's {@code message} in chat. */
public final class EngineReplies {
	private EngineReplies() {
	}

	public static void forward(Bridge bridge, ServerPlayer p, String type, JsonObject payload) {
		if (!bridge.connected()) {
			p.sendSystemMessage(Msg.error(Msg.tr("mcai.build.offline", "The mcAI engine is not connected.").append(" ")
					.append(bridge.status().offlineProblem().component())));
			return;
		}
		bridge.request(type, payload, 60).whenComplete((r, err) -> p.level().getServer().execute(() -> {
			if (err != null) {
				p.sendSystemMessage(Msg.error(Component.literal(Bridge.rootMessage(err))));
			} else if (r.has("message") && r.get("message").isJsonPrimitive()) {
				p.sendSystemMessage(Msg.prefixed(Component.literal(r.get("message").getAsString())));
			}
		}));
	}
}
