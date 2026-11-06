package dev.mcai.ui;

import java.net.URI;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;

/** Clickable chat buttons: [Undo] [Redo] [Cancel] [Open viewer] and answer options. */
public final class ChatActions {
	private ChatActions() {
	}

	public static MutableComponent command(String key, String fallback, String command, ChatFormatting color, String hoverKey, String hoverFallback) {
		return Component.literal("[").append(Msg.tr(key, fallback)).append("]")
				.withStyle(s -> s.withColor(color).withBold(false)
						.withClickEvent(new ClickEvent.RunCommand(command))
						.withHoverEvent(new HoverEvent.ShowText(Msg.tr(hoverKey, hoverFallback))));
	}

	public static MutableComponent undo() {
		return command("mcai.chat.undo", "Undo", "/mcai undo", ChatFormatting.YELLOW, "mcai.chat.undo.hover", "Revert the whole AI build");
	}

	public static MutableComponent redo() {
		return command("mcai.chat.redo", "Redo", "/mcai redo", ChatFormatting.AQUA, "mcai.chat.redo.hover", "Restore what was undone");
	}

	public static MutableComponent cancel() {
		return command("mcai.chat.cancel", "Cancel", "/mcai cancel", ChatFormatting.RED, "mcai.chat.cancel.hover", "Stop the running build (placed blocks stay; use Undo)");
	}

	public static MutableComponent viewer(String url) {
		return Component.literal("[").append(Msg.tr("mcai.chat.viewer", "Open viewer")).append("]")
				.withStyle(s -> s.withColor(ChatFormatting.GREEN)
						.withClickEvent(new ClickEvent.OpenUrl(URI.create(url)))
						.withHoverEvent(new HoverEvent.ShowText(Component.literal(url))));
	}

	/** Answer option "[1 Gothic]" → /mcai reply 1. */
	public static MutableComponent option(int number, String label) {
		return Component.literal("[" + number + " " + label + "]")
				.withStyle(s -> s.withColor(ChatFormatting.AQUA)
						.withClickEvent(new ClickEvent.RunCommand("/mcai reply " + number))
						.withHoverEvent(new HoverEvent.ShowText(Msg.tr("mcai.chat.answer.hover", "Answer: %s", label))));
	}

	/** [Answer…] → suggests /mcai reply in the chat box for a free-text answer. */
	public static MutableComponent freeAnswer() {
		return Component.literal("[").append(Msg.tr("mcai.chat.answer_free", "Own answer…")).append("]")
				.withStyle(s -> s.withColor(ChatFormatting.GRAY)
						.withClickEvent(new ClickEvent.SuggestCommand("/mcai reply "))
						.withHoverEvent(new HoverEvent.ShowText(Msg.tr("mcai.chat.answer_free.hover", "Type your own answer"))));
	}

	/** Join buttons with spaces. */
	public static MutableComponent row(Component... parts) {
		MutableComponent out = Component.empty();
		for (int i = 0; i < parts.length; i++) {
			if (parts[i] == null) {
				continue;
			}
			if (!out.getSiblings().isEmpty()) {
				out.append(" ");
			}
			out.append(parts[i]);
		}
		return out;
	}
}
