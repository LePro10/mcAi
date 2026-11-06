package dev.mcai.client.screen;

import java.util.function.BooleanSupplier;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.narration.NarratedElementType;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.network.chat.Component;

/** Selectable pill (style / size / toggle). */
public class Chip extends Button {
	public static final int HEIGHT = 14;

	private final BooleanSupplier selected;
	private final int accent;

	public Chip(int x, int y, Component label, int accent, BooleanSupplier selected, Runnable action) {
		super(x, y, width(label), HEIGHT, label, b -> action.run(), DEFAULT_NARRATION);
		this.selected = selected;
		this.accent = accent;
	}

	public static int width(Component label) {
		return Minecraft.getInstance().font.width(label) + 12;
	}


	@Override
	protected void extractContents(GuiGraphicsExtractor g, int mouseX, int mouseY, float partial) {
		boolean on = selected.getAsBoolean();
		boolean hot = active && isHoveredOrFocused();
		int fill = on ? accent : !active ? 0x12FFFFFF : hot ? Theme.CHIP_HOVER : Theme.CHIP;
		int border = on ? 0xFFFFFFFF & (accent | 0xFF000000) : hot ? 0x99FFFFFF : 0x30FFFFFF;
		int text = on ? 0xFF15110A : active ? Theme.TEXT : 0x70FFFFFF;
		Theme.box(g, getX(), getY(), getX() + getWidth(), getY() + getHeight(), fill, border);
		g.centeredText(Minecraft.getInstance().font, getMessage(), getX() + getWidth() / 2, getY() + 3, text);
	}

	@Override
	public void updateWidgetNarration(NarrationElementOutput out) {
		super.updateWidgetNarration(out);
		out.add(NarratedElementType.USAGE, Component.translatable(selected.getAsBoolean() ? "mcai.ui.selected" : "mcai.ui.not_selected"));
	}
}
