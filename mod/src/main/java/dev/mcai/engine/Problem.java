package dev.mcai.engine;

import dev.mcai.ui.Msg;
import java.util.List;
import net.minecraft.network.chat.Component;

/** A user-facing, translatable problem description (key + plain-string args). */
public record Problem(String key, String fallback, List<String> args) {
	public static Problem of(String key, String fallback, String... args) {
		return new Problem(key, fallback, List.of(args));
	}

	public Component component() {
		return Msg.tr(key, fallback, args.toArray());
	}

	@Override
	public String toString() {
		return String.format(fallback, args.toArray());
	}
}
