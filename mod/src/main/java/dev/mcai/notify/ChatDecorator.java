package dev.mcai.notify;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.mcai.build.JobTracker;
import dev.mcai.build.StatusService;
import dev.mcai.ui.ChatActions;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.level.ServerPlayer;

/**
 * Adds clickable buttons to engine chat notifications (§5 notify):
 * <ul>
 *   <li>{@code options: string[]} (or "1) a  2) b … /mcai reply" in the text) → answer buttons;</li>
 *   <li>{@code actions: ['undo','redo','cancel','viewer']} → those buttons;</li>
 *   <li>a job-end message (arrives just after the player's job reached done/failed/cancelled) →
 *       [Undo] [Redo] [Open viewer].</li>
 * </ul>
 */
public final class ChatDecorator {
	private static final Pattern OPTION = Pattern.compile("(\\d{1,2})\\)\\s+(.+?)(?=\\s{2,}|\\s+—|\\s+-\\s|$)");
	private static final int JOB_END_WINDOW_TICKS = 200;

	private final JobTracker jobs;
	private final StatusService status;

	public ChatDecorator(JobTracker jobs, StatusService status) {
		this.jobs = jobs;
		this.status = status;
	}

	public Component decorate(ServerPlayer p, JsonObject n, Component text) {
		String raw = text.getString();
		List<String> options = strings(n.get("options"));
		if (options.isEmpty() && raw.contains("/mcai reply")) {
			Matcher m = OPTION.matcher(raw);
			while (m.find()) {
				options.add(m.group(2).trim());
			}
		}
		MutableComponent out = text.copy();
		if (!options.isEmpty()) {
			List<Component> buttons = new ArrayList<>();
			for (int i = 0; i < options.size(); i++) {
				buttons.add(ChatActions.option(i + 1, options.get(i)));
			}
			buttons.add(ChatActions.freeAnswer());
			return out.append("\n").append(ChatActions.row(buttons.toArray(Component[]::new)));
		}
		List<String> actions = strings(n.get("actions"));
		if (actions.isEmpty() && raw.startsWith("[mcAI]") && jobs.recentlyEnded(p.getGameProfile().name(), JOB_END_WINDOW_TICKS)) {
			actions = List.of("undo", "redo", "viewer");
		}
		if (actions.isEmpty()) {
			return out;
		}
		String url = status.viewerUrl();
		List<Component> buttons = new ArrayList<>();
		for (String a : actions) {
			switch (a) {
				case "undo" -> buttons.add(ChatActions.undo());
				case "redo" -> buttons.add(ChatActions.redo());
				case "cancel" -> buttons.add(ChatActions.cancel());
				case "viewer" -> {
					if (!url.isEmpty()) {
						buttons.add(ChatActions.viewer(url));
					}
				}
				default -> {
				}
			}
		}
		return buttons.isEmpty() ? out : out.append(" ").append(ChatActions.row(buttons.toArray(Component[]::new)));
	}

	private static List<String> strings(JsonElement e) {
		List<String> out = new ArrayList<>();
		if (e != null && e.isJsonArray()) {
			JsonArray a = e.getAsJsonArray();
			for (JsonElement x : a) {
				if (x.isJsonPrimitive()) {
					out.add(x.getAsString());
				}
			}
		}
		return out;
	}
}
