package dev.mcai.gametest;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.mcai.client.ClientState;
import dev.mcai.client.McaiKeys;
import dev.mcai.client.screen.PromptScreen;
import dev.mcai.selection.Selection;
import dev.mcai.selection.Selections;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestServerContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.core.BlockPos;

/**
 * End-to-end client tests of the mod's player experience against tools/fake-engine.mjs, which
 * the mod itself starts through engine auto-start (config engine.command). Screenshots go to
 * the run dir's screenshots/ (tools/client-gametest.sh copies them to docs/renders/mod-*.png).
 */
public class McaiClientGameTest implements FabricClientGameTest {
	private static final int CONTROL_PORT = 8799;
	private static final String PROMPT = "A cozy medieval bakery with a flower garden, a small well and a stone path to the door";

	@Override
	public void runTest(ClientGameTestContext ctx) {
		String repo = System.getProperty("mcai.repoRoot");
		String home = System.getenv("MCAI_HOME");
		check(repo != null && home != null, "mcai.repoRoot and MCAI_HOME must be set by the run config");
		writeModConfig("node \"" + repo + "/tools/fake-engine.mjs\" --home \"" + home + "\" --control-port " + CONTROL_PORT);
		FakeEngineControl engine = new FakeEngineControl(CONTROL_PORT);

		checkKeyBindings(ctx);

		try (TestSingleplayerContext world = ctx.worldBuilder().create()) {
			TestServerContext server = world.getServer();
			world.getConnection().waitForChunksRender();
			ctx.getInput().resizeWindow(1280, 720);
			ctx.runOnClient(mc -> mc.options.guiScale().set(2));
			server.runCommand("gamerule advance_time false");
			server.runCommand("time set 6000");
			server.runCommand("weather clear");
			server.runCommand("gamemode creative Player0");

			// 1. engine auto-start: the mod started the fake engine and connected to it
			engine.await(ctx, "mod hello (engine auto-start)", s -> s.get("hellos").getAsInt() >= 1, 60_000);
			ctx.waitFor(mc -> ClientState.status() != null && ClientState.status().engineConnected(), 400);
			log("engine auto-started and connected");

			int ground = server.computeOnServer(s -> s.overworld().getChunk(0, 0).getHeight(net.minecraft.world.level.levelgen.Heightmap.Types.WORLD_SURFACE, 0, 0));
			decorate(server, ground);

			// 2. wand + selection (corner 1 by command, corner 2 by a real right-click with the wand)
			server.runCommand("give Player0 mcai:architect_wand");
			ctx.runOnClient(mc -> mc.player.getInventory().setSelectedSlot(0));
			BlockPos p1 = new BlockPos(-8, ground, -20);
			BlockPos p2 = new BlockPos(8, ground + 9, -6);
			server.runCommand("execute as Player0 run mcai pos1 " + p1.getX() + " " + p1.getY() + " " + p1.getZ());
			server.runCommand("setblock " + p2.getX() + " " + p2.getY() + " " + p2.getZ() + " minecraft:glass");
			// stand on a block 3 m in front of the target, look at it and right-click with the wand
			server.runCommand("setblock " + p2.getX() + " " + (p2.getY() - 2) + " " + (p2.getZ() + 3) + " minecraft:stone");
			server.runCommand("tp Player0 " + (p2.getX() + 0.5) + " " + (p2.getY() - 1) + " " + (p2.getZ() + 3 + 0.5));
			world.getConnection().waitForChunksRender();
			ctx.waitFor(mc -> !mc.level.getBlockState(p2).isAir() && mc.player.blockPosition().equals(p2.offset(0, -1, 3)), 100);
			ctx.waitTicks(10);
			ctx.getInput().lookAt(p2);
			ctx.waitTicks(3);
			String hit = ctx.computeOnClient(mc -> mc.player.position() + " looking " + mc.player.getXRot() + "/" + mc.player.getYRot() + " → "
					+ (mc.hitResult instanceof net.minecraft.world.phys.BlockHitResult b ? b.getType() + " " + b.getBlockPos() : String.valueOf(mc.hitResult)));
			log("crosshair: " + hit);
			ctx.getInput().pressKey(o -> o.keyUse);
			ctx.waitTicks(5);
			Selection sel = server.computeOnServer(s -> Selections.get(s.getPlayerList().getPlayerByName("Player0")));
			check(sel != null && sel.complete() && sel.pos1().equals(p1) && sel.pos2().equals(p2), "wand selection " + sel);
			ctx.waitFor(mc -> ClientState.selectionSize(mc.level.dimension().identifier().toString()) != null, 100);
			server.runCommand("setblock " + p2.getX() + " " + p2.getY() + " " + p2.getZ() + " minecraft:air");
			server.runCommand("setblock " + p2.getX() + " " + (p2.getY() - 2) + " " + (p2.getZ() + 3) + " minecraft:air");
			server.runCommand("tp Player0 0.5 " + (ground + 6) + " 14.5 facing 0 " + (ground + 1) + " -13");
			ctx.waitTicks(20);
			world.getConnection().waitForChunksRender();
			ctx.takeScreenshot("mod-selection");
			log("selection " + sel.min() + " .. " + sel.max());

			// 3. prompt GUI (key B), type, pick a style, Build → build_request at the fake engine
			ctx.getInput().pressKey(McaiKeys.openPrompt);
			ctx.waitForScreen(PromptScreen.class);
			ctx.getInput().typeChars(PROMPT);
			ctx.clickScreenButton("mcai.style.medieval");
			ctx.waitTicks(3);
			ctx.takeScreenshot("mod-prompt-en");
			// Ctrl+Enter submits (TestInput cannot send modifier bits, so deliver the key event directly)
			ctx.runOnClient(mc -> mc.gui.screen().keyPressed(new net.minecraft.client.input.KeyEvent(InputConstants.KEY_RETURN, 0, 0x40)));
			ctx.waitForScreen(null);
			JsonObject st = engine.await(ctx, "build_request", s -> FakeEngineControl.last(s, "build_request") != null, 20_000);
			JsonObject req = FakeEngineControl.last(st, "build_request");
			log("build_request: " + req);
			check(PROMPT.equals(req.get("prompt").getAsString()), "prompt " + req.get("prompt"));
			check("Player0".equals(req.getAsJsonObject("player").get("name").getAsString()), "player");
			check("medieval".equals(req.getAsJsonObject("options").get("style").getAsString()), "style");
			check("build".equals(req.getAsJsonObject("options").get("mode").getAsString()), "mode");
			check("north".equals(req.get("facing").getAsString()), "facing " + req.get("facing"));
			JsonObject box = req.getAsJsonObject("selection");
			check(vec(box.getAsJsonArray("min")).equals(sel.min()) && vec(box.getAsJsonArray("max")).equals(sel.max()), "selection box " + box);
			check(vec(req.getAsJsonArray("anchor")).getY() == sel.min().getY(), "anchor " + req.get("anchor"));

			// 4. HUD + boss bar from job_update (thinking → building with thoughts)
			String jobId = "job-1";
			jobUpdate(ctx, engine, jobId, "thinking", 0.06, "Reading the site", "scan_region 17×10×15 — flat grass, a path to the south", 0.05);
			ctx.waitTicks(10);
			jobUpdate(ctx, engine, jobId, "building", 0.31, "Timber frame & walls", "build: 1,284 blocks — oak frame, white plaster", 0.41);
			ctx.waitTicks(10);
			jobUpdate(ctx, engine, jobId, "building", 0.47, "Roof", "render_view iso_se — checking the roof line", 0.58);
			ctx.waitFor(mc -> ClientState.job() != null && ClientState.job().state().equals("building"), 100);
			check(ClientState.thoughts().size() == 3, "3 thoughts in the HUD, got " + ClientState.thoughts().size());
			int bars = server.computeOnServer(s -> dev.mcai.McaiMod.bridge().bossBars().count());
			check(bars == 1, "boss bar for the job");
			ctx.waitTicks(10);
			ctx.takeScreenshot("mod-hud");

			// paused singleplayer (pause menu / window in the background): engine requests are still served
			ctx.runOnClient(mc -> mc.pauseGame(false));
			ctx.waitFor(mc -> mc.getSingleplayerServer() != null && mc.getSingleplayerServer().isPaused(), 100);
			JsonObject gb = new JsonObject();
			gb.addProperty("type", "get_blocks");
			gb.addProperty("dimension", "minecraft:overworld");
			JsonObject gbox = new JsonObject();
			gbox.add("min", arr(-40, ground - 2, -60));
			gbox.add("max", arr(40, ground + 10, 20));
			gb.add("box", gbox);
			long t0 = System.currentTimeMillis();
			JsonObject gr = engine.send(ctx, gb);
			check(gr.get("ok").getAsBoolean() && gr.has("data"), "get_blocks answered while paused in " + (System.currentTimeMillis() - t0) + " ms");
			JsonObject sb = new JsonObject();
			sb.addProperty("type", "set_blocks");
			sb.addProperty("dimension", "minecraft:overworld");
			JsonArray pal = new JsonArray();
			pal.add("minecraft:lantern[hanging=false,waterlogged=false]");
			sb.add("palette", pal);
			sb.addProperty("positions", b64Int32(new int[] {3, ground + 1, -8}));
			sb.addProperty("states", b64Uint16(new char[] {0}));
			JsonObject sr = engine.send(ctx, sb);
			check(sr.get("ok").getAsBoolean() && sr.get("placed").getAsInt() == 1, "set_blocks answered while paused " + sr);
			ctx.waitTicks(5);
			ctx.takeScreenshot("mod-pause");
			ctx.getInput().pressKey(InputConstants.KEY_ESCAPE);
			ctx.waitForScreen(null);

			// prompt while a job runs: Build disabled, Cancel offered
			ctx.getInput().pressKey(McaiKeys.openPrompt);
			ctx.waitForScreen(PromptScreen.class);
			ctx.waitTicks(3);
			ctx.takeScreenshot("mod-prompt-running");
			ctx.clickScreenButton("mcai.ui.cancel_job");
			engine.await(ctx, "job_control cancel", s -> {
				JsonObject jc = FakeEngineControl.last(s, "job_control");
				return jc != null && "cancel".equals(jc.get("action").getAsString());
			}, 10_000);
			ctx.getInput().pressKey(InputConstants.KEY_ESCAPE);
			ctx.waitForScreen(null);

			// 5. chat UX: job end with [Undo] [Redo] [Open viewer], a question with clickable options
			jobUpdate(ctx, engine, jobId, "done", 1.0, "Finished", "finish: bakery with garden and well", 0.92);
			notify(ctx, engine, "[mcAI] Done: 2,912 blocks in 184s · $0.92. /mcai undo reverts the whole build.");
			notify(ctx, engine, "[mcAI] Which roof should the tower get?  1) Pointed spire  2) Flat terrace  3) Onion dome  — reply with /mcai reply <number or text>");
			ctx.waitTicks(10);
			ctx.getInput().pressKey(o -> o.keyChat);
			ctx.waitForScreen(ChatScreen.class);
			ctx.waitTicks(5);
			ctx.takeScreenshot("mod-chat");
			ctx.getInput().pressKey(InputConstants.KEY_ESCAPE);
			ctx.waitForScreen(null);
			// the reply button runs /mcai reply 2 → player_reply at the engine
			server.runCommand("execute as Player0 run mcai reply 2");
			engine.await(ctx, "player_reply", s -> {
				JsonObject r = FakeEngineControl.last(s, "player_reply");
				return r != null && "2".equals(r.get("text").getAsString());
			}, 10_000);

			// 6. German UI
			setLanguage(ctx, "de_de");
			ctx.getInput().pressKey(McaiKeys.openPrompt);
			ctx.waitForScreen(PromptScreen.class);
			ctx.waitTicks(3);
			ctx.takeScreenshot("mod-prompt-de");
			ctx.getInput().pressKey(InputConstants.KEY_ESCAPE);
			ctx.waitForScreen(null);
			setLanguage(ctx, "en_us");

			// 7. engine goes away → friendly offline state with the reason
			engine.post("/exit");
			ctx.waitFor(mc -> ClientState.status() != null && !ClientState.status().engineConnected(), 400);
			ctx.getInput().pressKey(McaiKeys.openPrompt);
			ctx.waitForScreen(PromptScreen.class);
			ctx.waitFor(mc -> "mcai.engine.exited".equals(ClientState.status().problemKey()), 200);
			boolean buildActive = ctx.computeOnClient(mc -> ((PromptScreen) mc.gui.screen()).buildButtonActive());
			check(!buildActive, "Build must be disabled while the engine is offline");
			ctx.waitTicks(3);
			ctx.takeScreenshot("mod-prompt-offline");
			ctx.getInput().pressKey(InputConstants.KEY_ESCAPE);
			ctx.waitForScreen(null);
			log("offline state: " + ClientState.status());
		}
		String dedicated = System.getProperty("mcai.gametest.dedicated");
		if (dedicated != null) {
			DedicatedPermissionTest.run(ctx, dedicated, engine);
		}
		log("ALL CLIENT GAME TESTS PASSED");
	}

	// ------------------------------------------------------------------ helpers

	private static void writeModConfig(String engineCommand) {
		JsonObject engine = new JsonObject();
		engine.addProperty("autoStart", true);
		engine.addProperty("command", engineCommand);
		JsonObject cfg = new JsonObject();
		cfg.add("engine", engine);
		cfg.addProperty("buildCooldownSeconds", 0);
		try {
			Path dir = FabricLoader.getInstance().getConfigDir();
			Files.createDirectories(dir);
			Files.writeString(dir.resolve("mcai.json"), cfg.toString());
		} catch (java.io.IOException e) {
			throw new IllegalStateException(e);
		}
	}

	/** Our default keys must not collide with vanilla defaults (F3+key debug combos are separate, like vanilla T vs F3+T). */
	private static void checkKeyBindings(ClientGameTestContext ctx) {
		ctx.runOnClient(mc -> {
			for (KeyMapping ours : new KeyMapping[] {McaiKeys.openPrompt, McaiKeys.toggleHud}) {
				for (KeyMapping km : mc.options.keyMappings) {
					if (km != ours && km.getCategory() != KeyMapping.Category.DEBUG && km.getDefaultKey().equals(ours.getDefaultKey())
							&& !km.getName().startsWith("key.mcai")) {
						throw new AssertionError("default key of " + ours.getName() + " collides with " + km.getName());
					}
				}
			}
		});
	}

	/** A few blocks so the screenshots show something besides grass. */
	private static void decorate(TestServerContext server, int g) {
		server.runCommand("fill -8 " + g + " -20 8 " + g + " -6 minecraft:grass_block");
		server.runCommand("fill -2 " + g + " -5 2 " + g + " 12 minecraft:dirt_path");
		server.runCommand("fill -12 " + (g + 1) + " -24 -10 " + (g + 6) + " -22 minecraft:oak_log");
		server.runCommand("fill -13 " + (g + 5) + " -25 -9 " + (g + 8) + " -21 minecraft:oak_leaves keep");
	}

	private static void jobUpdate(ClientGameTestContext ctx, FakeEngineControl engine, String jobId, String state, double progress, String stage, String detail, double cost) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "job_update");
		m.addProperty("jobId", jobId);
		m.addProperty("player", "Player0");
		m.addProperty("state", state);
		m.addProperty("progress", progress);
		m.addProperty("stage", stage);
		m.addProperty("detail", detail);
		m.addProperty("costUsd", cost);
		JsonObject r = engine.send(ctx, m);
		check(r.get("ok").getAsBoolean(), "job_update answered " + r);
	}

	private static void notify(ClientGameTestContext ctx, FakeEngineControl engine, String text) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "notify");
		m.addProperty("target", "Player0");
		m.addProperty("kind", "chat");
		m.addProperty("text", text);
		JsonObject r = engine.send(ctx, m);
		check(r.get("ok").getAsBoolean() && r.get("delivered").getAsInt() == 1, "notify delivered " + r);
	}

	private static void setLanguage(ClientGameTestContext ctx, String code) {
		CompletableFuture<Void> f = ctx.computeOnClient(mc -> {
			mc.options.languageCode = code;
			mc.getLanguageManager().setSelected(code);
			return mc.reloadResourcePacks();
		});
		ctx.waitFor(mc -> f.isDone() && mc.gui.overlay() == null, 2400);
		ctx.waitTicks(5);
	}

	private static JsonArray arr(int... v) {
		JsonArray a = new JsonArray();
		for (int x : v) {
			a.add(x);
		}
		return a;
	}

	private static String b64Int32(int[] v) {
		java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(v.length * 4).order(java.nio.ByteOrder.LITTLE_ENDIAN);
		b.asIntBuffer().put(v);
		return java.util.Base64.getEncoder().encodeToString(b.array());
	}

	private static String b64Uint16(char[] v) {
		java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(v.length * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN);
		b.asCharBuffer().put(v);
		return java.util.Base64.getEncoder().encodeToString(b.array());
	}

	private static BlockPos vec(JsonArray a) {
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	static void check(boolean ok, String what) {
		if (!ok) {
			throw new AssertionError("mcai gametest: " + what);
		}
		log("ok: " + what);
	}

	static void log(String msg) {
		System.out.println("[mcai-gametest] " + msg);
	}
}
