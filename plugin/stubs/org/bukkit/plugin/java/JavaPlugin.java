package org.bukkit.plugin.java;
import java.io.File;
import java.util.logging.Logger;
import org.bukkit.Server;
import org.bukkit.command.PluginCommand;
import org.bukkit.configuration.file.FileConfiguration;
public abstract class JavaPlugin {
  public void onEnable() {}
  public void onDisable() {}
  public Logger getLogger() { return null; }
  public File getDataFolder() { return null; }
  public FileConfiguration getConfig() { return null; }
  public void saveConfig() {}
  public void saveDefaultConfig() {}
  public void reloadConfig() {}
  public Server getServer() { return null; }
  public PluginCommand getCommand(String name) { return null; }
  public java.io.InputStream getResource(String filename) { return null; }
  public void saveResource(String path, boolean replace) {}
}
