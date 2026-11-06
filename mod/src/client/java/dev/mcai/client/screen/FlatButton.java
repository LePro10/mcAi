package dev.mcai.client.screen;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.network.chat.Component;

/** Flat button in the mcAI style (primary = gold, danger = red outline). */
public class FlatButton extends Button {
	public enum Kind { PRIMARY, NORMAL, DANGER }

	private final Kind kind;

	public FlatButton(int x, int y, int w, int h, Component label, Kind kind, Runnable action) {
		super(x, y, w, h, label, b -> action.run(), DEFAULT_NARRATION);
		this.kind = kind;
	}


	@Override
	protected void extractContents(GuiGraphicsExtractor g, int mouseX, int mouseY, float partial) {
		boolean hot = active && isHoveredOrFocused();
		int fill;
		int border;
		int text;
		switch (kind) {
			case PRIMARY -> {
				fill = !active ? 0x40F2B84A : hot ? 0xFFFFCD6B : Theme.ACCENT;
				border = !active ? 0 : hot ? 0xFFFFE3A3 : Theme.ACCENT_DARK;
				text = active ? 0xFF1A1206 : 0x99FFFFFF;
			}
			case DANGER -> {
				fill = hot ? 0x55FF5A5A : 0x30FF5A5A;
				border = active ? Theme.BAD : 0x40FF5A5A;
				text = active ? 0xFFFFD6D6 : 0x80FFFFFF;
			}
			default -> {
				fill = !active ? 0x18FFFFFF : hot ? Theme.CHIP_HOVER : Theme.CHIP;
				border = hot ? 0x99FFFFFF : 0x40FFFFFF;
				text = active ? Theme.TEXT : 0x80FFFFFF;
			}
		}
		Theme.box(g, getX(), getY(), getX() + getWidth(), getY() + getHeight(), fill, border);
		var font = Minecraft.getInstance().font;
		g.centeredText(font, getMessage(), getX() + getWidth() / 2, getY() + (getHeight() - 8) / 2, text);
	}

}
