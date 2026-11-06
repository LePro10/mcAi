package dev.mcai.bridge;

import dev.mcai.McaiMod;
import dev.mcai.config.EngineEndpoint;
import dev.mcai.config.McaiConfig;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * WebSocket client to the engine ({@code ws://host:port/mod}). Reassembles fragmented text
 * messages, serializes outgoing sends (java.net.http allows one outstanding send), and
 * reconnects with exponential backoff. All callbacks run on the bridge's IO thread.
 */
public final class EngineClient {
	/** Connection events delivered to the bridge. */
	public interface Listener {
		void onConnected(EngineEndpoint endpoint);

		void onMessage(String text);

		void onDisconnected(String reason);
	}

	private static final long MIN_BACKOFF_MS = 1_000;
	private static final long MAX_BACKOFF_MS = 30_000;
	private static final long NO_ENGINE_POLL_MS = 2_000;
	private static final long FILE_CHECK_MS = 1_000;

	private final McaiConfig config;
	private final Listener listener;
	private final ScheduledExecutorService io;
	private final HttpClient http;

	private volatile boolean running;
	private volatile WebSocket socket;
	private CompletableFuture<?> sendChain = CompletableFuture.completedFuture(null);
	private int attempt;
	private String lastProblem = "";
	private volatile EngineEndpoint endpoint;
	private long engineJsonStamp;

	public EngineClient(McaiConfig config, ScheduledExecutorService io, Listener listener) {
		this.config = config;
		this.io = io;
		this.listener = listener;
		this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
	}

	public boolean isConnected() {
		return socket != null;
	}

	/** Endpoint of the current (or last) connection, or null. */
	public EngineEndpoint endpoint() {
		return endpoint;
	}

	private static long engineJsonStamp() {
		try {
			java.nio.file.Path f = EngineEndpoint.mcaiHome().resolve("engine.json");
			return java.nio.file.Files.isRegularFile(f) ? java.nio.file.Files.getLastModifiedTime(f).toMillis() : 0;
		} catch (java.io.IOException e) {
			return 0;
		}
	}

	public void start() {
		running = true;
		io.execute(this::connect);
	}

	public void stop() {
		running = false;
		WebSocket ws = socket;
		socket = null;
		if (ws != null) {
			try {
				ws.sendClose(WebSocket.NORMAL_CLOSURE, "server stopping").orTimeout(2, TimeUnit.SECONDS).join();
			} catch (RuntimeException ignored) {
				ws.abort();
			}
		}
	}

	/** Queue a text message. Silently dropped if not connected (the engine re-syncs on reconnect). */
	public synchronized CompletableFuture<?> send(String text) {
		sendChain = sendChain.handle((r, e) -> null).thenCompose(v -> {
			WebSocket ws = socket;
			if (ws == null) {
				return CompletableFuture.completedFuture(null);
			}
			return ws.sendText(text, true).exceptionally(err -> {
				McaiMod.LOG.debug("mcai: send failed: {}", err.toString());
				return null;
			});
		});
		return sendChain;
	}

	private void connect() {
		if (!running) {
			return;
		}
		engineJsonStamp = engineJsonStamp();
		EngineEndpoint ep = EngineEndpoint.discover(config);
		if (ep == null) {
			problem("waiting for the mcAI engine (no " + EngineEndpoint.mcaiHome().resolve("engine.json") + ")");
			io.schedule(this::connect, NO_ENGINE_POLL_MS, TimeUnit.MILLISECONDS);
			return;
		}
		WebSocket.Builder builder = http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(5));
		if (!ep.token().isEmpty()) {
			builder.header("Authorization", "Bearer " + ep.token());
		}
		builder.buildAsync(ep.uri(), new SocketListener(ep)).whenCompleteAsync((ws, err) -> {
			if (err != null) {
				problem("engine at " + ep.uri() + " not reachable (" + rootMessage(err) + ")");
				scheduleReconnect();
			}
		}, io);
	}

	private void scheduleReconnect() {
		if (!running) {
			return;
		}
		long delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS << Math.min(attempt, 5));
		delay += ThreadLocalRandom.current().nextLong(delay / 4 + 1);
		attempt++;
		waitThenConnect(System.currentTimeMillis() + delay);
	}

	/** Wait until the deadline, but connect at once when engine.json changes (engine (re)started). */
	private void waitThenConnect(long deadline) {
		if (!running) {
			return;
		}
		if (System.currentTimeMillis() >= deadline) {
			connect();
		} else if (engineJsonStamp() != engineJsonStamp) {
			attempt = 0;
			connect();
		} else {
			io.schedule(() -> waitThenConnect(deadline), Math.min(FILE_CHECK_MS, Math.max(1, deadline - System.currentTimeMillis())), TimeUnit.MILLISECONDS);
		}
	}

	/** Log connection problems once per distinct message (no log spam while the engine is down). */
	private void problem(String msg) {
		if (!msg.equals(lastProblem)) {
			lastProblem = msg;
			McaiMod.LOG.info("mcai: {}", msg);
		}
	}

	private static String rootMessage(Throwable t) {
		while (t.getCause() != null) {
			t = t.getCause();
		}
		return t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
	}

	private void dropped(WebSocket ws, String reason) {
		io.execute(() -> {
			if (socket != ws) {
				return;
			}
			socket = null;
			McaiMod.LOG.info("mcai: engine connection lost ({})", reason);
			listener.onDisconnected(reason);
			scheduleReconnect();
		});
	}

	private final class SocketListener implements WebSocket.Listener {
		private final EngineEndpoint endpoint;
		private final StringBuilder text = new StringBuilder();

		SocketListener(EngineEndpoint endpoint) {
			this.endpoint = endpoint;
		}

		@Override
		public void onOpen(WebSocket ws) {
			io.execute(() -> {
				if (!running) {
					ws.abort();
					return;
				}
				socket = ws;
				EngineClient.this.endpoint = endpoint;
				attempt = 0;
				lastProblem = "";
				McaiMod.LOG.info("mcai: connected to engine {} ({})", endpoint.uri(), endpoint.source());
				listener.onConnected(endpoint);
			});
			ws.request(1);
		}

		@Override
		public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
			// java.net.http delivers large messages as several partial frames: reassemble.
			text.append(data);
			if (last) {
				String message = text.toString();
				text.setLength(0);
				if (text.capacity() > (1 << 20)) {
					text.trimToSize();
				}
				Consumer<String> deliver = listener::onMessage;
				io.execute(() -> {
					if (socket == ws) {
						deliver.accept(message);
					}
				});
			}
			ws.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onBinary(WebSocket ws, ByteBuffer data, boolean last) {
			ws.request(1); // binary frames are not part of the protocol
			return null;
		}

		@Override
		public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
			dropped(ws, "closed " + statusCode + (reason.isEmpty() ? "" : " " + reason));
			return null;
		}

		@Override
		public void onError(WebSocket ws, Throwable error) {
			dropped(ws, rootMessage(error));
		}
	}
}
