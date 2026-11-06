// UI strings (English / German). Language: localStorage → navigator.language → en.
const STRINGS = {
  en: {
    'app.tagline': 'AI Architect',
    'status.sim': 'Simulation',
    'status.mc': 'Minecraft',
    'status.waiting': 'Waiting for Minecraft',
    'status.offline': 'Offline',
    'status.engine': 'Engine',
    'banner.lost': 'Connection to the engine lost — reconnecting…',
    'banner.retry': 'Reconnecting in {s}s (attempt {n})',
    'banner.back': 'Reconnected',
    'wand.title': "Architect's Wand",
    'wand.sub': 'Describe what the AI should build',
    'wand.placeholder': 'A cozy medieval tavern with a stone base, timber frame upper floor, a lantern-lit porch and a small herb garden…',
    'wand.style': 'Style',
    'wand.size': 'Size',
    'wand.anchor': 'Site',
    'wand.pick': 'Pick on terrain',
    'wand.picking': 'Click the ground…',
    'wand.viewCenter': 'View center',
    'wand.facing': 'Facing',
    'wand.build': 'Build',
    'wand.plan': 'Plan only',
    'wand.hint': '⌘/Ctrl + Enter to build',
    'style.auto': 'Auto', 'style.medieval': 'Medieval', 'style.fantasy': 'Fantasy', 'style.japanese': 'Japanese',
    'style.modern': 'Modern', 'style.steampunk': 'Steampunk', 'style.nordic': 'Nordic', 'style.desert': 'Desert',
    'style.rustic': 'Rustic', 'style.gothic': 'Gothic', 'style.elven': 'Elven', 'style.futuristic': 'Futuristic',
    'size.S': 'Small', 'size.M': 'Medium', 'size.L': 'Large', 'size.XL': 'Huge',
    'facing.north': 'North', 'facing.east': 'East', 'facing.south': 'South', 'facing.west': 'West',
    'history.title': 'Builds',
    'history.empty': 'No builds yet. Describe one above — the AI builds it live in this world.',
    'job.none': 'No build selected',
    'job.noneSub': 'Start a build with the wand, or pick one from the history.',
    'job.thoughts': 'Agent thoughts',
    'job.chat': 'Chat',
    'job.cost': 'Cost',
    'job.time': 'Time',
    'job.blocks': 'Blocks',
    'job.tools': 'Tools',
    'job.cancel': 'Cancel',
    'job.undo': 'Undo',
    'job.redo': 'Redo',
    'job.flyTo': 'Fly to',
    'job.summary': 'Summary',
    'job.highlights': 'Highlights',
    'job.suggestions': 'Suggestions to improve the system',
    'job.error': 'Error',
    'job.emptyFeed': 'Waiting for the architect…',
    'job.chatEmpty': 'Messages to players appear here.',
    'job.question': 'The architect asks',
    'job.answer': 'Answer',
    'job.yourAnswer': 'Your answer…',
    'job.send': 'Send',
    'job.later': 'Later',
    'state.queued': 'Queued', 'state.thinking': 'Thinking', 'state.building': 'Building', 'state.reviewing': 'Reviewing',
    'state.done': 'Done', 'state.failed': 'Failed', 'state.cancelled': 'Cancelled',
    'tool.day': 'Day', 'tool.sunset': 'Sunset', 'tool.night': 'Night',
    'tool.layers': 'Layers (L)', 'tool.follow': 'Follow build (F)', 'tool.fly': 'Fly mode (G)', 'tool.shot': 'Screenshot (P)',
    'tool.full': 'Fullscreen', 'tool.ui': 'Hide UI (H)', 'tool.help': 'Shortcuts (?)', 'tool.lang': 'Deutsch', 'tool.reload': 'Reload area',
    'tool.shadows': 'Shadows',
    'load.world': 'Loading world…',
    'load.mesh': 'Meshing {done}/{total} sections',
    'load.textures': 'Loading textures…',
    'toast.started': 'Build started',
    'toast.done': 'Done: {blocks} blocks in {time}',
    'toast.failed': 'Build failed: {error}',
    'toast.cancelled': 'Build cancelled',
    'toast.shot': 'Screenshot saved',
    'toast.anchor': 'Site set at {pos}',
    'toast.noHit': 'Nothing there — click on the terrain',
    'toast.noAssets': 'Minecraft textures unavailable — showing flat colors',
    'toast.flyHelp': 'Fly: WASD move · Space/Shift up/down · mouse look · Esc exit',
    'toast.noGl': 'WebGL is not available in this browser.',
    'help.title': 'Keyboard shortcuts',
    'help.b': 'Focus the wand prompt', 'help.enter': 'Build (in the prompt)', 'help.esc': 'Close / exit mode',
    'help.l': 'Toggle layer cut-away', 'help.brackets': 'Move the cut layer', 'help.f': 'Follow the build', 'help.g': 'Fly mode (WASD)',
    'help.p': 'Screenshot', 'help.h': 'Hide the interface', 'help.t': 'Cycle day / sunset / night', 'help.dbl': 'Focus a block (double-click)',
    'help.q': 'This help',
    'layer.y': 'Y {y}',
    'misc.ago': '{t} ago',
    'misc.now': 'just now',
    'misc.you': 'Viewer',
    'pick.hint': 'Click the ground to place the build site · R rotates · Esc cancels',
  },
  de: {
    'app.tagline': 'KI-Architekt',
    'status.sim': 'Simulation',
    'status.mc': 'Minecraft',
    'status.waiting': 'Warte auf Minecraft',
    'status.offline': 'Offline',
    'status.engine': 'Engine',
    'banner.lost': 'Verbindung zur Engine verloren — verbinde neu…',
    'banner.retry': 'Neuer Versuch in {s}s (Versuch {n})',
    'banner.back': 'Wieder verbunden',
    'wand.title': 'Architektenstab',
    'wand.sub': 'Beschreibe, was die KI bauen soll',
    'wand.placeholder': 'Eine gemütliche mittelalterliche Taverne mit Steinsockel, Fachwerk-Obergeschoss, laternenbeleuchteter Veranda und kleinem Kräutergarten…',
    'wand.style': 'Stil',
    'wand.size': 'Größe',
    'wand.anchor': 'Bauplatz',
    'wand.pick': 'Im Gelände wählen',
    'wand.picking': 'Klicke auf den Boden…',
    'wand.viewCenter': 'Bildmitte',
    'wand.facing': 'Blickrichtung',
    'wand.build': 'Bauen',
    'wand.plan': 'Nur planen',
    'wand.hint': '⌘/Strg + Enter zum Bauen',
    'style.auto': 'Auto', 'style.medieval': 'Mittelalter', 'style.fantasy': 'Fantasy', 'style.japanese': 'Japanisch',
    'style.modern': 'Modern', 'style.steampunk': 'Steampunk', 'style.nordic': 'Nordisch', 'style.desert': 'Wüste',
    'style.rustic': 'Rustikal', 'style.gothic': 'Gotisch', 'style.elven': 'Elfisch', 'style.futuristic': 'Futuristisch',
    'size.S': 'Klein', 'size.M': 'Mittel', 'size.L': 'Groß', 'size.XL': 'Riesig',
    'facing.north': 'Norden', 'facing.east': 'Osten', 'facing.south': 'Süden', 'facing.west': 'Westen',
    'history.title': 'Bauten',
    'history.empty': 'Noch keine Bauten. Beschreibe oben einen — die KI baut ihn live in dieser Welt.',
    'job.none': 'Kein Bau ausgewählt',
    'job.noneSub': 'Starte einen Bau mit dem Stab oder wähle einen aus dem Verlauf.',
    'job.thoughts': 'Gedanken des Agenten',
    'job.chat': 'Chat',
    'job.cost': 'Kosten',
    'job.time': 'Dauer',
    'job.blocks': 'Blöcke',
    'job.tools': 'Tools',
    'job.cancel': 'Abbrechen',
    'job.undo': 'Rückgängig',
    'job.redo': 'Wiederholen',
    'job.flyTo': 'Hinfliegen',
    'job.summary': 'Zusammenfassung',
    'job.highlights': 'Highlights',
    'job.suggestions': 'Verbesserungsvorschläge für das System',
    'job.error': 'Fehler',
    'job.emptyFeed': 'Warte auf den Architekten…',
    'job.chatEmpty': 'Nachrichten an Spieler erscheinen hier.',
    'job.question': 'Der Architekt fragt',
    'job.answer': 'Antworten',
    'job.yourAnswer': 'Deine Antwort…',
    'job.send': 'Senden',
    'job.later': 'Später',
    'state.queued': 'Wartet', 'state.thinking': 'Denkt nach', 'state.building': 'Baut', 'state.reviewing': 'Prüft',
    'state.done': 'Fertig', 'state.failed': 'Fehlgeschlagen', 'state.cancelled': 'Abgebrochen',
    'tool.day': 'Tag', 'tool.sunset': 'Sonnenuntergang', 'tool.night': 'Nacht',
    'tool.layers': 'Ebenen (L)', 'tool.follow': 'Bau folgen (F)', 'tool.fly': 'Flugmodus (G)', 'tool.shot': 'Screenshot (P)',
    'tool.full': 'Vollbild', 'tool.ui': 'UI ausblenden (H)', 'tool.help': 'Tastenkürzel (?)', 'tool.lang': 'English', 'tool.reload': 'Bereich neu laden',
    'tool.shadows': 'Schatten',
    'load.world': 'Lade Welt…',
    'load.mesh': 'Erzeuge {done}/{total} Abschnitte',
    'load.textures': 'Lade Texturen…',
    'toast.started': 'Bau gestartet',
    'toast.done': 'Fertig: {blocks} Blöcke in {time}',
    'toast.failed': 'Bau fehlgeschlagen: {error}',
    'toast.cancelled': 'Bau abgebrochen',
    'toast.shot': 'Screenshot gespeichert',
    'toast.anchor': 'Bauplatz gesetzt: {pos}',
    'toast.noHit': 'Dort ist nichts — klicke auf das Gelände',
    'toast.noAssets': 'Minecraft-Texturen nicht verfügbar — zeige Flachfarben',
    'toast.flyHelp': 'Fliegen: WASD bewegen · Leertaste/Shift hoch/runter · Maus schauen · Esc beendet',
    'toast.noGl': 'WebGL ist in diesem Browser nicht verfügbar.',
    'help.title': 'Tastenkürzel',
    'help.b': 'Zum Stab-Prompt springen', 'help.enter': 'Bauen (im Prompt)', 'help.esc': 'Schließen / Modus beenden',
    'help.l': 'Ebenen-Schnitt an/aus', 'help.brackets': 'Schnittebene verschieben', 'help.f': 'Dem Bau folgen', 'help.g': 'Flugmodus (WASD)',
    'help.p': 'Screenshot', 'help.h': 'Oberfläche ausblenden', 'help.t': 'Tag / Abend / Nacht', 'help.dbl': 'Block fokussieren (Doppelklick)',
    'help.q': 'Diese Hilfe',
    'layer.y': 'Y {y}',
    'misc.ago': 'vor {t}',
    'misc.now': 'gerade eben',
    'misc.you': 'Viewer',
    'pick.hint': 'Klicke auf den Boden, um den Bauplatz zu setzen · R dreht · Esc bricht ab',
  },
};

let lang = 'en';
const listeners = new Set();

export function initLang() {
  let l = null;
  try {
    l = localStorage.getItem('mcai.lang');
  } catch {}
  if (!l && typeof navigator !== 'undefined') l = (navigator.language || 'en').slice(0, 2).toLowerCase();
  lang = l === 'de' ? 'de' : 'en';
  return lang;
}

export const getLang = () => lang;

export function setLang(l) {
  lang = l === 'de' ? 'de' : 'en';
  try {
    localStorage.setItem('mcai.lang', lang);
  } catch {}
  for (const cb of listeners) cb(lang);
}

export const onLang = (cb) => listeners.add(cb);

export function t(key, vars) {
  let s = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** apply data-i18n / data-i18n-title / data-i18n-placeholder attributes */
export function applyI18n(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  document.documentElement.lang = lang;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtAgo(ts) {
  const d = Date.now() - ts;
  if (d < 45_000) return t('misc.now');
  const m = Math.round(d / 60_000);
  let v;
  if (m < 60) v = `${m} min`;
  else if (m < 60 * 36) v = `${Math.round(m / 60)} h`;
  else v = lang === 'de' ? `${Math.round(m / 1440)} T.` : `${Math.round(m / 1440)} d`;
  return t('misc.ago', { t: v });
}

export function fmtNumber(n) {
  return new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-US').format(n ?? 0);
}
