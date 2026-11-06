package dev.mcai.bridge;

import com.google.gson.JsonObject;
import java.util.concurrent.CompletableFuture;

/** Handles one engine → mod request type; the payload becomes the response body. */
@FunctionalInterface
public interface RequestHandler {
	CompletableFuture<JsonObject> handle(JsonObject request);
}
