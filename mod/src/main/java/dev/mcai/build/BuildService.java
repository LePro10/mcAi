package dev.mcai.build;

import com.google.gson.JsonObject;
import dev.mcai.McaiMod;
import dev.mcai.bridge.Bridge;
import dev.mcai.config.McaiConfig;
import dev.mcai.handlers.QueryHandlers;
import dev.mcai.protocol.Json;
import dev.mcai.selection.Selection;
import dev.mcai.selection.Selections;
import dev.mcai.ui.ChatActions;
import dev.mcai.ui.Msg;
import dev.mcai.world.Dimensions;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;

/**
 * Starts AI builds for a player (prompt GUI payload or /mcai build): permission, rate limit,
 * one running job per player, build area (selection or size preset), then build_request (§5).
 * All feedback goes to the player's chat. Server thread.
 */
public final class BuildService {
	public static final Set<String> STYLES = Set.of("auto", "medieval", "fantasy", "japanese", "modern", "steampunk", "nordic", "desert", "gothic", "cozy");
	public static final int MAX_PROMPT = 2000;

	private final Bridge bridge;
	private final McaiConfig config;
	private final Map<String, Long> lastRequest = new HashMap<>();

	public BuildService(Bridge bridge, McaiConfig config) {
		this.bridge = bridge;
		this.config = config;
	}

	public int cooldownLeft(String player) {
		Long t = lastRequest.get(player);
		if (t == null) {
			return 0;
		}
		long left = config.buildCooldownSeconds * 1000L - (System.currentTimeMillis() - t);
		return left > 0 ? (int) Math.ceil(left / 1000.0) : 0;
	}

	public void request(ServerPlayer p, String rawPrompt, String style, String size, boolean useSelection, String mode) {
		String name = p.getGameProfile().name();
		String prompt = rawPrompt == null ? "" : rawPrompt.strip();
		if (!BuildPermissions.canBuild(p, config)) {
			fail(p, Msg.tr("mcai.build.no_permission", "You are not allowed to start AI builds (needs permission level %s).", config.buildPermissionLevel));
			return;
		}
		if (prompt.isEmpty()) {
			fail(p, Msg.tr("mcai.build.empty", "Describe what should be built first."));
			return;
		}
		if (!bridge.connected()) {
			fail(p, Msg.tr("mcai.build.offline", "The mcAI engine is not connected.").append(" ").append(bridge.status().offlineProblem().component()));
			return;
		}
		if (!bridge.jobs().activeFor(name).isEmpty()) {
			p.sendSystemMessage(Msg.error(Msg.tr("mcai.build.busy", "You already have a build running.")).append(" ").append(ChatActions.cancel()));
			return;
		}
		int wait = cooldownLeft(name);
		if (wait > 0) {
			fail(p, Msg.tr("mcai.build.cooldown", "Please wait %s s before the next build request.", wait));
			return;
		}
		lastRequest.put(name, System.currentTimeMillis());

		String styleId = style == null ? "auto" : style.toLowerCase(Locale.ROOT);
		if (!STYLES.contains(styleId)) {
			styleId = "auto";
		}
		String buildMode = "plan".equals(mode) ? "plan" : "build";
		Direction facing = Direction.fromYRot(p.getYRot());
		Selection sel = Selections.get(p);
		boolean selOk = useSelection && sel != null && sel.complete() && sel.dimension().equals(Dimensions.id(p.level()));

		JsonObject req = new JsonObject();
		req.add("player", QueryHandlers.describe(p));
		req.addProperty("prompt", prompt.length() > MAX_PROMPT ? prompt.substring(0, MAX_PROMPT) : prompt);
		BlockPos anchor;
		JsonObject options = new JsonObject();
		options.addProperty("mode", buildMode);
		if (!styleId.equals("auto")) {
			options.addProperty("style", styleId);
		}
		if (selOk) {
			BlockPos a = sel.min();
			BlockPos b = sel.max();
			anchor = new BlockPos(Math.floorDiv(a.getX() + b.getX(), 2), a.getY(), Math.floorDiv(a.getZ() + b.getZ(), 2));
			req.add("selection", sel.toBoxJson());
			Selections.markUsed(p);
		} else {
			anchor = lookTarget(p);
			SizePreset preset = SizePreset.parse(size == null ? "M" : size);
			BlockPos[] box = preset.box(anchor, facing, p.level().getMinY(), p.level().getMaxY());
			JsonObject b = new JsonObject();
			b.add("min", Json.array(box[0].getX(), box[0].getY(), box[0].getZ()));
			b.add("max", Json.array(box[1].getX(), box[1].getY(), box[1].getZ()));
			req.add("selection", b);
			JsonObject sz = new JsonObject();
			sz.addProperty("x", preset.x);
			sz.addProperty("y", preset.y);
			sz.addProperty("z", preset.z);
			req.add("size", sz);
			options.addProperty("size", preset.name());
		}
		req.add("anchor", Json.array(anchor.getX(), anchor.getY(), anchor.getZ()));
		req.addProperty("facing", facing.getSerializedName());
		req.add("options", options);

		McaiMod.LOG.info("mcai: build_request for {}", name);
		String shown = prompt.length() > 60 ? prompt.substring(0, 57) + "…" : prompt;
		bridge.request("build_request", req, 60).whenComplete((r, err) -> p.level().getServer().execute(() -> {
			if (err != null) {
				lastRequest.remove(name);
				fail(p, Msg.tr("mcai.build.rejected", "The engine did not start the build: %s", Bridge.rootMessage(err)));
				bridge.status().send(p);
				return;
			}
			String jobId = Json.str(r, "jobId", "");
			bridge.jobs().accepted(name, jobId, prompt);
			sendArea(p, jobId, r);
			Component msg = Msg.prefixed(Msg.tr(buildMode.equals("plan") ? "mcai.build.started_plan" : "mcai.build.started",
					buildMode.equals("plan") ? "Planning “%s”…" : "Building “%s”…", shown));
			Component area = effectiveArea(r);
			if (area != null) {
				msg = Component.empty().append(msg).append(" ").append(area);
			}
			String url = bridge.status().viewerUrl();
			p.sendSystemMessage(Component.empty().append(msg).append(" ")
					.append(ChatActions.row(ChatActions.cancel(), url.isEmpty() ? null : ChatActions.viewer(url))));
		}));
	}

	/** Mod clients draw the job's selection and allowed box (engine reply). */
	private static void sendArea(ServerPlayer p, String jobId, JsonObject r) {
		try {
			if (!r.has("allowedBox") || !r.get("allowedBox").isJsonObject() || !dev.mcai.net.ServerNetworking.hasMod(p)) {
				return;
			}
			dev.mcai.world.BlockBox a = dev.mcai.world.BlockBox.fromJson(r.getAsJsonObject("allowedBox"));
			dev.mcai.world.BlockBox s = r.has("selection") && r.get("selection").isJsonObject()
					? dev.mcai.world.BlockBox.fromJson(r.getAsJsonObject("selection")) : null;
			net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking.send(p, new dev.mcai.net.McaiPayloads.JobArea(jobId, Dimensions.id(p.level()),
					s == null ? null : new BlockPos(s.minX(), s.minY(), s.minZ()), s == null ? null : new BlockPos(s.maxX(), s.maxY(), s.maxZ()),
					new BlockPos(a.minX(), a.minY(), a.minZ()), new BlockPos(a.maxX(), a.maxY(), a.maxZ())));
		} catch (RuntimeException e) {
			McaiMod.LOG.debug("mcai: bad area in build_request reply: {}", e.toString());
		}
	}

	/** "(area 45 × 20 × 30, y 61–80)" from the engine's allowedBox, or null. */
	private static Component effectiveArea(JsonObject r) {
		try {
			if (!r.has("allowedBox") || !r.get("allowedBox").isJsonObject()) {
				return null;
			}
			dev.mcai.world.BlockBox b = dev.mcai.world.BlockBox.fromJson(r.getAsJsonObject("allowedBox"));
			return Msg.tr("mcai.build.area", "(area %s × %s × %s, y %s to %s)", b.sizeX(), b.sizeY(), b.sizeZ(), b.minY(), b.maxY())
					.withStyle(net.minecraft.ChatFormatting.GRAY);
		} catch (RuntimeException e) {
			return null;
		}
	}

	private static void fail(ServerPlayer p, Component msg) {
		p.sendSystemMessage(Msg.error(msg));
	}

	/** Anchor = the ground block the player looks at (≤ 64 blocks), else the block below their feet. */
	public static BlockPos lookTarget(ServerPlayer p) {
		HitResult hit = p.pick(64.0, 0f, false);
		if (hit instanceof BlockHitResult bh && hit.getType() == HitResult.Type.BLOCK) {
			return bh.getBlockPos();
		}
		return p.blockPosition().below();
	}

}
