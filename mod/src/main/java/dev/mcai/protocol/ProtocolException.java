package dev.mcai.protocol;

/** A malformed or invalid request; reported to the engine as {@code ok:false, error}. */
public class ProtocolException extends RuntimeException {
	public ProtocolException(String message) {
		super(message);
	}
}
