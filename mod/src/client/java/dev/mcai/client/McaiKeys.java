package dev.mcai.client;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.minecraft.client.KeyMapping;
import net.minecraft.resources.Identifier;


/** Key bindings (rebindable in Options → Controls → mcAI). Defaults avoid vanilla bindings. */
public final class McaiKeys {
	public static final KeyMapping.Category CATEGORY = KeyMapping.Category.register(Identifier.fromNamespaceAndPath("mcai", "main"));
	public static KeyMapping openPrompt;
	public static KeyMapping undoBuild;
	public static KeyMapping toggleHud;

	private McaiKeys() {
	}

	public static void register() {
		openPrompt = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.mcai.open_prompt", InputConstants.Type.KEYBOARD, InputConstants.KEY_B, CATEGORY));
		undoBuild = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.mcai.undo", InputConstants.Type.KEYBOARD, InputConstants.UNKNOWN.getValue(), CATEGORY));
		toggleHud = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.mcai.toggle_hud", InputConstants.Type.KEYBOARD, InputConstants.KEY_H, CATEGORY));
	}
}
