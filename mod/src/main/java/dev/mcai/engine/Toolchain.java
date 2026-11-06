package dev.mcai.engine;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Finds {@code node} and {@code claude}. A game started from a launcher (macOS Dock, Windows
 * Start menu) often has a minimal PATH, so common install locations are searched too.
 */
public final class Toolchain {
	public static final int[] MIN_NODE = {22, 18, 0};
	private static final boolean WINDOWS = System.getProperty("os.name", "").toLowerCase().contains("win");

	private Toolchain() {
	}

	/** PATH plus well-known install directories (Homebrew, nvm, volta, fnm, npm-global, ~/.local/bin …). */
	public static List<Path> searchPath() {
		Set<Path> dirs = new LinkedHashSet<>();
		String path = System.getenv("PATH");
		if (path != null) {
			for (String p : path.split(File.pathSeparator)) {
				if (!p.isBlank()) {
					dirs.add(Path.of(p));
				}
			}
		}
		Path home = Path.of(System.getProperty("user.home"));
		for (String p : new String[] {"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"}) {
			dirs.add(Path.of(p));
		}
		for (String p : new String[] {".local/bin", ".volta/bin", ".npm-global/bin", "n/bin", ".bun/bin", ".claude/local", "AppData/Roaming/npm"}) {
			dirs.add(home.resolve(p));
		}
		if (WINDOWS) {
			dirs.add(Path.of(System.getenv().getOrDefault("ProgramFiles", "C:\\Program Files"), "nodejs"));
		}
		dirs.addAll(newestFirst(home.resolve(".nvm/versions/node"), "bin"));
		dirs.addAll(newestFirst(home.resolve("Library/Application Support/fnm/node-versions"), "installation/bin"));
		dirs.addAll(newestFirst(home.resolve(".local/share/fnm/node-versions"), "installation/bin"));
		return new ArrayList<>(dirs);
	}

	private static List<Path> newestFirst(Path root, String sub) {
		if (!Files.isDirectory(root)) {
			return List.of();
		}
		try (Stream<Path> s = Files.list(root)) {
			return s.sorted(Comparator.comparing((Path p) -> versionOf(p.getFileName().toString()), Toolchain::compare).reversed())
					.map(p -> p.resolve(sub)).toList();
		} catch (Exception e) {
			return List.of();
		}
	}

	public static Optional<Path> find(String exe) {
		for (Path dir : searchPath()) {
			for (String name : WINDOWS ? new String[] {exe + ".exe", exe + ".cmd", exe} : new String[] {exe}) {
				Path p = dir.resolve(name);
				if (Files.isRegularFile(p) && Files.isExecutable(p)) {
					return Optional.of(p);
				}
			}
		}
		return Optional.empty();
	}

	/** {@code node --version}, e.g. "v22.18.0"; null if it cannot be run. */
	public static String version(Path exe) {
		try {
			Process p = new ProcessBuilder(exe.toString(), "--version").redirectErrorStream(true).start();
			String out;
			try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
				out = r.readLine();
			}
			return p.waitFor(5, TimeUnit.SECONDS) && p.exitValue() == 0 && out != null ? out.trim() : null;
		} catch (Exception e) {
			return null;
		}
	}

	public static int[] versionOf(String s) {
		Matcher m = Pattern.compile("(\\d+)\\.(\\d+)(?:\\.(\\d+))?").matcher(s == null ? "" : s);
		if (!m.find()) {
			return new int[] {0, 0, 0};
		}
		return new int[] {Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), m.group(3) == null ? 0 : Integer.parseInt(m.group(3))};
	}

	public static int compare(int[] a, int[] b) {
		for (int i = 0; i < 3; i++) {
			if (a[i] != b[i]) {
				return Integer.compare(a[i], b[i]);
			}
		}
		return 0;
	}

	/** PATH for the engine process: the tool directories first, then the inherited PATH. */
	public static String childPath(List<Path> toolDirs) {
		Set<String> parts = new LinkedHashSet<>();
		toolDirs.forEach(d -> parts.add(d.toString()));
		searchPath().forEach(d -> parts.add(d.toString()));
		return String.join(File.pathSeparator, parts);
	}
}
