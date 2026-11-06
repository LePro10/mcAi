package dev.mcai.command;

import com.google.gson.JsonObject;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.mcai.McaiMod;
import dev.mcai.bridge.Bridge;
import dev.mcai.build.BuildPermissions;
import dev.mcai.net.EngineReplies;
import dev.mcai.item.McaiItems;
import dev.mcai.protocol.Json;
import dev.mcai.selection.Selection;
import dev.mcai.selection.Selections;
import dev.mcai.ui.Msg;
import dev.mcai.world.Dimensions;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;

import static net.minecraft.commands.Commands.argument;
import static net.minecraft.commands.Commands.literal;

/**
 * {@code /mcai} command tree. Selection commands work locally; build/job/clipboard commands are
 * forwarded to the engine (build_request, job_control, player_reply, tool_request — §5) and the
 * engine's answer is shown to the player.
 */
public final class McaiCommands {
	private McaiCommands() {
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register((dispatcher, ctx, selection) -> register(dispatcher));
	}

	private static void register(CommandDispatcher<CommandSourceStack> d) {
		LiteralArgumentBuilder<CommandSourceStack> root = literal("mcai").requires(McaiCommands::allowed);
		root.then(literal("wand").executes(c -> giveWand(c.getSource().getPlayerOrException())));
		root.then(literal("pos1").executes(c -> corner(c, 1, null))
				.then(argument("pos", BlockPosArgument.blockPos()).executes(c -> corner(c, 1, BlockPosArgument.getBlockPos(c, "pos")))));
		root.then(literal("pos2").executes(c -> corner(c, 2, null))
				.then(argument("pos", BlockPosArgument.blockPos()).executes(c -> corner(c, 2, BlockPosArgument.getBlockPos(c, "pos")))));
		root.then(literal("sel").executes(McaiCommands::showSelection)
				.then(literal("clear").executes(c -> {
					Selections.clear(c.getSource().getPlayerOrException());
					c.getSource().sendSuccess(() -> Msg.prefixed(Msg.tr("mcai.selection.cleared", "Selection cleared")), false);
					return 1;
				})));
		root.then(literal("status").executes(McaiCommands::status));
		root.then(literal("build").then(argument("prompt", StringArgumentType.greedyString()).executes(c -> build(c, "build"))));
		root.then(literal("plan").then(argument("prompt", StringArgumentType.greedyString()).executes(c -> build(c, "plan"))));
		for (String action : new String[] {"cancel", "confirm", "reject", "undo", "redo"}) {
			root.then(literal(action).executes(c -> jobControl(c, action)));
		}
		root.then(literal("reply").then(argument("text", StringArgumentType.greedyString()).executes(c -> {
			JsonObject p = new JsonObject();
			p.addProperty("text", StringArgumentType.getString(c, "text"));
			return forward(c, "player_reply", p);
		})));
		// WorldEdit-style clipboard / region tools executed by the engine (non-AI)
		root.then(literal("copy").executes(c -> tool(c, "copy", new JsonObject(), true)));
		root.then(literal("cut").executes(c -> tool(c, "cut", new JsonObject(), true)));
		root.then(literal("clear").executes(c -> tool(c, "clear", new JsonObject(), true)));
		root.then(literal("paste").executes(c -> paste(c, false)).then(literal("-a").executes(c -> paste(c, true))));
		root.then(literal("rotate").then(argument("degrees", IntegerArgumentType.integer(-270, 270)).executes(c -> {
			JsonObject a = new JsonObject();
			a.addProperty("degrees", IntegerArgumentType.getInteger(c, "degrees"));
			return tool(c, "rotate", a, false);
		})));
		root.then(literal("flip").executes(c -> flip(c, null))
				.then(literal("x").executes(c -> flip(c, "x"))).then(literal("z").executes(c -> flip(c, "z"))));
		root.then(literal("set").then(argument("pattern", StringArgumentType.greedyString()).executes(c -> {
			JsonObject a = new JsonObject();
			a.addProperty("block", StringArgumentType.getString(c, "pattern"));
			return tool(c, "set", a, true);
		})));
		root.then(literal("replace").then(argument("from", StringArgumentType.string())
				.then(argument("to", StringArgumentType.greedyString()).executes(c -> {
					JsonObject a = new JsonObject();
					a.addProperty("mask", StringArgumentType.getString(c, "from"));
					a.addProperty("block", StringArgumentType.getString(c, "to"));
					return tool(c, "replace", a, true);
				}))));
		root.then(literal("stack").then(argument("count", IntegerArgumentType.integer(1, 64)).executes(c -> stack(c, null))
				.then(argument("direction", StringArgumentType.word()).executes(c -> stack(c, StringArgumentType.getString(c, "direction"))))));
		root.then(literal("save").then(argument("name", StringArgumentType.word()).executes(c -> named(c, "save"))));
		root.then(literal("load").then(argument("name", StringArgumentType.word()).executes(c -> named(c, "load"))));
		root.then(literal("list").executes(c -> tool(c, "list", new JsonObject(), false)));
		d.register(root);
	}

	/** Players need the AI-build permission (config buildPermissionLevel, singleplayer owner always); console always. */
	private static boolean allowed(CommandSourceStack src) {
		ServerPlayer p = src.getPlayer();
		return p == null ? Commands.hasPermission(Commands.LEVEL_GAMEMASTERS).test(src) : BuildPermissions.canBuild(p, McaiMod.config());
	}

	// ------------------------------------------------------------------ local commands

	private static int giveWand(ServerPlayer player) {
		player.addItem(new ItemStack(McaiItems.ARCHITECT_WAND)); // drops it if the inventory is full
		player.sendSystemMessage(Msg.prefixed(Msg.tr("mcai.wand.given", "Here is your Architect's Wand. Left-click: corner 1, right-click: corner 2.")));
		return 1;
	}

	private static int corner(CommandContext<CommandSourceStack> c, int corner, BlockPos pos) throws CommandSyntaxException {
		ServerPlayer p = c.getSource().getPlayerOrException();
		Selections.set(p, corner, pos != null ? pos : p.blockPosition());
		return 1;
	}

	private static int showSelection(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
		Selection s = Selections.get(c.getSource().getPlayerOrException());
		Component msg = s == null || !s.complete()
				? Msg.tr("mcai.selection.none", "No complete selection. Use the wand (/mcai wand) or /mcai pos1 + /mcai pos2.")
				: Msg.tr("mcai.selection.info", "%s → %s in %s (%s × %s × %s = %s blocks)", s.min().toShortString(), s.max().toShortString(),
						s.dimension(), s.sizeX(), s.sizeY(), s.sizeZ(), s.volume());
		c.getSource().sendSuccess(() -> Msg.prefixed(msg), false);
		return 1;
	}

	private static int status(CommandContext<CommandSourceStack> c) {
		Bridge b = McaiMod.bridge();
		boolean up = b != null && b.connected();
		Component msg = up
				? Msg.tr("mcai.status.connected", "Engine connected · %s world task(s) queued · %s job bar(s)", b.scheduler().size(), b.bossBars().count())
				: Msg.tr("mcai.status.disconnected", "Engine not connected — start it with `mcai serve` (looking for ~/.mcai/engine.json)");
		c.getSource().sendSuccess(() -> Msg.prefixed(msg), false);
		return up ? 1 : 0;
	}

	// ------------------------------------------------------------------ engine commands

	private static int build(CommandContext<CommandSourceStack> c, String mode) throws CommandSyntaxException {
		ServerPlayer p = c.getSource().getPlayerOrException();
		Bridge b = McaiMod.bridge();
		if (b == null) {
			return 0;
		}
		b.builds().request(p, StringArgumentType.getString(c, "prompt"), "auto", "M", true, mode);
		return 1;
	}

	private static int jobControl(CommandContext<CommandSourceStack> c, String action) throws CommandSyntaxException {
		JsonObject p = new JsonObject();
		p.addProperty("action", action);
		return forward(c, "job_control", p);
	}

	private static int forward(CommandContext<CommandSourceStack> c, String type, JsonObject payload) throws CommandSyntaxException {
		ServerPlayer p = c.getSource().getPlayerOrException();
		Bridge b = McaiMod.bridge();
		if (b == null) {
			return 0;
		}
		payload.addProperty("player", p.getGameProfile().name());
		EngineReplies.forward(b, p, type, payload);
		return 1;
	}

	private static int tool(CommandContext<CommandSourceStack> c, String tool, JsonObject args, boolean needsSelection) throws CommandSyntaxException {
		ServerPlayer p = c.getSource().getPlayerOrException();
		Selection sel = Selections.get(p);
		if (sel != null && sel.complete()) {
			args.add("selection", sel.toBoxJson());
		} else if (needsSelection) {
			c.getSource().sendFailure(Msg.error(Msg.tr("mcai.selection.none", "No complete selection. Use the wand (/mcai wand) or /mcai pos1 + /mcai pos2.")));
			return 0;
		}
		args.addProperty("dimension", Dimensions.id(p.level()));
		BlockPos at = p.blockPosition();
		if (!args.has("at")) {
			args.add("at", Json.array(at.getX(), at.getY(), at.getZ()));
		}
		JsonObject req = new JsonObject();
		req.addProperty("player", p.getGameProfile().name());
		req.addProperty("tool", tool);
		req.add("args", args);
		return send(c, "tool_request", req, r -> null);
	}

	private static int paste(CommandContext<CommandSourceStack> c, boolean ignoreAir) throws CommandSyntaxException {
		JsonObject a = new JsonObject();
		a.addProperty("ignoreAir", ignoreAir);
		return tool(c, "paste", a, false);
	}

	private static int flip(CommandContext<CommandSourceStack> c, String axis) throws CommandSyntaxException {
		JsonObject a = new JsonObject();
		Direction d = c.getSource().getPlayerOrException().getDirection();
		a.addProperty("axis", axis != null ? axis : d.getAxis() == Direction.Axis.Z ? "z" : "x");
		return tool(c, "flip", a, false);
	}

	private static int stack(CommandContext<CommandSourceStack> c, String direction) throws CommandSyntaxException {
		JsonObject a = new JsonObject();
		a.addProperty("count", IntegerArgumentType.getInteger(c, "count"));
		ServerPlayer p = c.getSource().getPlayerOrException();
		a.addProperty("direction", direction != null ? direction : Direction.orderedByNearest(p)[0].getSerializedName());
		return tool(c, "stack", a, true);
	}

	private static int named(CommandContext<CommandSourceStack> c, String tool) throws CommandSyntaxException {
		JsonObject a = new JsonObject();
		a.addProperty("name", StringArgumentType.getString(c, "name"));
		return tool(c, tool, a, false);
	}

	/** Send a request to the engine; show its {@code message} (or {@code describe}) to the player. */
	private static int send(CommandContext<CommandSourceStack> c, String type, JsonObject payload,
			java.util.function.Function<JsonObject, Component> describe) {
		CommandSourceStack src = c.getSource();
		Bridge bridge = McaiMod.bridge();
		if (bridge == null || !bridge.connected()) {
			src.sendFailure(Msg.error(Msg.tr("mcai.status.disconnected", "Engine not connected — start it with `mcai serve` (looking for ~/.mcai/engine.json)")));
			return 0;
		}
		bridge.request(type, payload, 60).whenComplete((r, err) -> src.getServer().execute(() -> {
			if (err != null) {
				src.sendFailure(Msg.error(Component.literal(Bridge.rootMessage(err))));
				return;
			}
			Component text = describe.apply(r);
			if (text == null && r.has("message") && r.get("message").isJsonPrimitive()) {
				text = Component.literal(r.get("message").getAsString());
			}
			if (text != null) {
				Component shown = text;
				src.sendSuccess(() -> Msg.prefixed(shown), false);
			}
		}));
		return 1;
	}
}
