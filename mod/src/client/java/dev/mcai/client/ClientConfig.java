package dev.mcai.client;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import dev.mcai.McaiMod;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.loader.api.FabricLoader;

/** Client preferences, config/mcai-client.json: recent prompts, last choices, HUD toggle. */
public final class ClientConfig {
	public static final int MAX_RECENT = 8;

	public List<String> recentPrompts = new ArrayList<>();
	public String style = "auto";
	public String size = "M";
	public boolean useSelection = true;
	public boolean hudEnabled = true;

	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static ClientConfig instance;

	public static ClientConfig get() {
		if (instance == null) {
			instance = load();
		}
		return instance;
	}

	private static Path file() {
		return FabricLoader.getInstance().getConfigDir().resolve("mcai-client.json");
	}

	private static ClientConfig load() {
		try {
			if (Files.isRegularFile(file())) {
				ClientConfig c = GSON.fromJson(Files.readString(file(), StandardCharsets.UTF_8), ClientConfig.class);
				if (c != null) {
					// a hand-edited file must not crash the prompt screen (or exceed the payload limits)
					c.recentPrompts = c.recentPrompts == null ? new ArrayList<>()
							: new ArrayList<>(c.recentPrompts.stream().filter(p -> p != null && !p.isBlank()).limit(MAX_RECENT).toList());
					if (c.style == null || !java.util.Arrays.asList(dev.mcai.client.screen.PromptScreen.STYLES).contains(c.style)) {
						c.style = "auto";
					}
					if (c.size == null || !java.util.Arrays.asList(dev.mcai.client.screen.PromptScreen.SIZES).contains(c.size)) {
						c.size = "M";
					}
					return c;
				}
			}
		} catch (Exception e) {
			McaiMod.LOG.warn("mcai: could not read {}: {}", file(), e.getMessage());
		}
		return new ClientConfig();
	}

	public void save() {
		try {
			Files.createDirectories(file().getParent());
			Files.writeString(file(), GSON.toJson(this), StandardCharsets.UTF_8);
		} catch (Exception e) {
			McaiMod.LOG.warn("mcai: could not write {}: {}", file(), e.getMessage());
		}
	}

	public void remember(String prompt) {
		String p = prompt.strip();
		if (p.isEmpty()) {
			return;
		}
		recentPrompts.remove(p);
		recentPrompts.addFirst(p);
		while (recentPrompts.size() > MAX_RECENT) {
			recentPrompts.removeLast();
		}
		save();
	}
}
