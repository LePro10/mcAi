package dev.mcai.plugin;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Unpacks the engine that ships inside the jar.
 *
 * This is what makes the install one file. The engine is the Node program that
 * holds the blueprint compiler; in plugin mode it imports nothing outside the
 * standard library, so it is a few hundred kilobytes of JavaScript and can
 * simply ride along as jar resources under `engine/`.
 *
 * The alternative — asking the person to download a second thing, put it in
 * the right folder and keep the two versions in step — is exactly the setup
 * friction mcAI is supposed to remove. Downloading it at runtime would be
 * worse still: a plugin that fetches and executes code is not something a
 * server owner should have to trust.
 *
 * Extraction is version-stamped, so upgrading the jar replaces the engine and
 * a normal restart does nothing.
 */
final class EngineInstaller {

  /** Jar resources under this prefix are the engine. */
  private static final String PREFIX = "engine/";

  private EngineInstaller() {}

  /**
   * Make sure `target` holds the engine this jar shipped with.
   *
   * @return the directory the engine now lives in, or null if the jar has no
   *     engine embedded (a development build) and nothing is installed.
   */
  static File install(McAiPlugin plugin, File target) {
    File stamp = new File(target, ".version");
    String want = Version.PLUGIN;

    if (isInstalled(target) && want.equals(read(stamp))) return target;

    File source = jarFile(plugin);
    if (source == null) {
      plugin.getLogger().warning("Could not locate the plugin jar; skipping engine extraction.");
      return isInstalled(target) ? target : null;
    }

    int written = 0;
    try (ZipFile zip = new ZipFile(source)) {
      // A stale engine from an older version would otherwise leave behind
      // files that no longer belong, which is how a half-upgraded install
      // fails in a way nobody can diagnose.
      if (target.exists()) deleteTree(target.toPath());

      Enumeration<? extends ZipEntry> entries = zip.entries();
      while (entries.hasMoreElements()) {
        ZipEntry entry = entries.nextElement();
        if (entry.isDirectory() || !entry.getName().startsWith(PREFIX)) continue;

        String relative = entry.getName().substring(PREFIX.length());
        if (relative.isEmpty()) continue;

        Path out = target.toPath().resolve(relative).normalize();
        // Zip entries are attacker-controlled in the general case. Ours are
        // not, but a path check costs one line and this writes to disk.
        if (!out.startsWith(target.toPath().normalize())) continue;

        Files.createDirectories(out.getParent());
        try (InputStream in = zip.getInputStream(entry)) {
          Files.copy(in, out, StandardCopyOption.REPLACE_EXISTING);
        }
        written++;
      }
    } catch (IOException | UncheckedIOException e) {
      plugin.getLogger().warning("Could not unpack the engine: " + e.getMessage());
      return isInstalled(target) ? target : null;
    }

    if (written == 0) {
      // A jar built without the engine step. The plugin still works if one is
      // installed by hand, which is how the engine is developed.
      return isInstalled(target) ? target : null;
    }

    write(stamp, want);
    plugin.getLogger().info("Unpacked the mcAI engine (" + written + " files, v" + want + ").");
    return target;
  }

  private static boolean isInstalled(File dir) {
    return new File(dir, "dist/cli/main.js").isFile();
  }

  private static File jarFile(McAiPlugin plugin) {
    try {
      File file = new File(McAiPlugin.class.getProtectionDomain()
          .getCodeSource().getLocation().toURI());
      return file.isFile() ? file : null;
    } catch (URISyntaxException | NullPointerException | SecurityException e) {
      return null;
    }
  }

  private static void deleteTree(Path root) throws IOException {
    if (!Files.exists(root)) return;
    try (var walk = Files.walk(root)) {
      walk.sorted((a, b) -> b.getNameCount() - a.getNameCount())
          .forEach(p -> {
            try { Files.deleteIfExists(p); } catch (IOException e) { throw new UncheckedIOException(e); }
          });
    }
  }

  private static String read(File file) {
    try { return Files.readString(file.toPath(), StandardCharsets.UTF_8).trim(); }
    catch (IOException e) { return null; }
  }

  private static void write(File file, String value) {
    try { Files.writeString(file.toPath(), value, StandardCharsets.UTF_8); }
    catch (IOException ignored) { /* the engine still runs; it just re-extracts next time */ }
  }
}
