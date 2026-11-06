package dev.mcai.gametest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.function.Predicate;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;

/** HTTP client for tools/fake-engine.mjs's control API. */
final class FakeEngineControl {
	private final String base;
	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

	FakeEngineControl(int port) {
		this.base = "http://127.0.0.1:" + port;
	}

	JsonObject state() {
		return call("GET", "/state", null);
	}

	/** Engine → mod request; ticks the game while waiting (the mod answers on the server thread). */
	JsonObject send(ClientGameTestContext ctx, JsonObject msg) {
		java.util.concurrent.CompletableFuture<JsonObject> f = java.util.concurrent.CompletableFuture.supplyAsync(() -> call("POST", "/send", msg));
		long end = System.currentTimeMillis() + 30_000;
		while (!f.isDone()) {
			if (System.currentTimeMillis() > end) {
				throw new AssertionError("no answer from the mod to " + msg);
			}
			ctx.waitTick();
		}
		return f.join();
	}

	void post(String path) {
		call("POST", path, new JsonObject());
	}

	/**
	 * Poll the state until the predicate holds (or fail after timeoutMs). Waits with game ticks:
	 * a client game test freezes the game while the test thread sleeps.
	 */
	JsonObject await(ClientGameTestContext ctx, String what, Predicate<JsonObject> p, long timeoutMs) {
		long end = System.currentTimeMillis() + timeoutMs;
		String last = "";
		while (System.currentTimeMillis() < end) {
			try {
				JsonObject s = state();
				if (p.test(s)) {
					return s;
				}
				last = s.toString();
			} catch (RuntimeException e) {
				last = e.getMessage();
			}
			ctx.waitTicks(5);
		}
		throw new AssertionError("timed out waiting for " + what + " (last state: " + (last.length() > 600 ? last.substring(0, 600) : last) + ")");
	}

	/** The last received mod → engine message of a type, or null. */
	static JsonObject last(JsonObject state, String type) {
		JsonArray a = state.getAsJsonArray("received");
		for (int i = a.size() - 1; i >= 0; i--) {
			JsonElement e = a.get(i);
			if (e.isJsonObject() && type.equals(e.getAsJsonObject().get("type").getAsString())) {
				return e.getAsJsonObject();
			}
		}
		return null;
	}

	static long count(JsonObject state, String type) {
		long n = 0;
		for (JsonElement e : state.getAsJsonArray("received")) {
			if (e.isJsonObject() && type.equals(e.getAsJsonObject().get("type").getAsString())) {
				n++;
			}
		}
		return n;
	}

	private JsonObject call(String method, String path, JsonObject body) {
		try {
			HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofSeconds(30));
			b = body == null ? b.GET() : b.POST(HttpRequest.BodyPublishers.ofString(body.toString())).header("content-type", "application/json");
			HttpResponse<String> r = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
			JsonObject o = JsonParser.parseString(r.body()).getAsJsonObject();
			if (r.statusCode() != 200) {
				throw new IllegalStateException(path + ": " + o);
			}
			return o;
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new IllegalStateException(e);
		} catch (java.io.IOException e) {
			throw new IllegalStateException("fake engine control " + path + ": " + e);
		}
	}
}
