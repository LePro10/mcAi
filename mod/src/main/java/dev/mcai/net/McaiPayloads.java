package dev.mcai.net;

import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.minecraft.core.BlockPos;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

/**
 * Mod-only client ↔ server payloads (players with the mod installed). Vanilla clients keep
 * working through commands, chat, boss bar and particles.
 */
public final class McaiPayloads {
	private static final int MAX_PROMPT = 2000;
	private static final int MAX_TEXT = 1000;

	/** Max problem args in a Status (the decoder reads at most this many). */
	private static final int MAX_ARGS = 8;

	private McaiPayloads() {
	}

	/**
	 * Encoders never throw on over-long or null strings: a clientbound custom payload that fails
	 * to encode is not skippable and would disconnect the player.
	 */
	static String clip(String s, int max) {
		if (s == null) {
			return "";
		}
		if (s.length() <= max) {
			return s;
		}
		int end = Character.isHighSurrogate(s.charAt(max - 1)) ? max - 1 : max;
		return s.substring(0, end);
	}

	private static <T extends CustomPacketPayload> CustomPacketPayload.Type<T> id(String path) {
		return new CustomPacketPayload.Type<>(Identifier.fromNamespaceAndPath("mcai", path));
	}

	// ------------------------------------------------------------------ client → server

	/** Prompt GUI "Build"/"Plan". size = S/M/L/XL (used when no selection is used). */
	public record BuildRequest(String prompt, String style, String size, boolean useSelection, String mode) implements CustomPacketPayload {
		public static final Type<BuildRequest> TYPE = id("build_request");
		public static final StreamCodec<RegistryFriendlyByteBuf, BuildRequest> CODEC = CustomPacketPayload.codec(
				(p, b) -> {
					b.writeUtf(clip(p.prompt, MAX_PROMPT), MAX_PROMPT);
					b.writeUtf(clip(p.style, 64), 64);
					b.writeUtf(clip(p.size, 8), 8);
					b.writeBoolean(p.useSelection);
					b.writeUtf(clip(p.mode, 16), 16);
				},
				b -> new BuildRequest(b.readUtf(MAX_PROMPT), b.readUtf(64), b.readUtf(8), b.readBoolean(), b.readUtf(16)));

		@Override
		public Type<BuildRequest> type() {
			return TYPE;
		}
	}

	/** cancel / undo / redo / confirm / reject / reply (arg = text) / status (request a Status). */
	public record JobAction(String action, String arg) implements CustomPacketPayload {
		public static final Type<JobAction> TYPE = id("job_action");
		public static final StreamCodec<RegistryFriendlyByteBuf, JobAction> CODEC = CustomPacketPayload.codec(
				(p, b) -> {
					b.writeUtf(clip(p.action, 32), 32);
					b.writeUtf(clip(p.arg, MAX_TEXT), MAX_TEXT);
				},
				b -> new JobAction(b.readUtf(32), b.readUtf(MAX_TEXT)));

		@Override
		public Type<JobAction> type() {
			return TYPE;
		}
	}

	// ------------------------------------------------------------------ server → client

	/**
	 * Engine/permission status for the prompt GUI. problemKey/problemArgs = translatable hint
	 * (empty if none). activeJob = the player's running job id ("" if none).
	 */
	public record Status(boolean engineConnected, boolean permitted, String problemKey, List<String> problemArgs,
			String viewerUrl, String activeJob, String activeState, int cooldownSeconds) implements CustomPacketPayload {
		public static final Type<Status> TYPE = id("status");
		public static final StreamCodec<RegistryFriendlyByteBuf, Status> CODEC = CustomPacketPayload.codec(
				(p, b) -> {
					b.writeBoolean(p.engineConnected);
					b.writeBoolean(p.permitted);
					b.writeUtf(clip(p.problemKey, 128), 128);
					List<String> args = p.problemArgs == null ? List.of() : p.problemArgs.subList(0, Math.min(MAX_ARGS, p.problemArgs.size()));
					b.writeVarInt(args.size());
					args.forEach(a -> b.writeUtf(clip(a, MAX_TEXT), MAX_TEXT));
					b.writeUtf(clip(p.viewerUrl, 256), 256);
					b.writeUtf(clip(p.activeJob, 128), 128);
					b.writeUtf(clip(p.activeState, 32), 32);
					b.writeVarInt(p.cooldownSeconds);
				},
				b -> {
					boolean c = b.readBoolean();
					boolean perm = b.readBoolean();
					String key = b.readUtf(128);
					int n = b.readVarInt();
					if (n < 0 || n > MAX_ARGS) {
						throw new io.netty.handler.codec.DecoderException("mcai status: " + n + " problem args");
					}
					List<String> args = new ArrayList<>(n);
					for (int i = 0; i < n; i++) {
						args.add(b.readUtf(MAX_TEXT));
					}
					return new Status(c, perm, key, args, b.readUtf(256), b.readUtf(128), b.readUtf(32), b.readVarInt());
				});

		@Override
		public Type<Status> type() {
			return TYPE;
		}
	}

	/** job_update forwarded to the requesting player's HUD. */
	public record JobUpdate(String jobId, String state, float progress, String stage, String detail, double costUsd, String prompt)
			implements CustomPacketPayload {
		public static final Type<JobUpdate> TYPE = id("job_update");
		public static final StreamCodec<RegistryFriendlyByteBuf, JobUpdate> CODEC = CustomPacketPayload.codec(
				(p, b) -> {
					b.writeUtf(clip(p.jobId, 128), 128);
					b.writeUtf(clip(p.state, 32), 32);
					b.writeFloat(p.progress);
					b.writeUtf(clip(p.stage, MAX_TEXT), MAX_TEXT);
					b.writeUtf(clip(p.detail, MAX_TEXT), MAX_TEXT);
					b.writeDouble(p.costUsd);
					b.writeUtf(clip(p.prompt, MAX_PROMPT), MAX_PROMPT);
				},
				b -> new JobUpdate(b.readUtf(128), b.readUtf(32), b.readFloat(), b.readUtf(MAX_TEXT), b.readUtf(MAX_TEXT), b.readDouble(), b.readUtf(MAX_PROMPT)));

		@Override
		public Type<JobUpdate> type() {
			return TYPE;
		}
	}

	/** The player's wand selection (null corners are sent as absent). */
	public record SelectionSync(String dimension, BlockPos pos1, BlockPos pos2) implements CustomPacketPayload {
		public static final Type<SelectionSync> TYPE = id("selection");
		public static final StreamCodec<RegistryFriendlyByteBuf, SelectionSync> CODEC = CustomPacketPayload.codec(
				(p, b) -> {
					b.writeUtf(clip(p.dimension == null ? "" : p.dimension, 128), 128);
					b.writeBoolean(p.pos1 != null);
					if (p.pos1 != null) {
						b.writeBlockPos(p.pos1);
					}
					b.writeBoolean(p.pos2 != null);
					if (p.pos2 != null) {
						b.writeBlockPos(p.pos2);
					}
				},
				b -> {
					String dim = b.readUtf(128);
					BlockPos a = b.readBoolean() ? b.readBlockPos() : null;
					BlockPos c = b.readBoolean() ? b.readBlockPos() : null;
					return new SelectionSync(dim, a, c);
				});

		@Override
		public Type<SelectionSync> type() {
			return TYPE;
		}
	}

	/** The effective build area of a job (engine reply): selection (may be null) + allowed box. */
	public record JobArea(String jobId, String dimension, BlockPos selMin, BlockPos selMax, BlockPos allowMin, BlockPos allowMax)
			implements CustomPacketPayload {
		public static final Type<JobArea> TYPE = id("job_area");
		public static final StreamCodec<RegistryFriendlyByteBuf, JobArea> CODEC = CustomPacketPayload.codec(
				(p, b) -> {
					b.writeUtf(clip(p.jobId, 128), 128);
					b.writeUtf(clip(p.dimension, 128), 128);
					b.writeBoolean(p.selMin != null);
					if (p.selMin != null) {
						b.writeBlockPos(p.selMin);
						b.writeBlockPos(p.selMax);
					}
					b.writeBlockPos(p.allowMin);
					b.writeBlockPos(p.allowMax);
				},
				b -> {
					String job = b.readUtf(128);
					String dim = b.readUtf(128);
					BlockPos s0 = null;
					BlockPos s1 = null;
					if (b.readBoolean()) {
						s0 = b.readBlockPos();
						s1 = b.readBlockPos();
					}
					return new JobArea(job, dim, s0, s1, b.readBlockPos(), b.readBlockPos());
				});

		@Override
		public Type<JobArea> type() {
			return TYPE;
		}
	}

	public static void register() {
		PayloadTypeRegistry.serverboundPlay().register(BuildRequest.TYPE, BuildRequest.CODEC);
		PayloadTypeRegistry.serverboundPlay().register(JobAction.TYPE, JobAction.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(Status.TYPE, Status.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(JobUpdate.TYPE, JobUpdate.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(SelectionSync.TYPE, SelectionSync.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(JobArea.TYPE, JobArea.CODEC);
	}
}
