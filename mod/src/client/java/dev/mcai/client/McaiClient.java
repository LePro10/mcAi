package dev.mcai.client;

import dev.mcai.client.hud.JobHud;
import dev.mcai.client.render.SelectionRenderer;
import dev.mcai.client.screen.PromptScreen;
import dev.mcai.engine.EngineLauncher;
import dev.mcai.net.McaiPayloads;
import dev.mcai.ui.ClientHooks;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.hud.VanillaHudElements;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;

/** Client entrypoint: prompt GUI, HUD, selection rendering, key bindings, payload receivers. */
public final class McaiClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		McaiKeys.register();
		ClientHooks.openPrompt = McaiClient::openPrompt;
		ClientPlayNetworking.registerGlobalReceiver(McaiPayloads.Status.TYPE, (p, ctx) -> ClientState.status(p));
		ClientPlayNetworking.registerGlobalReceiver(McaiPayloads.JobUpdate.TYPE, (p, ctx) -> ClientState.job(p));
		ClientPlayNetworking.registerGlobalReceiver(McaiPayloads.SelectionSync.TYPE, (p, ctx) -> ClientState.selection(p));
		ClientPlayNetworking.registerGlobalReceiver(McaiPayloads.JobArea.TYPE, (p, ctx) -> ClientState.area(p));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, mc) -> mc.execute(ClientState::reset));
		HudElementRegistry.attachElementAfter(VanillaHudElements.BOSS_BAR, Identifier.fromNamespaceAndPath("mcai", "job"), JobHud::extract);
		ClientTickEvents.END_CLIENT_TICK.register(McaiClient::tick);
		// pause menu: tell the player the build continues (the bridge keeps serving the engine while paused)
		ScreenEvents.AFTER_INIT.register((mc, screen, w, h) -> {
			if (screen instanceof PauseScreen) {
				ScreenEvents.afterExtract(screen).register((s, g, mx, my, d) -> {
					if (ClientState.jobRunning()) {
						g.centeredText(mc.font, Component.translatable("mcai.pause.building"), w / 2, h - 14, 0xFFF2B84A);
					}
				});
			}
		});
		// the engine we may have started for singleplayer keeps running across worlds until the game exits
		ClientLifecycleEvents.CLIENT_STOPPING.register(mc -> EngineLauncher.stopIfOwned());
	}

	private static void tick(Minecraft mc) {
		while (McaiKeys.openPrompt.consumeClick()) {
			openPrompt();
		}
		while (McaiKeys.toggleHud.consumeClick()) {
			ClientConfig cfg = ClientConfig.get();
			cfg.hudEnabled = !cfg.hudEnabled;
			cfg.save();
			if (mc.player != null) {
				mc.player.sendOverlayMessage(Component.translatable(cfg.hudEnabled ? "mcai.hud.on" : "mcai.hud.off"));
			}
		}
		while (McaiKeys.undoBuild.consumeClick()) {
			if (ClientPlayNetworking.canSend(McaiPayloads.JobAction.TYPE)) {
				ClientPlayNetworking.send(new McaiPayloads.JobAction("undo", ""));
			}
		}
		SelectionRenderer.tick(mc);
	}

	public static void openPrompt() {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player != null && mc.gui.screen() == null) {
			mc.gui.setScreen(new PromptScreen());
		}
	}
}
