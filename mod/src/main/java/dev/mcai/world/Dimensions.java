package dev.mcai.world;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcai.protocol.ProtocolException;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;

/** Dimension id strings ↔ levels. */
public final class Dimensions {
	public static final String OVERWORLD = "minecraft:overworld";

	private Dimensions() {
	}

	public static ServerLevel level(MinecraftServer server, String id) {
		Identifier loc = Identifier.tryParse(id == null || id.isBlank() ? OVERWORLD : id);
		ServerLevel level = loc == null ? null : server.getLevel(ResourceKey.create(Registries.DIMENSION, loc));
		if (level == null) {
			throw new ProtocolException("unknown dimension '" + id + "'");
		}
		return level;
	}

	public static String id(ServerLevel level) {
		return level.dimension().identifier().toString();
	}

	/** [{id, minY, maxY (inclusive), seaLevel}] for the hello message. */
	public static JsonArray describe(MinecraftServer server) {
		JsonArray out = new JsonArray();
		for (ServerLevel level : server.getAllLevels()) {
			JsonObject d = new JsonObject();
			d.addProperty("id", id(level));
			d.addProperty("minY", level.getMinY());
			d.addProperty("maxY", level.getMaxY());
			d.addProperty("seaLevel", level.getSeaLevel());
			out.add(d);
		}
		return out;
	}
}
