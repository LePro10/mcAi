package dev.mcai.command;

import net.minecraft.commands.CommandSource;
import net.minecraft.network.chat.Component;

/** Collects command feedback (success and failure messages) as plain text. */
public final class CapturingSource implements CommandSource {
	private final StringBuilder out = new StringBuilder();

	@Override
	public void sendSystemMessage(Component message) {
		if (!out.isEmpty()) {
			out.append('\n');
		}
		out.append(message.getString());
	}

	@Override
	public boolean acceptsSuccess() {
		return true;
	}

	@Override
	public boolean acceptsFailure() {
		return true;
	}

	@Override
	public boolean shouldInformAdmins() {
		return false;
	}

	public String output() {
		return out.toString();
	}
}
