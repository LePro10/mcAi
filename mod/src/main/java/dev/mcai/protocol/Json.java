package dev.mcai.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** Small, strict accessors for request fields. */
public final class Json {
	private Json() {
	}

	public static String str(JsonObject o, String key, String def) {
		JsonElement e = o.get(key);
		return e == null || e.isJsonNull() ? def : e.getAsString();
	}

	public static String requireStr(JsonObject o, String key) {
		JsonElement e = o.get(key);
		if (e == null || e.isJsonNull() || !e.isJsonPrimitive()) {
			throw new ProtocolException("missing string field '" + key + "'");
		}
		return e.getAsString();
	}

	public static int integer(JsonObject o, String key, int def) {
		JsonElement e = o.get(key);
		if (e == null || e.isJsonNull()) {
			return def;
		}
		try {
			return (int) Math.floor(e.getAsDouble());
		} catch (RuntimeException ex) {
			throw new ProtocolException("field '" + key + "' must be a number");
		}
	}

	public static int requireInt(JsonObject o, String key) {
		if (!o.has(key)) {
			throw new ProtocolException("missing number field '" + key + "'");
		}
		return integer(o, key, 0);
	}

	public static double number(JsonObject o, String key, double def) {
		JsonElement e = o.get(key);
		if (e == null || e.isJsonNull()) {
			return def;
		}
		try {
			return e.getAsDouble();
		} catch (RuntimeException ex) {
			throw new ProtocolException("field '" + key + "' must be a number");
		}
	}

	public static boolean bool(JsonObject o, String key, boolean def) {
		JsonElement e = o.get(key);
		return e == null || e.isJsonNull() ? def : e.getAsBoolean();
	}

	public static JsonObject obj(JsonObject o, String key) {
		JsonElement e = o.get(key);
		if (e == null || !e.isJsonObject()) {
			throw new ProtocolException("missing object field '" + key + "'");
		}
		return e.getAsJsonObject();
	}

	public static String[] strings(JsonObject o, String key) {
		JsonElement e = o.get(key);
		if (e == null || !e.isJsonArray()) {
			throw new ProtocolException("missing array field '" + key + "'");
		}
		JsonArray a = e.getAsJsonArray();
		String[] out = new String[a.size()];
		for (int i = 0; i < out.length; i++) {
			out[i] = a.get(i).getAsString();
		}
		return out;
	}

	public static int[] vec3(JsonObject o, String key) {
		JsonElement e = o.get(key);
		if (e == null || !e.isJsonArray() || e.getAsJsonArray().size() != 3) {
			throw new ProtocolException("field '" + key + "' must be [x,y,z]");
		}
		JsonArray a = e.getAsJsonArray();
		return new int[] {(int) Math.floor(a.get(0).getAsDouble()), (int) Math.floor(a.get(1).getAsDouble()), (int) Math.floor(a.get(2).getAsDouble())};
	}

	public static JsonArray array(double... values) {
		JsonArray a = new JsonArray();
		for (double v : values) {
			a.add(v);
		}
		return a;
	}

	public static JsonArray array(int... values) {
		JsonArray a = new JsonArray();
		for (int v : values) {
			a.add(v);
		}
		return a;
	}

	public static JsonArray strings(Iterable<String> values) {
		JsonArray a = new JsonArray();
		for (String v : values) {
			a.add(v);
		}
		return a;
	}
}
