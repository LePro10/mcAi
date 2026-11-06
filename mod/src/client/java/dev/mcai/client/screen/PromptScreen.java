package dev.mcai.client.screen;

import dev.mcai.client.ClientConfig;
import dev.mcai.client.ClientState;
import dev.mcai.net.McaiPayloads;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;
import com.mojang.blaze3d.platform.InputConstants;

/**
 * The prompt GUI: describe a build, pick a style and size (or use the wand selection), then
 * Build / Plan. Sends {@link McaiPayloads.BuildRequest}; the server validates and answers in chat.
 */
public final class PromptScreen extends Screen {
	public static final String[] STYLES = {"auto", "medieval", "fantasy", "japanese", "modern", "steampunk", "nordic", "desert", "gothic", "cozy"};
	public static final String[] SIZES = {"S", "M", "L", "XL"};
	public static final int[][] SIZE_DIMS = {{16, 16, 16}, {32, 24, 32}, {48, 40, 48}, {96, 64, 96}};
	public static final int MAX_CHARS = 2000;
	private static final int PAD = 8;
	private static final boolean MAC = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("mac");
	private static final int GAP = 5;

	private final ClientConfig cfg = ClientConfig.get();
	private String draft = "";
	private MultiLineEditBox prompt;
	private FlatButton build;
	private FlatButton plan;
	private FlatButton cancelJob;
	private final List<Chip> sizeChips = new ArrayList<>();
	private Chip useSelChip;
	private int px0, py0, px1, py1;
	private int promptY, promptH, styleY, sizeY, recentY, statusY, buttonsY;
	private int sizeLabelX;

	public PromptScreen() {
		super(Component.translatable("mcai.ui.title"));
	}

	@Override
	protected void init() {
		if (prompt != null) {
			draft = prompt.getValue();
		}
		sizeChips.clear();
		var font = Minecraft.getInstance().font;
		int w = Math.min(width - 16, 460);
		int h = Math.min(height - 12, 320);
		px0 = (width - w) / 2;
		py0 = (height - h) / 2;
		px1 = px0 + w;
		py1 = py0 + h;
		int innerX = px0 + PAD;
		int innerW = w - 2 * PAD;

		// style chips (flow layout, measured first)
		Component styleLabel = Component.translatable("mcai.ui.style");
		int labelW = Math.max(font.width(styleLabel), font.width(Component.translatable("mcai.ui.size"))) + 6;
		List<int[]> chipPos = new ArrayList<>();
		int cx = innerX + labelW;
		int row = 0;
		for (String s : STYLES) {
			int cw = Chip.width(Component.translatable("mcai.style." + s));
			if (cx + cw > innerX + innerW) {
				cx = innerX + labelW;
				row++;
			}
			chipPos.add(new int[] {cx, row});
			cx += cw + 3;
		}
		int styleRows = row + 1;
		int styleH = styleRows * (Chip.HEIGHT + 2);
		int headerH = 12;
		int sizeH = Chip.HEIGHT;
		int statusH = 2 * font.lineHeight + 2;
		int buttonsH = 20;
		int hintH = font.lineHeight + 1;
		int fixed = PAD + headerH + GAP + hintH + GAP + styleH + GAP + sizeH + GAP + statusH + GAP + buttonsH + PAD;
		int recentRows = 0;
		int avail = h - fixed;
		int maxRecent = Math.min(3, cfg.recentPrompts.size());
		while (recentRows < maxRecent && avail - (recentRows + 1) * RecentRow.HEIGHT - (recentRows == 0 ? font.lineHeight + GAP : 0) >= 48) {
			recentRows++;
		}
		int recentH = recentRows == 0 ? 0 : font.lineHeight + recentRows * RecentRow.HEIGHT + GAP;
		promptH = Math.clamp(avail - recentH, 28, 96);
		// shrink the panel to its content and centre it
		h = fixed + recentH + promptH;
		py0 = (height - h) / 2;
		py1 = py0 + h;

		int y = py0 + PAD + headerH + GAP;
		promptY = y;
		prompt = MultiLineEditBox.builder().setX(innerX).setY(y)
				.setShowBackground(true).setTextColor(Theme.TEXT).setCursorColor(Theme.ACCENT)
				.build(font, innerW, promptH, Component.translatable("mcai.ui.prompt"));
		prompt.setCharacterLimit(MAX_CHARS);
		prompt.setValue(draft);
		addRenderableWidget(prompt);
		y += promptH + hintH + GAP;

		styleY = y;
		for (int i = 0; i < STYLES.length; i++) {
			String id = STYLES[i];
			int[] pos = chipPos.get(i);
			addRenderableWidget(new Chip(pos[0], y + pos[1] * (Chip.HEIGHT + 2), Component.translatable("mcai.style." + id), Theme.ACCENT,
					() -> cfg.style.equals(id), () -> cfg.style = id));
		}
		y += styleH + GAP;

		sizeY = y;
		int sx = innerX + labelW;
		for (int i = 0; i < SIZES.length; i++) {
			String id = SIZES[i];
			Chip c = new Chip(sx, y, Component.literal(id), Theme.CYAN, () -> cfg.size.equals(id) && !usingSelection(), () -> cfg.size = id);
			sizeChips.add(c);
			addRenderableWidget(c);
			sx += c.getWidth() + 3;
		}
		sizeLabelX = sx + 4;
		Component selLabel = Component.translatable("mcai.ui.use_selection");
		useSelChip = new Chip(0, y, selLabel, Theme.OK, () -> usingSelection(), () -> cfg.useSelection = !cfg.useSelection);
		useSelChip.setX(innerX + innerW - useSelChip.getWidth());
		addRenderableWidget(useSelChip);
		y += sizeH + GAP;

		recentY = y;
		if (recentRows > 0) {
			int ry = y + font.lineHeight;
			for (int i = 0; i < recentRows; i++) {
				String text = cfg.recentPrompts.get(i);
				addRenderableWidget(new RecentRow(innerX, ry, innerW, text, () -> prompt.setValue(text)));
				ry += RecentRow.HEIGHT;
			}
			y += recentH;
		}
		statusY = y;
		buttonsY = py1 - PAD - buttonsH;

		int bw = Math.min(96, (innerW - 3 * 4) / 4);
		int bx = innerX + innerW - bw;
		addRenderableWidget(new FlatButton(bx, buttonsY, bw, buttonsH, Component.translatable("mcai.ui.close"), FlatButton.Kind.NORMAL, this::onClose));
		bx -= bw + 4;
		cancelJob = addRenderableWidget(new FlatButton(innerX, buttonsY, bw, buttonsH, Component.translatable("mcai.ui.cancel_job"), FlatButton.Kind.DANGER,
				() -> send(new McaiPayloads.JobAction("cancel", ""))));
		plan = addRenderableWidget(new FlatButton(bx, buttonsY, bw, buttonsH, Component.translatable("mcai.ui.plan"), FlatButton.Kind.NORMAL, () -> submit("plan")));
		bx -= bw + 4;
		build = addRenderableWidget(new FlatButton(bx, buttonsY, bw, buttonsH, Component.translatable("mcai.ui.build"), FlatButton.Kind.PRIMARY, () -> submit("build")));
		setInitialFocus(prompt);
		updateButtons();
		if (ClientPlayNetworking.canSend(McaiPayloads.JobAction.TYPE)) {
			ClientPlayNetworking.send(new McaiPayloads.JobAction("status", ""));
		}
	}

	private boolean modServer() {
		return ClientPlayNetworking.canSend(McaiPayloads.BuildRequest.TYPE);
	}

	private String dimension() {
		var level = Minecraft.getInstance().level;
		return level == null ? "" : level.dimension().identifier().toString();
	}

	private int[] selectionSize() {
		return ClientState.selectionSize(dimension());
	}

	private boolean usingSelection() {
		return cfg.useSelection && selectionSize() != null;
	}

	/** For tests: is the Build button enabled? */
	public boolean buildButtonActive() {
		return build != null && build.active;
	}

	private boolean canBuild() {
		McaiPayloads.Status s = ClientState.status();
		return modServer() && s != null && s.engineConnected() && s.permitted() && !ClientState.jobRunning()
				&& ClientState.cooldownLeft() <= 0 && prompt != null && !prompt.getValue().isBlank();
	}

	private void updateButtons() {
		boolean ok = canBuild();
		build.active = ok;
		plan.active = ok;
		cancelJob.visible = ClientState.jobRunning();
		useSelChip.active = selectionSize() != null;
		for (Chip c : sizeChips) {
			c.active = !usingSelection();
		}
	}

	@Override
	public void tick() {
		super.tick();
		updateButtons();
	}

	private void submit(String mode) {
		if (!canBuild()) {
			return;
		}
		String text = prompt.getValue().strip();
		send(new McaiPayloads.BuildRequest(text, cfg.style, cfg.size, usingSelection(), mode));
		cfg.remember(text);
		cfg.save();
		draft = "";
		onClose();
	}

	private static void send(McaiPayloads.JobAction a) {
		if (ClientPlayNetworking.canSend(McaiPayloads.JobAction.TYPE)) {
			ClientPlayNetworking.send(a);
		}
	}

	private static void send(McaiPayloads.BuildRequest r) {
		ClientPlayNetworking.send(r);
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		if ((e.key() == InputConstants.KEY_RETURN || e.key() == InputConstants.KEY_NUMPADENTER) && (e.hasControlDown() || e.hasControlDownWithQuirk())) {
			submit("build");
			return true;
		}
		return super.keyPressed(e);
	}

	@Override
	public void removed() {
		cfg.save();
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float partial) {
		super.extractRenderState(g, mouseX, mouseY, partial);
		if (prompt != null && prompt.getValue().isEmpty()) {
			// placeholder stays visible while the box is focused (vanilla hides it)
			var font = Minecraft.getInstance().font;
			int w = prompt.getWidth() - 10;
			int y = prompt.getY() + 5;
			for (FormattedCharSequence line : font.split(Component.translatable("mcai.ui.placeholder"), w)) {
				g.text(font, line, prompt.getX() + 5, y, Theme.FAINT, false);
				y += font.lineHeight + 1;
			}
		}
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float partial) {
		super.extractBackground(g, mouseX, mouseY, partial);
		var font = Minecraft.getInstance().font;
		Theme.box(g, px0, py0, px1, py1, Theme.PANEL, Theme.PANEL_EDGE);
		g.fill(px0 + 1, py0 + 1, px1 - 1, py0 + 2, Theme.ACCENT);
		int x = px0 + PAD;
		int innerW = px1 - px0 - 2 * PAD;
		// header
		g.text(font, Component.literal("mcAI"), x, py0 + PAD, Theme.ACCENT, true);
		g.text(font, Component.translatable("mcai.ui.subtitle"), x + font.width("mcAI") + 4, py0 + PAD, Theme.TEXT, false);
		McaiPayloads.Status s = ClientState.status();
		boolean up = s != null && s.engineConnected();
		Component badge = Component.translatable(s == null ? "mcai.ui.engine_checking" : up ? "mcai.ui.engine_online" : "mcai.ui.engine_offline");
		int bw = font.width(badge);
		int bx = px1 - PAD - bw;
		g.text(font, "●", bx - 9, py0 + PAD, s == null ? Theme.WARN : up ? Theme.OK : Theme.BAD, false);
		g.text(font, badge, bx, py0 + PAD, Theme.MUTED, false);
		// under the prompt box: shortcut hint + character count
		int hy = promptY + promptH + 2;
		g.text(font, Component.translatable("mcai.ui.hint_submit", MAC ? "Cmd" : "Ctrl"), x, hy, Theme.FAINT, false);
		String count = (prompt == null ? 0 : prompt.getValue().length()) + "/" + MAX_CHARS;
		g.text(font, count, x + innerW - font.width(count), hy, Theme.FAINT, false);
		// section labels
		g.text(font, Component.translatable("mcai.ui.style"), x, styleY + 3, Theme.MUTED, false);
		g.text(font, Component.translatable("mcai.ui.size"), x, sizeY + 3, Theme.MUTED, false);
		int[] sel = selectionSize();
		Component dims;
		if (usingSelection()) {
			dims = Component.translatable("mcai.ui.dims_selection", sel[0], sel[1], sel[2]);
		} else {
			int[] d = SIZE_DIMS[Math.max(0, java.util.Arrays.asList(SIZES).indexOf(cfg.size))];
			dims = Component.translatable("mcai.ui.dims", d[0], d[1], d[2]);
		}
		g.text(font, dims, sizeLabelX, sizeY + 3, usingSelection() ? Theme.OK : Theme.CYAN, false);
		if (recentY < statusY) {
			g.text(font, Component.translatable("mcai.ui.recent"), x, recentY, Theme.MUTED, false);
		}
		// status line (wrapped to 2 lines)
		Component status = statusLine();
		int color = statusColor();
		List<FormattedCharSequence> lines = font.split(status, innerW);
		int sy = statusY;
		for (int i = 0; i < Math.min(2, lines.size()); i++) {
			g.text(font, lines.get(i), x, sy, color, false);
			sy += font.lineHeight + 1;
		}
	}

	private Component statusLine() {
		McaiPayloads.Status s = ClientState.status();
		if (!modServer()) {
			return Component.translatable("mcai.ui.status.no_mod_server");
		}
		if (s == null) {
			return Component.translatable("mcai.ui.engine_checking");
		}
		if (!s.engineConnected()) {
			Component hint = s.problemKey().isEmpty() ? Component.empty() : Component.translatable(s.problemKey(), s.problemArgs().toArray());
			return Component.translatable("mcai.ui.status.offline", hint);
		}
		if (!s.permitted()) {
			return Component.translatable("mcai.ui.status.no_permission");
		}
		if (ClientState.jobRunning()) {
			return Component.translatable("mcai.ui.status.running");
		}
		if (ClientState.cooldownLeft() > 0) {
			return Component.translatable("mcai.ui.status.cooldown", ClientState.cooldownLeft());
		}
		if (!s.problemKey().isEmpty()) {
			return Component.translatable(s.problemKey(), s.problemArgs().toArray());
		}
		return Component.translatable(usingSelection() ? "mcai.ui.status.ready_selection" : "mcai.ui.status.ready_size");
	}

	private int statusColor() {
		McaiPayloads.Status s = ClientState.status();
		if (!modServer() || s == null) {
			return Theme.WARN;
		}
		if (!s.engineConnected() || !s.permitted()) {
			return Theme.BAD;
		}
		if (ClientState.jobRunning() || ClientState.cooldownLeft() > 0 || !s.problemKey().isEmpty()) {
			return Theme.WARN;
		}
		return Theme.OK;
	}
}
