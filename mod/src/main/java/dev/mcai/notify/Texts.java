package dev.mcai.notify;

import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import com.mojang.serialization.JsonOps;
import net.minecraft.core.HolderLookup;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.ComponentSerialization;

/** Plain text or JSON text components (as used by /tellraw) → {@link Component}. */
public final class Texts {
	private Texts() {
	}

	public static Component parse(String text, HolderLookup.Provider registries) {
		if (text == null) {
			return Component.empty();
		}
		String t = text.trim();
		if (t.startsWith("{") || t.startsWith("[") || t.startsWith("\"")) {
			try {
				JsonElement json = JsonParser.parseString(t);
				return ComponentSerialization.CODEC.parse(registries.createSerializationContext(JsonOps.INSTANCE), json)
						.result().orElseGet(() -> Component.literal(text));
			} catch (RuntimeException ignored) {
				// not JSON after all — show it verbatim
			}
		}
		return Component.literal(text);
	}
}
