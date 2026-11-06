package dev.mcai.config;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Where the engine listens. Resolved anew before every connection attempt. */
public record EngineEndpoint(String host, int port, String token, String source) {
	public URI uri() {
		return URI.create("ws://" + host + ":" + port + "/mod");
	}

	/** {@code $MCAI_HOME} or {@code ~/.mcai}, same rule as the engine. */
	public static Path mcaiHome() {
		String env = System.getenv("MCAI_HOME");
		return env != null && !env.isBlank() ? Path.of(env) : Path.of(System.getProperty("user.home"), ".mcai");
	}

	/** Config override first, else {@code engine.json}; null if neither is usable. */
	public static EngineEndpoint discover(McaiConfig cfg) {
		McaiConfig.Engine e = cfg.engine;
		if (e.port > 0 && e.token != null && !e.token.isBlank()) {
			return new EngineEndpoint(hostOrDefault(e.host), e.port, e.token, "config/mcai.json");
		}
		Path file = mcaiHome().resolve("engine.json");
		try {
			if (!Files.isRegularFile(file)) {
				return null;
			}
			JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
			int port = o.get("port").getAsInt();
			String token = o.has("token") ? o.get("token").getAsString() : "";
			return port > 0 ? new EngineEndpoint(hostOrDefault(e.host), port, token, file.toString()) : null;
		} catch (Exception ex) {
			return null;
		}
	}

	private static String hostOrDefault(String host) {
		return host == null || host.isBlank() ? "127.0.0.1" : host;
	}
}
