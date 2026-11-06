package dev.mcai.handlers;

import com.google.gson.JsonObject;
import dev.mcai.McaiMod;
import dev.mcai.bridge.BridgeContext;
import dev.mcai.command.CapturingSource;
import dev.mcai.command.CommandPolicy;
import dev.mcai.protocol.Json;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.LevelBasedPermissionSet;

/**
 * command: runs an allowlisted command as the server (or positioned as player {@code as}),
 * capped at game-master permissions, and returns the captured feedback.
 * Response: {@code {ok, output}} — ok=false with output = the command failed or was rejected.
 */
public final class CommandHandler {
	private final BridgeContext ctx;
	private final CommandPolicy policy;

	public CommandHandler(BridgeContext ctx, CommandPolicy policy) {
		this.ctx = ctx;
		this.policy = policy;
	}

	public CompletableFuture<JsonObject> handle(JsonObject req) {
		String command = Json.requireStr(req, "command").trim();
		String as = Json.str(req, "as", null);
		String rejected = policy.check(command);
		if (rejected != null) {
			McaiMod.LOG.warn("mcai: rejected engine command '{}': {}", command, rejected);
			return CompletableFuture.completedFuture(result(false, "rejected by the mcai mod: " + rejected, rejected));
		}
		return ctx.onServer(() -> {
			CapturingSource capture = new CapturingSource();
			AtomicBoolean success = new AtomicBoolean(false);
			CommandSourceStack stack = ctx.server().createCommandSourceStack();
			if (as != null && !as.isBlank()) {
				ServerPlayer player = ctx.server().getPlayerList().getPlayerByName(as);
				if (player == null) {
					return result(false, "player '" + as + "' is not online", "player not online");
				}
				stack = stack.withEntity(player).withLevel(player.level()).withPosition(player.position()).withRotation(player.getRotationVector());
			}
			stack = stack.withSource(capture)
					.withMaximumPermission(LevelBasedPermissionSet.GAMEMASTER)
					.withCallback((ok, value) -> success.set(ok));
			String text = command.startsWith("/") ? command.substring(1) : command;
			ctx.server().getCommands().performPrefixedCommand(stack, text);
			return result(success.get(), capture.output(), null);
		});
	}

	private static JsonObject result(boolean ok, String output, String error) {
		JsonObject o = new JsonObject();
		o.addProperty("ok", ok);
		o.addProperty("output", output);
		if (error != null) {
			o.addProperty("error", error);
		}
		return o;
	}
}
