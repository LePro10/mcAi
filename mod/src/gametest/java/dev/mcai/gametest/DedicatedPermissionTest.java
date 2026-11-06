package dev.mcai.gametest;

import com.google.gson.JsonObject;
import dev.mcai.client.ClientState;
import dev.mcai.client.McaiKeys;
import dev.mcai.client.screen.PromptScreen;
import dev.mcai.net.McaiPayloads;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import com.mojang.blaze3d.platform.InputConstants;

/**
 * Multiplayer permission test against the real dedicated test server (tools/testserver, whose
 * EULA the operator accepted) with its own fake engine. Run via tools/client-gametest.sh --dedicated.
 * A non-op player sees "not allowed", a forged build payload is rejected server-side; after
 * {@code op} the same payload reaches the engine.
 */
final class DedicatedPermissionTest {
	private DedicatedPermissionTest() {
	}

	/** spec = "host:port|controlPort" */
	static void run(ClientGameTestContext ctx, String spec, FakeEngineControl ignored) {
		String[] parts = spec.split("\\|");
		String address = parts[0];
		FakeEngineControl engine = new FakeEngineControl(Integer.parseInt(parts[1]));
		String repo = System.getProperty("mcai.repoRoot");
		console(repo, "deop Player0");
		engine.await(ctx, "dedicated server's mod connected", s -> s.get("hellos").getAsInt() >= 1, 60_000);

		ctx.runOnClient(mc -> ConnectScreen.startConnecting(new TitleScreen(), mc, ServerAddress.parseString(address),
				new ServerData("mcAI test server", address, ServerData.Type.OTHER), false, null));
		ctx.waitFor(mc -> mc.player != null && mc.level != null && mc.gui.screen() == null, 1200);
		ctx.waitFor(mc -> ClientState.status() != null, 400);
		ctx.waitTicks(20);
		McaiClientGameTest.check(ClientState.status().engineConnected(), "dedicated: engine connected (status payload)");
		McaiClientGameTest.check(!ClientState.status().permitted(), "dedicated: non-op player is not permitted");

		ctx.getInput().pressKey(McaiKeys.openPrompt);
		ctx.waitForScreen(PromptScreen.class);
		ctx.getInput().typeChars("A watchtower");
		ctx.waitTicks(3);
		McaiClientGameTest.check(!ctx.computeOnClient(mc -> ((PromptScreen) mc.gui.screen()).buildButtonActive()), "dedicated: Build disabled without permission");
		ctx.takeScreenshot("mod-prompt-no-permission");
		ctx.getInput().pressKey(InputConstants.KEY_ESCAPE);
		ctx.waitForScreen(null);

		// a forged payload must be rejected by the server
		ctx.runOnClient(mc -> ClientPlayNetworking.send(new McaiPayloads.BuildRequest("forged request", "auto", "S", false, "build")));
		ctx.waitTicks(40);
		McaiClientGameTest.check(FakeEngineControl.count(engine.state(), "build_request") == 0, "dedicated: forged build payload rejected");

		console(repo, "op Player0");
		ctx.waitTicks(40);
		ctx.runOnClient(mc -> ClientPlayNetworking.send(new McaiPayloads.JobAction("status", "")));
		ctx.waitFor(mc -> ClientState.status() != null && ClientState.status().permitted(), 200);
		ctx.runOnClient(mc -> ClientPlayNetworking.send(new McaiPayloads.BuildRequest("A small watchtower", "nordic", "S", false, "build")));
		JsonObject st = engine.await(ctx, "dedicated build_request after op", s -> FakeEngineControl.last(s, "build_request") != null, 20_000);
		JsonObject req = FakeEngineControl.last(st, "build_request");
		McaiClientGameTest.check("nordic".equals(req.getAsJsonObject("options").get("style").getAsString())
				&& "S".equals(req.getAsJsonObject("options").get("size").getAsString()), "dedicated: op player's build_request " + req);
		console(repo, "deop Player0");
		ctx.runOnClient(mc -> mc.disconnect(new TitleScreen(), false));
		ctx.waitForScreen(TitleScreen.class);
	}

	private static void console(String repo, String command) {
		try {
			Process p = new ProcessBuilder(Path.of(repo, "tools", "testserver.sh").toString(), "cmd", command).inheritIO().start();
			p.waitFor(10, TimeUnit.SECONDS);
		} catch (Exception e) {
			throw new IllegalStateException("console command failed: " + command, e);
		}
	}
}
