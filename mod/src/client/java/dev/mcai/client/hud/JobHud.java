package dev.mcai.client.hud;

import dev.mcai.build.JobTracker;
import dev.mcai.client.ClientConfig;
import dev.mcai.client.ClientState;
import dev.mcai.client.screen.Theme;
import dev.mcai.net.McaiPayloads;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.network.chat.Component;

/**
 * Compact job panel, top-right: state, prompt, progress bar, stage, the last three "thoughts"
 * (fading with age) and cost. Shown while a job runs and a few seconds after it ends; H toggles.
 */
public final class JobHud {
	private static final int WIDTH = 190;
	private static final long LINGER_MS = 8_000;
	private static final long THOUGHT_FADE_MS = 20_000;

	private JobHud() {
	}

	public static void extract(GuiGraphicsExtractor g, DeltaTracker delta) {
		Minecraft mc = Minecraft.getInstance();
		McaiPayloads.JobUpdate job = ClientState.job();
		if (job == null || !ClientConfig.get().hudEnabled || mc.player == null) {
			return;
		}
		long now = System.currentTimeMillis();
		boolean ended = JobTracker.terminal(job.state());
		long since = now - ClientState.jobUpdatedAt();
		if (ended && since > LINGER_MS) {
			return;
		}
		float fade = ended ? Math.clamp(1f - (since - (LINGER_MS - 1500)) / 1500f, 0f, 1f) : 1f;
		Font font = mc.font;
		int x1 = g.guiWidth() - 4;
		int x0 = x1 - WIDTH;
		int y0 = 4 + (mc.player.getActiveEffects().isEmpty() ? 0 : 52);
		List<ClientState.Thought> thoughts = ClientState.thoughts();
		String prompt = job.prompt().replace('\n', ' ');
		int lines = 2 + (prompt.isEmpty() ? 0 : 1) + (job.stage().isEmpty() ? 0 : 1) + thoughts.size();
		int h = 6 + lines * 10 + 6 + 4;
		Theme.box(g, x0, y0, x1, y0 + h, Theme.alpha(0xD0101318, fade), Theme.alpha(Theme.PANEL_EDGE, fade));
		g.fill(x0 + 1, y0 + 1, x0 + 2, y0 + h - 1, Theme.alpha(stateColor(job.state()), fade));
		int x = x0 + 7;
		int y = y0 + 5;
		// title: mcAI · state            $cost
		Component state = Component.translatable("mcai.job.state." + job.state());
		g.text(font, "mcAI", x, y, Theme.alpha(Theme.ACCENT, fade), true);
		g.text(font, state, x + font.width("mcAI") + 5, y, Theme.alpha(stateColor(job.state()), fade), false);
		if (job.costUsd() > 0) {
			String cost = String.format(Locale.ROOT, "$%.2f", job.costUsd());
			g.text(font, cost, x1 - 6 - font.width(cost), y, Theme.alpha(Theme.MUTED, fade), false);
		}
		y += 10;
		if (!prompt.isEmpty()) {
			g.text(font, clip(font, "“" + prompt + "”", WIDTH - 14), x, y, Theme.alpha(Theme.MUTED, fade), false);
			y += 10;
		}
		// progress bar
		int barW = WIDTH - 14 - 26;
		float p = job.state().equals("done") ? 1f : Math.clamp(job.progress(), 0f, 1f);
		g.fill(x, y + 2, x + barW, y + 6, Theme.alpha(0x40FFFFFF, fade));
		g.fill(x, y + 2, x + Math.round(barW * p), y + 6, Theme.alpha(stateColor(job.state()), fade));
		String pct = Math.round(p * 100) + "%";
		g.text(font, pct, x1 - 6 - font.width(pct), y, Theme.alpha(Theme.TEXT, fade), false);
		y += 10;
		if (!job.stage().isEmpty()) {
			g.text(font, clip(font, job.stage(), WIDTH - 14), x, y, Theme.alpha(Theme.TEXT, fade), false);
			y += 10;
		}
		for (int i = 0; i < thoughts.size(); i++) {
			ClientState.Thought t = thoughts.get(i);
			float age = Math.clamp((now - t.atMillis()) / (float) THOUGHT_FADE_MS, 0f, 1f);
			float rank = (i + 1f) / thoughts.size(); // newest = 1
			float a = fade * Math.max(0.3f, (0.45f + 0.55f * rank) * (1f - 0.6f * age));
			g.text(font, clip(font, "› " + t.text(), WIDTH - 14), x, y, Theme.alpha(0xFFB9C3CF, a), false);
			y += 10;
		}
	}

	private static String clip(Font font, String s, int w) {
		if (font.width(s) <= w) {
			return s;
		}
		return font.plainSubstrByWidth(s, w - font.width("…")) + "…";
	}

	static int stateColor(String state) {
		return switch (state) {
			case "queued" -> 0xFFB0B8C2;
			case "thinking", "reviewing" -> 0xFFB98CFF;
			case "done" -> Theme.OK;
			case "failed" -> Theme.BAD;
			case "cancelled" -> Theme.WARN;
			default -> Theme.CYAN;
		};
	}
}
