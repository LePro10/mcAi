package dev.mcai.client.screen;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.network.chat.Component;

/** One recent prompt: click to put it back into the prompt box. */
public class RecentRow extends Button {
	public static final int HEIGHT = 11;
	private final String text;

	public RecentRow(int x, int y, int w, String text, Runnable action) {
		super(x, y, w, HEIGHT, Component.literal(text), b -> action.run(), DEFAULT_NARRATION);
		this.text = text;
	}


	@Override
	protected void extractContents(GuiGraphicsExtractor g, int mouseX, int mouseY, float partial) {
		var font = Minecraft.getInstance().font;
		boolean hot = isHoveredOrFocused();
		if (hot) {
			g.fill(getX(), getY(), getX() + getWidth(), getY() + getHeight(), 0x22FFFFFF);
		}
		String oneLine = text.replace('\n', ' ');
		String shown = font.plainSubstrByWidth(oneLine, getWidth() - 14);
		if (shown.length() < oneLine.length()) {
			shown = font.plainSubstrByWidth(oneLine, getWidth() - 22) + "…";
		}
		g.text(font, "↺", getX() + 2, getY() + 2, hot ? Theme.ACCENT : Theme.FAINT, false);
		g.text(font, shown, getX() + 12, getY() + 2, hot ? Theme.TEXT : Theme.MUTED, false);
	}

}
