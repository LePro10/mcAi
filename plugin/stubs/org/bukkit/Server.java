package org.bukkit;
import org.bukkit.command.CommandSender;
public interface Server {
  boolean dispatchCommand(CommandSender sender, String commandLine);
  String getVersion();
}
