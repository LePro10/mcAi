package dev.mcai.plugin;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** Minimal HTTP client for talking to the engine. Never call from the main thread. */
final class Http {

  private Http() {}

  static final class Response {
    final int status;
    final String body;
    Response(int status, String body) { this.status = status; this.body = body; }
  }

  private static final HttpClient CLIENT = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(5))
      .build();

  static Response get(String url, String token, int timeoutMs) {
    return send(HttpRequest.newBuilder(URI.create(url)).GET(), token, timeoutMs);
  }

  static Response postJson(String url, String body, String token, int timeoutMs) {
    return send(HttpRequest.newBuilder(URI.create(url))
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .header("Content-Type", "application/json"), token, timeoutMs);
  }

  private static Response send(HttpRequest.Builder builder, String token, int timeoutMs) {
    try {
      HttpRequest request = builder
          .header("x-mcai-token", token)
          .timeout(Duration.ofMillis(timeoutMs))
          .build();
      HttpResponse<String> res = CLIENT.send(request, HttpResponse.BodyHandlers.ofString());
      return new Response(res.statusCode(), res.body());
    } catch (Exception e) {
      // Status 0 means "never reached it", which callers report differently
      // from a server that answered with an error.
      return new Response(0, e.getMessage() == null ? "" : e.getMessage());
    }
  }
}
