package dev.mcai.ui;

import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;

/**
 * Player-facing texts: translatable (en_us / de_de in the mod's assets) with an English
 * fallback for clients that do not have the mod's language files.
 */
public final class Msg {
	private Msg() {
	}

	public static MutableComponent tr(String key, String fallback, Object... args) {
		return Component.translatableWithFallback(key, fallback, args);
	}

	/** "[mcAI] " prefix + message. */
	public static MutableComponent prefixed(Component message) {
		return Component.literal("[mcAI] ").withStyle(ChatFormatting.GOLD).append(message.copy().withStyle(s -> s.getColor() == null ? s.withColor(ChatFormatting.WHITE) : s));
	}

	public static MutableComponent error(Component message) {
		return Component.literal("[mcAI] ").withStyle(ChatFormatting.GOLD).append(message.copy().withStyle(ChatFormatting.RED));
	}
}
