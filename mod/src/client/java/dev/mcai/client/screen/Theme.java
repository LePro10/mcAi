package dev.mcai.client.screen;

import net.minecraft.client.gui.GuiGraphicsExtractor;

/** Colours and small drawing helpers for the mcAI UI (dark translucent panels, gold accent). */
public final class Theme {
	public static final int PANEL = 0xE6101318;
	public static final int PANEL_EDGE = 0xFF2A2F38;
	public static final int SECTION = 0x66000000;
	public static final int ACCENT = 0xFFF2B84A;
	public static final int ACCENT_DARK = 0xFF8A6420;
	public static final int CYAN = 0xFF5ED7FF;
	public static final int TEXT = 0xFFF2F2F2;
	public static final int MUTED = 0xFF9AA3AE;
	public static final int FAINT = 0xFF5C6570;
	public static final int OK = 0xFF5BD46A;
	public static final int BAD = 0xFFFF5A5A;
	public static final int WARN = 0xFFFFC04A;
	public static final int CHIP = 0x33FFFFFF;
	public static final int CHIP_HOVER = 0x55FFFFFF;

	private Theme() {
	}

	/** Filled box with a 1 px border; corners are cut by one pixel for a softer look. */
	public static void box(GuiGraphicsExtractor g, int x0, int y0, int x1, int y1, int fill, int border) {
		g.fill(x0 + 1, y0, x1 - 1, y1, fill);
		g.fill(x0, y0 + 1, x0 + 1, y1 - 1, fill);
		g.fill(x1 - 1, y0 + 1, x1, y1 - 1, fill);
		if (border != 0) {
			g.fill(x0 + 1, y0, x1 - 1, y0 + 1, border);
			g.fill(x0 + 1, y1 - 1, x1 - 1, y1, border);
			g.fill(x0, y0 + 1, x0 + 1, y1 - 1, border);
			g.fill(x1 - 1, y0 + 1, x1, y1 - 1, border);
		}
	}

	public static int alpha(int argb, float a) {
		int base = (argb >>> 24) & 0xFF;
		return (Math.round(base * Math.clamp(a, 0f, 1f)) << 24) | (argb & 0xFFFFFF);
	}
}
