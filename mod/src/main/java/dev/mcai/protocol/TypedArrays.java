package dev.mcai.protocol;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Base64;

/** Base64 of little-endian typed arrays, as used on the wire (ARCHITECTURE §5). */
public final class TypedArrays {
	private TypedArrays() {
	}

	private static ByteBuffer decode(String b64, int width, String what) {
		if (b64 == null || b64.isEmpty()) {
			return ByteBuffer.allocate(0).order(ByteOrder.LITTLE_ENDIAN);
		}
		byte[] bytes;
		try {
			bytes = Base64.getDecoder().decode(b64);
		} catch (IllegalArgumentException e) {
			throw new ProtocolException(what + ": invalid base64");
		}
		if (bytes.length % width != 0) {
			throw new ProtocolException(what + ": byte length " + bytes.length + " is not a multiple of " + width);
		}
		return ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
	}

	public static int[] decodeInt32(String b64, String what) {
		ByteBuffer buf = decode(b64, 4, what);
		int[] out = new int[buf.remaining() / 4];
		buf.asIntBuffer().get(out);
		return out;
	}

	/** Uint16 values as Java chars (0..65535). */
	public static char[] decodeUint16(String b64, String what) {
		ByteBuffer buf = decode(b64, 2, what);
		char[] out = new char[buf.remaining() / 2];
		buf.asCharBuffer().get(out);
		return out;
	}

	public static String encodeUint16(char[] values) {
		ByteBuffer buf = ByteBuffer.allocate(values.length * 2).order(ByteOrder.LITTLE_ENDIAN);
		buf.asCharBuffer().put(values);
		return Base64.getEncoder().encodeToString(buf.array());
	}

	public static String encodeInt16(short[] values) {
		ByteBuffer buf = ByteBuffer.allocate(values.length * 2).order(ByteOrder.LITTLE_ENDIAN);
		buf.asShortBuffer().put(values);
		return Base64.getEncoder().encodeToString(buf.array());
	}

	public static String encodeInt32(int[] values) {
		ByteBuffer buf = ByteBuffer.allocate(values.length * 4).order(ByteOrder.LITTLE_ENDIAN);
		buf.asIntBuffer().put(values);
		return Base64.getEncoder().encodeToString(buf.array());
	}
}
