package org.bukkit.configuration.file;
public abstract class FileConfiguration {
  public String getString(String path) { return null; }
  public String getString(String path, String def) { return def; }
  public int getInt(String path, int def) { return def; }
  public boolean getBoolean(String path, boolean def) { return def; }
  public void set(String path, Object value) {}
}
