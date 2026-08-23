package dev.mcai.plugin;

import java.util.ArrayList;
import java.util.List;

/**
 * Just enough JSON.
 *
 * The plugin exchanges a handful of known shapes with a program on the same
 * machine that we also wrote. Pulling in a JSON library for that would add a
 * megabyte and a shading problem to a plugin whose whole appeal is being one
 * small jar. What is here is a writer that escapes correctly and readers for
 * the specific fields the plugin consumes.
 */
final class Json {

  private Json() {}

  /** A correctly escaped JSON string literal, quotes included. */
  static String string(String value) {
    if (value == null) return "null";
    StringBuilder sb = new StringBuilder(value.length() + 2);
    sb.append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"': sb.append("\\\""); break;
        case '\\': sb.append("\\\\"); break;
        case '\n': sb.append("\\n"); break;
        case '\r': sb.append("\\r"); break;
        case '\t': sb.append("\\t"); break;
        case '\b': sb.append("\\b"); break;
        case '\f': sb.append("\\f"); break;
        default:
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    return sb.append('"').toString();
  }

  /** The value of a top-level string or number field, or null. */
  static String field(String json, String name) {
    if (json == null) return null;
    int at = indexOfKey(json, name);
    if (at < 0) return null;
    int colon = json.indexOf(':', at);
    if (colon < 0) return null;
    int i = skipSpace(json, colon + 1);
    if (i >= json.length()) return null;

    if (json.charAt(i) == '"') return readString(json, i);
    if (json.startsWith("null", i)) return null;

    int end = i;
    while (end < json.length() && ",}] \n\r\t".indexOf(json.charAt(end)) < 0) end++;
    return json.substring(i, end);
  }

  /** A field inside a nested object: `nested(body, "llm", "model")`. */
  static String nested(String json, String outer, String inner) {
    if (json == null) return null;
    int at = indexOfKey(json, outer);
    if (at < 0) return null;
    int brace = json.indexOf('{', at);
    if (brace < 0) return null;
    int depth = 0, end = brace;
    boolean inString = false;
    for (; end < json.length(); end++) {
      char c = json.charAt(end);
      if (inString) {
        if (c == '\\') end++;
        else if (c == '"') inString = false;
        continue;
      }
      if (c == '"') inString = true;
      else if (c == '{') depth++;
      else if (c == '}' && --depth == 0) { end++; break; }
    }
    return field(json.substring(brace, Math.min(end, json.length())), inner);
  }

  /** A top-level array of strings. */
  static List<String> stringArray(String json, String name) {
    int start = arrayStart(json, name);
    if (start < 0) return null;
    List<String> out = new ArrayList<>();
    int i = start + 1;
    while (i < json.length()) {
      i = skipSpace(json, i);
      if (i >= json.length() || json.charAt(i) == ']') break;
      if (json.charAt(i) == '"') {
        String value = readString(json, i);
        out.add(value);
        i = skipString(json, i);
      } else i++;
      i = skipSpace(json, i);
      if (i < json.length() && json.charAt(i) == ',') i++;
    }
    return out;
  }

  /** A top-level array of integers. */
  static int[] intArray(String json, String name) {
    int start = arrayStart(json, name);
    if (start < 0) return null;
    int end = json.indexOf(']', start);
    if (end < 0) return null;
    String inner = json.substring(start + 1, end).trim();
    if (inner.isEmpty()) return new int[0];
    String[] parts = inner.split(",");
    int[] out = new int[parts.length];
    for (int i = 0; i < parts.length; i++) {
      try { out[i] = (int) Double.parseDouble(parts[i].trim()); }
      catch (NumberFormatException e) { return null; }
    }
    return out;
  }

  // ── Scanning ────────────────────────────────────────────────────────────

  private static int arrayStart(String json, String name) {
    if (json == null) return -1;
    int at = indexOfKey(json, name);
    if (at < 0) return -1;
    int bracket = json.indexOf('[', at);
    return bracket < 0 ? -1 : bracket;
  }

  /** Find `"name"` used as a key, not as a value that happens to match. */
  private static int indexOfKey(String json, String name) {
    String needle = '"' + name + '"';
    int from = 0;
    while (true) {
      int at = json.indexOf(needle, from);
      if (at < 0) return -1;
      int after = skipSpace(json, at + needle.length());
      if (after < json.length() && json.charAt(after) == ':') return at;
      from = at + needle.length();
    }
  }

  private static int skipSpace(String s, int i) {
    while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    return i;
  }

  private static String readString(String s, int quote) {
    StringBuilder sb = new StringBuilder();
    for (int i = quote + 1; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '\\' && i + 1 < s.length()) {
        char next = s.charAt(++i);
        switch (next) {
          case 'n': sb.append('\n'); break;
          case 'r': sb.append('\r'); break;
          case 't': sb.append('\t'); break;
          case 'b': sb.append('\b'); break;
          case 'f': sb.append('\f'); break;
          case 'u':
            if (i + 4 < s.length()) {
              sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
              i += 4;
            }
            break;
          default: sb.append(next);
        }
      } else if (c == '"') break;
      else sb.append(c);
    }
    return sb.toString();
  }

  private static int skipString(String s, int quote) {
    for (int i = quote + 1; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '\\') i++;
      else if (c == '"') return i + 1;
    }
    return s.length();
  }
}
