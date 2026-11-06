// mcAI viewer — app controller: engine connection, world loading, live edits, wand UI, job panel.
import * as THREE from 'three';
import { WorldView } from './scene.js';
import { EngineClient, isActive, agentIcon } from './protocol.js';
import { decodeVolume, decodeBlocks, batchBounds, defaultAllowedBox, b64ToInt16, b64ToUint16, plainText } from './codec.js';
import { fallbackGeometry } from './voxels.js';
import { t, initLang, setLang, getLang, applyI18n, onLang, fmtDuration, fmtAgo, fmtNumber } from './i18n.js';
import { icon, LOGO } from './icons.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLES = ['auto', 'medieval', 'fantasy', 'japanese', 'modern', 'steampunk', 'nordic', 'desert', 'rustic', 'gothic', 'elven', 'futuristic'];
const SIZES = { S: '24x24x24', M: '48x40x48', L: '72x56x72', XL: '112x80x112' };
const FACINGS = ['north', 'east', 'south', 'west'];
const PLAYER = 'Viewer';
const VIEW_RADIUS = 64;

const settings = loadSettings();
const S = {
  info: null,
  status: null,
  connected: false,
  everConnected: false,
  jobs: new Map(),
  agent: new Map(),
  chat: [],
  selected: null,
  style: settings.style ?? 'auto',
  size: settings.size ?? 'M',
  facing: 'north',
  anchor: null,
  picking: false,
  area: null,
  ground: null,
  loading: false,
  loadP: null,
  pendingEdits: [],
  follow: settings.follow ?? true,
  layers: false,
  cut: null,
  dismissedQ: new Set(),
  atlasRev: null,
  meshRev: 0,
  askFor: null,
  feedTab: 'thoughts',
  loadedLogs: new Set(),
};

// ------------------------------------------------------------------ bootstrap

initLang();
document.querySelector('#logo').innerHTML = LOGO;
for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
applyI18n(document);
onLang(() => {
  applyI18n(document);
  renderStatic();
  renderAll();
});

let view;
try {
  view = new WorldView($('#view'));
} catch (e) {
  console.error(e);
  $('#loading-title').textContent = t('toast.noGl');
  throw e;
}
window.mcai = { S, view }; // debugging handle

const worker = new Worker(new URL('./mesh-worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (ev) => onWorker(ev.data);
worker.onerror = (e) => console.error('[mcai] mesh worker error', e.message ?? e);

const client = new EngineClient({});
client.on('hello', onHello);
client.on('job', (m) => onJob(m.job));
client.on('agent', onAgent);
client.on('blocks', (m) => void onBlocks(m));
client.on('mod', onMod);
client.on('notify', onNotify);
client.on('open', onOpen);
client.on('close', onClose);
client.on('retry', (r) => {
  if (!S.connected) setBanner(`${t('banner.lost')} ${t('banner.retry', { s: Math.round(r.delay / 1000), n: r.attempt })}`);
});

renderStatic();
renderAll();
wireUi();
view.setTime(settings.time ?? 'day', false);
view.setShadows(settings.shadows ?? true);
setFollow(S.follow);
setTimeout(() => $('#app').classList.remove('booting'), 60);
start();

async function start() {
  setLoading(t('load.world'), null);
  try {
    await client.session();
    S.info = await client.api('/api/viewer/info');
    await loadAtlas();
  } catch (e) {
    console.warn('[mcai] viewer info unavailable', e);
  }
  client.connect().catch(() => {});
}

async function loadAtlas() {
  if (!S.info?.assets) {
    view.setAtlas(null);
    toast(t('toast.noAssets'), 'err');
    return;
  }
  setLoading(t('load.textures'), null);
  const rev = S.info.atlas?.rev ?? '';
  try {
    const tex = await new THREE.TextureLoader().loadAsync(`/api/viewer/atlas.png?rev=${encodeURIComponent(rev)}`);
    view.setAtlas(tex);
    S.atlasRev = rev;
  } catch (e) {
    console.warn('[mcai] atlas failed', e);
    view.setAtlas(null);
  }
}

// ------------------------------------------------------------------ palette / geometry

const pal = { states: ['minecraft:air'], index: new Map([['minecraft:air', 0]]) };
let palChain = Promise.resolve();
let atlasReload = null;

async function fetchGeometry(states) {
  const out = {};
  let rev = null;
  for (let i = 0; i < states.length; i += 1500) {
    const r = await client.api('/api/viewer/geometry', { body: { states: states.slice(i, i + 1500) } });
    Object.assign(out, r.geometry);
    rev = r.atlasRev;
  }
  return { geometry: out, rev };
}

async function ensureStatesNow(list) {
  const unknown = [...new Set(list.filter((s) => !pal.index.has(s)))];
  if (unknown.length) {
    let geo = {};
    let rev = null;
    try {
      ({ geometry: geo, rev } = await fetchGeometry(unknown));
    } catch (e) {
      console.warn('[mcai] geometry unavailable, using fallback cubes', e);
    }
    const entries = [];
    for (const s of unknown) {
      const i = pal.states.length;
      pal.states.push(s);
      pal.index.set(s, i);
      entries.push([i, s, geo[s] ?? fallbackGeometry(s)]);
    }
    worker.postMessage({ t: 'geo', entries, fluids: S.info?.fluids, waterTint: S.info?.waterTint });
    if (rev && S.atlasRev && rev !== S.atlasRev && !atlasReload) atlasReload = reloadAtlasAndGeometry().finally(() => (atlasReload = null));
  }
  return Uint16Array.from(list, (s) => pal.index.get(s) ?? 0);
}

function ensureStates(list) {
  palChain = palChain.then(() => ensureStatesNow(list), () => ensureStatesNow(list));
  return palChain;
}

/** the engine rebuilt its atlas (new textures) → reload texture + all uvs */
async function reloadAtlasAndGeometry() {
  S.info = await client.api('/api/viewer/info');
  await loadAtlas();
  const { geometry } = await fetchGeometry(pal.states.slice(1));
  const entries = pal.states.slice(1).map((s, k) => [k + 1, s, geometry[s] ?? fallbackGeometry(s)]);
  worker.postMessage({ t: 'geo', entries, fluids: S.info?.fluids, waterTint: S.info?.waterTint, remeshAll: true });
}

// ------------------------------------------------------------------ worker

const rays = new Map();
let raySeq = 0;

function onWorker(m) {
  switch (m.t) {
    case 'section':
      if (m.rev !== S.meshRev) return;
      view.setSection(m);
      return;
    case 'progress':
      if (m.lightMs !== undefined) {
        S.meshRev = m.rev;
        view.clearSections();
      }
      if (S.loading || $('#loading').classList.contains('done') === false) setLoading(t('load.world'), m.total ? m.done / m.total : null, t('load.mesh', m));
      return;
    case 'loaded':
      setLoading(null);
      console.info(`[mcai] meshed ${m.sections} sections, ${m.quads} quads in ${m.ms} ms`);
      return;
    case 'ray': {
      const r = rays.get(m.id);
      rays.delete(m.id);
      r?.(m.hit);
      return;
    }
    case 'error':
      console.error('[mcai worker]', m.message);
      return;
  }
}

function raycast(ray, opts = {}) {
  const id = ++raySeq;
  return new Promise((resolve) => {
    rays.set(id, resolve);
    worker.postMessage({ t: 'raycast', id, origin: ray.origin, dir: ray.dir, ...opts });
    setTimeout(() => {
      if (rays.has(id)) {
        rays.delete(id);
        resolve(null);
      }
    }, 3000);
  });
}

// ------------------------------------------------------------------ world loading

function boxInside(inner, outer, margin = 0) {
  return inner.min.every((v, i) => v >= outer.min[i] + (i === 1 ? 0 : margin)) && inner.max.every((v, i) => v <= outer.max[i] - (i === 1 ? 0 : margin));
}

async function loadArea(center, opts = {}) {
  const prev = S.loadP;
  const run = (async () => {
    if (prev) await prev.catch(() => {});
    S.loading = true;
    if (!opts.silent) setLoading(t('load.world'), null);
    try {
      const world = S.status?.world ?? { minY: -64, maxY: 319 };
      let x0 = Math.floor(center[0]) - VIEW_RADIUS, z0 = Math.floor(center[2]) - VIEW_RADIUS;
      let x1 = x0 + VIEW_RADIUS * 2 - 1, z1 = z0 + VIEW_RADIUS * 2 - 1;
      const inc = opts.include;
      if (inc) {
        x0 = Math.min(x0, inc.min[0] - 16); z0 = Math.min(z0, inc.min[2] - 16);
        x1 = Math.max(x1, inc.max[0] + 16); z1 = Math.max(z1, inc.max[2] + 16);
        // cap the area
        if (x1 - x0 > 320) { const c = (inc.min[0] + inc.max[0]) >> 1; x0 = c - 160; x1 = c + 159; }
        if (z1 - z0 > 320) { const c = (inc.min[2] + inc.max[2]) >> 1; z0 = c - 160; z1 = c + 159; }
      }
      const hm = await client.request('heightmap', { x0, z0, x1, z1 }, 60_000);
      const h = b64ToInt16(hm.data);
      const W = x1 - x0 + 1;
      let minH = Infinity, maxH = -Infinity;
      for (const v of h) {
        if (v < world.minY) continue;
        if (v < minH) minH = v;
        if (v > maxH) maxH = v;
      }
      if (!Number.isFinite(minH)) minH = maxH = 64;
      let y0 = Math.max(world.minY, minH - 22), y1 = Math.min(world.maxY, maxH + 40);
      if (inc) {
        y0 = Math.max(world.minY, Math.min(y0, inc.min[1] - 2));
        y1 = Math.min(world.maxY, Math.max(y1, inc.max[1] + 6));
      }
      if (y1 - y0 > 220) y0 = Math.max(world.minY, y1 - 220);
      const box = { min: [x0, y0, z0], max: [x1, y1, z1] };
      const ci = (Math.floor(center[2]) - z0) * W + (Math.floor(center[0]) - x0);
      S.ground = h[ci] ?? minH;
      const step = 4;
      const [vol, bio] = await Promise.all([
        client.request('get_blocks', { box }, 180_000),
        client.api(`/api/viewer/biomes?box=${[x0, y0, z0, x1, y1, z1].join(',')}&step=${step}`).catch(() => null),
      ]);
      const v = decodeVolume(vol);
      const remap = await ensureStates(v.palette);
      const data = new Uint16Array(v.data.length);
      for (let i = 0; i < data.length; i++) data[i] = remap[v.data[i]];
      if (bio) {
        const data2 = b64ToUint16(bio.data);
        worker.postMessage({ t: 'biomes', x0: bio.x0, z0: bio.z0, nx: bio.nx, nz: bio.nz, step: bio.step, data: data2, tints: bio.palette.map((n) => bio.tints[n]), silent: true });
      }
      S.area = box;
      view.setArea(box);
      worker.postMessage({ t: 'volume', box, data, center: [center[0], S.ground, center[2]] }, [data.buffer]);
      updateLayerRange();
      S.loading = false;
      const q = S.pendingEdits;
      S.pendingEdits = [];
      for (const e of q) await onBlocks(e, false);
      return { box, ground: S.ground };
    } catch (e) {
      S.loading = false;
      const msg = /no Minecraft|not connected|mod/i.test(e.message) ? t('status.waiting') : e.message;
      setLoading(msg, null, '');
      throw e;
    }
  })();
  S.loadP = run;
  return run;
}

async function ensureAreaFor(box) {
  if (S.area && boxInside(box, S.area, 2)) return;
  const c = [(box.min[0] + box.max[0]) >> 1, box.min[1], (box.min[2] + box.max[2]) >> 1];
  await loadArea(c, { include: box, silent: !!S.area });
}

// ------------------------------------------------------------------ engine events

async function onHello(m) {
  S.status = m.status;
  S.connected = true;
  for (const j of m.jobs ?? []) S.jobs.set(j.id, j);
  renderStatus();
  renderHistory();
  const first = !S.everLoaded;
  S.everLoaded = true;
  const jobs = [...S.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  const active = jobs.find(isActive);
  if (first) {
    const focusJob = active ?? jobs[0] ?? null;
    let center = focusJob?.anchor ?? null;
    if (!center) {
      try {
        const p = (await client.request('players')).players?.[0];
        if (p?.pos) center = p.pos.map(Math.floor);
      } catch {}
    }
    center ??= [0, 64, 0];
    try {
      if (focusJob) {
        await loadArea(center, { include: focusJob.allowedBox });
        select(focusJob.id, { fly: false });
        view.frameBox(focusJob.allowedBox, 10, { groundY: focusJob.anchor[1], zoom: 1.15 });
      } else {
        const r = await loadArea(center);
        view.frameBox(r.box, 10, { groundY: r.ground, zoom: 1.05 });
      }
    } catch (e) {
      console.warn('[mcai] initial load failed', e);
    }
  } else if (S.area) {
    // reconnected: the world may have changed meanwhile
    const c = [(S.area.min[0] + S.area.max[0] + 1) >> 1, 0, (S.area.min[2] + S.area.max[2] + 1) >> 1];
    loadArea(c, { include: S.area, silent: true }).catch(() => {});
  }
  if (S.selected) renderJob();
  for (const j of S.jobs.values()) checkQuestion(j);
}

function onOpen() {
  const was = S.everConnected;
  S.everConnected = true;
  S.connected = true;
  if (was) {
    setBanner(t('banner.back'), 'ok');
    setTimeout(() => setBanner(null), 1800);
  } else setBanner(null);
  renderStatus();
}

function onClose(ev) {
  S.connected = false;
  renderStatus();
  if (ev.wasOpen || S.everConnected) setBanner(t('banner.lost'));
}

async function onMod(m) {
  try {
    S.status = await client.request('status');
  } catch {
    if (S.status) S.status.mod = { connected: m.connected, ...(m.hello ?? {}) };
  }
  renderStatus();
  // a Minecraft world just became available → (re)load the view
  if (m.connected && S.status?.backend === 'minecraft') {
    const c = S.area ? [(S.area.min[0] + S.area.max[0]) >> 1, 0, (S.area.min[2] + S.area.max[2]) >> 1] : null;
    if (c) loadArea(c, { include: S.area }).catch(() => {});
    else {
      S.everLoaded = false;
      onHello({ status: S.status, jobs: [...S.jobs.values()] });
    }
  }
}

function onJob(job) {
  if (!job) return;
  const prev = S.jobs.get(job.id);
  S.jobs.set(job.id, job);
  const sel = S.selected ? S.jobs.get(S.selected) : null;
  if (!prev && isActive(job) && (!sel || !isActive(sel) || job.source === 'viewer')) select(job.id, { fly: true });
  if (prev && isActive(prev) && !isActive(job)) onJobEnd(job);
  if (S.selected === job.id) renderJob();
  renderHistory();
  checkQuestion(job);
  updateJobBox();
}

function onJobEnd(job) {
  if (job.state === 'done') {
    toast(t('toast.done', { blocks: fmtNumber(job.blocksChanged), time: fmtDuration(job.durationMs) }), 'ok', 'check');
    showTitle(t('state.done'), job.prompt.slice(0, 80));
  } else if (job.state === 'failed') toast(t('toast.failed', { error: job.error ?? '?' }), 'err', 'x');
  else toast(t('toast.cancelled'), '', 'stop');
  if (S.askFor === job.id) hideAsk();
}

function onAgent(m) {
  if (!m.jobId || !m.ev) return;
  let arr = S.agent.get(m.jobId);
  if (!arr) S.agent.set(m.jobId, (arr = []));
  const e = { kind: m.ev.kind, line: m.ev.line ?? '', t: Date.now() };
  arr.push(e);
  if (arr.length > 800) arr.splice(0, arr.length - 800);
  if (S.selected === m.jobId) appendFeed(e);
}

async function onBlocks(m, animate = true) {
  if (m.dimension && S.status?.world?.dimension && m.dimension !== S.status.world.dimension) return;
  if (S.loading || !S.area) {
    if (S.loading) S.pendingEdits.push(m);
    return;
  }
  const b = decodeBlocks(m);
  if (!b.count) return;
  const remap = await ensureStates(b.palette);
  const positions = b.positions.slice(0, b.count * 3);
  const states = new Uint16Array(b.count);
  for (let i = 0; i < b.count; i++) states[i] = remap[b.states[i]];
  const bb = batchBounds(positions, b.count);
  worker.postMessage({ t: 'edit', positions, states, now: view.now() + 0.03, animate: animate && b.count <= 60000 }, [positions.buffer, states.buffer]);
  if (bb && S.follow) {
    view.followPoint([(bb.min[0] + bb.max[0] + 1) / 2, (bb.min[1] + bb.max[1] + 1) / 2, (bb.min[2] + bb.max[2] + 1) / 2]);
    worker.postMessage({ t: 'focus', center: [(bb.min[0] + bb.max[0]) / 2, bb.max[1], (bb.min[2] + bb.max[2]) / 2] });
  }
}

function onNotify(m) {
  const text = plainText(m.text);
  if (!text) return;
  if (m.kind === 'actionbar') {
    const el = $('#actionbar');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(onNotify.tm);
    onNotify.tm = setTimeout(() => el.classList.remove('show'), 3200);
  }
  if (m.kind === 'title') showTitle(text, '');
  if (m.kind === 'sound') return;
  S.chat.push({ target: m.target, kind: m.kind, text, t: Date.now() });
  if (S.chat.length > 300) S.chat.shift();
  renderChat(true);
}

// ------------------------------------------------------------------ selection / job panel

async function select(id, opts = {}) {
  S.selected = id;
  const job = S.jobs.get(id);
  renderJob();
  renderFeed();
  renderHistory();
  updateJobBox();
  if (window.innerWidth <= 920) $('#app').classList.add('show-job');
  if (!job) return;
  if (!S.agent.get(id)?.length && !S.loadedLogs.has(id)) {
    S.loadedLogs.add(id);
    try {
      const r = await client.api(`/api/jobs/${encodeURIComponent(id)}?log=600`);
      const evs = (r.log ?? []).filter((l) => l && l.kind === 'agent' && l.ev !== 'raw' && l.ev !== 'stderr').map((l) => ({ kind: l.ev, line: l.line ?? '', t: l.t }));
      if (evs.length && !S.agent.get(id)?.length) S.agent.set(id, evs);
      if (S.selected === id) renderFeed();
    } catch {}
  }
  if (opts.fly && job.allowedBox) {
    try {
      await ensureAreaFor(job.allowedBox);
    } catch {}
    view.frameBox(job.allowedBox, 1400, { groundY: job.anchor?.[1] });
  }
}

function updateJobBox() {
  const job = S.selected ? S.jobs.get(S.selected) : null;
  view.showBox('job', job && isActive(job) ? job.allowedBox : null);
}

function renderJob() {
  const job = S.selected ? S.jobs.get(S.selected) : null;
  $('#job-empty').hidden = !!job;
  $('#job-body').hidden = !job;
  if (!job) return;
  const st = $('#job-state');
  st.className = `badge ${job.state}`;
  st.textContent = t(`state.${job.state}`);
  $('#job-id').textContent = job.id;
  $('#job-prompt').textContent = job.prompt;
  $('#job-prompt').title = job.prompt;
  const active = isActive(job);
  const pct = Math.round((job.state === 'done' ? 1 : job.progress ?? 0) * 100);
  const bar = $('#job-bar');
  bar.style.width = `${pct}%`;
  bar.classList.toggle('live', active);
  bar.parentElement.classList.toggle('indeterminate', active && job.progress <= 0.001);
  $('#job-pct').textContent = active || job.state === 'done' ? `${pct}%` : '';
  $('#job-stage').textContent = job.stage || t(`state.${job.state}`);
  $('#job-detail').textContent = job.detail || '';
  $('#job-detail').title = job.detail || '';
  $('#st-cost').textContent = job.costUsd ? `$${job.costUsd.toFixed(2)}` : '–';
  $('#st-time').textContent = job.startedAt ? fmtDuration(active ? Date.now() - job.startedAt : job.durationMs) : '–';
  $('#st-blocks').textContent = fmtNumber(job.blocksChanged);
  $('#st-tools').textContent = fmtNumber(job.toolCalls);
  $('#btn-cancel').hidden = !active;
  const fin = job.finished;
  const showFin = !active && (fin || job.error);
  $('#job-finish').hidden = !showFin;
  if (showFin) {
    $('#job-error').hidden = !job.error || job.state === 'done';
    $('#job-error').textContent = job.error ? `${t('job.error')}: ${job.error}` : '';
    $('#job-summary-wrap').hidden = !fin?.summary;
    $('#job-summary').textContent = fin?.summary ?? '';
    const list = (sel, wrap, items) => {
      $(wrap).hidden = !items?.length;
      $(sel).innerHTML = (items ?? []).map((x) => `<li>${esc(x)}</li>`).join('');
    };
    list('#job-highlights', '#job-highlights-wrap', fin?.highlights);
    list('#job-suggestions', '#job-suggestions-wrap', fin?.suggestions);
  }
}

/** feed noise filter: trivial tool results ("ok") are not shown */
function shownInFeed(e) {
  return !!e.line && !(e.kind === 'tool_result' && e.line.trim().length < 4);
}

function feedItem(e) {
  const ic = agentIcon(e);
  const line = String(e.line ?? '');
  const sub = /^\[[^\]]+\]\s/.test(line);
  const li = document.createElement('li');
  li.className = `k-${e.kind} i-${ic}${sub ? ' sub' : ''}${line.length > 150 ? ' long' : ''}`;
  const tm = new Date(e.t ?? Date.now());
  li.innerHTML = `<span class="fi">${icon(ic)}</span><div class="fb"><div class="fl">${esc(line)}</div><div class="fm">${tm.toLocaleTimeString(getLang() === 'de' ? 'de-DE' : 'en-US', { hour12: false })}</div></div>`;
  if (line.length > 150) li.addEventListener('click', () => li.classList.toggle('open'));
  return li;
}

function renderFeed() {
  const ol = $('#feed-thoughts');
  ol.innerHTML = '';
  const evs = (S.selected && S.agent.get(S.selected)) || [];
  const shown = evs.filter(shownInFeed).slice(-300);
  if (!shown.length) ol.innerHTML = `<li class="feed-empty">${esc(t('job.emptyFeed'))}</li>`;
  const frag = document.createDocumentFragment();
  for (const e of shown) frag.append(feedItem(e));
  ol.append(frag);
  $('#thoughts-count').textContent = shown.length ? String(shown.length) : '';
  ol.scrollTop = ol.scrollHeight;
}

function appendFeed(e) {
  if (!shownInFeed(e)) return;
  const ol = $('#feed-thoughts');
  ol.querySelector('.feed-empty')?.remove();
  const stick = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 60;
  ol.append(feedItem(e));
  while (ol.children.length > 300) ol.firstChild.remove();
  $('#thoughts-count').textContent = String(S.agent.get(S.selected)?.filter(shownInFeed).length ?? '');
  if (stick) ol.scrollTop = ol.scrollHeight;
}

function renderChat(append = false) {
  const ol = $('#feed-chat');
  if (!S.chat.length) {
    ol.innerHTML = `<li class="feed-empty">${esc(t('job.chatEmpty'))}</li>`;
    return;
  }
  const mk = (c) => {
    const li = document.createElement('li');
    li.className = `chat kind-${c.kind}`;
    li.innerHTML = `<span class="fi">${icon(c.kind === 'chat' ? 'chat' : 'spark')}</span><div class="fb"><div class="fl"><span class="who">→ ${esc(c.target)}</span>${esc(c.text)}</div><div class="fm">${new Date(c.t).toLocaleTimeString(getLang() === 'de' ? 'de-DE' : 'en-US', { hour12: false })} · ${esc(c.kind)}</div></div>`;
    return li;
  };
  if (append && ol.children.length && !ol.querySelector('.feed-empty')) ol.append(mk(S.chat[S.chat.length - 1]));
  else {
    ol.innerHTML = '';
    for (const c of S.chat) ol.append(mk(c));
  }
  ol.scrollTop = ol.scrollHeight;
  $('#chat-count').textContent = String(S.chat.length);
}

function renderHistory() {
  const ul = $('#history-list');
  const jobs = [...S.jobs.values()].filter((j) => !j.id.startsWith('adhoc-') || j.blocksChanged > 0).sort((a, b) => b.createdAt - a.createdAt);
  $('#history-count').textContent = jobs.length ? String(jobs.length) : '';
  if (!jobs.length) {
    ul.innerHTML = `<li class="history-empty">${esc(t('history.empty'))}</li>`;
    return;
  }
  ul.innerHTML = jobs
    .map((j) => {
      const cls = isActive(j) ? 'active' : j.state;
      const meta = [t(`state.${j.state}`), j.blocksChanged ? `${fmtNumber(j.blocksChanged)} ▣` : '', j.costUsd ? `$${j.costUsd.toFixed(2)}` : '', j.source === 'mod' ? j.player : ''].filter(Boolean);
      return `<li data-id="${esc(j.id)}" class="${j.id === S.selected ? 'sel' : ''}" title="${esc(j.prompt)}"><span class="sdot ${cls}"></span><span class="hp">${esc(j.prompt)}</span><span class="ht">${esc(fmtAgo(j.createdAt))}</span><span class="hm">${meta.map((x) => `<span>${esc(x)}</span>`).join('')}</span></li>`;
    })
    .join('');
}

function renderStatus() {
  const pill = $('#pill-world');
  const s = S.status;
  let cls = 'bad', text = t('status.offline');
  if (S.connected && s) {
    if (s.backend === 'sim') {
      cls = 'sim';
      text = `${t('status.sim')} · ${s.world?.name ?? 'sim'}${s.mod?.connected ? ` · mod ${s.mod.modVersion ?? ''}` : ''}`;
    } else if (s.mod?.connected) {
      cls = 'ok';
      text = `${t('status.mc')} ${s.mod.mcVersion ?? ''} · ${s.mod.world ?? ''}`;
    } else {
      cls = 'warn';
      text = t('status.waiting');
    }
  }
  pill.className = `pill ${cls}`;
  pill.querySelector('.pill-text').textContent = text;
  pill.title = s ? `${s.backend} · registry ${s.registry} · ${s.jobs?.active ?? 0} active job(s)` : '';
  $('#pill-engine').querySelector('.pill-text').textContent = s ? `${t('status.engine')} v${s.version}` : t('status.engine');
}

function renderAll() {
  renderStatus();
  renderHistory();
  renderJob();
  renderFeed();
  renderChat();
  renderWand();
}

// ------------------------------------------------------------------ ask_player

function checkQuestion(job) {
  const q = job.question;
  if (q && isActive(job)) {
    const key = `${job.id}:${q.text}`;
    if (S.dismissedQ.has(key) || (S.askFor === job.id && $('#ask-text').textContent === q.text)) return;
    S.askFor = job.id;
    $('#ask-job').textContent = job.prompt.slice(0, 70);
    $('#ask-text').textContent = q.text;
    $('#ask-options').innerHTML = (q.options ?? []).map((o, i) => `<button data-opt="${esc(o)}"><kbd>${i + 1}</kbd><span>${esc(o)}</span></button>`).join('');
    $('#ask-input').value = '';
    $('#ask').hidden = false;
    $('#ask').dataset.key = key;
  } else if (S.askFor === job.id) hideAsk();
}

function hideAsk() {
  $('#ask').hidden = true;
  S.askFor = null;
}

async function answer(text) {
  const id = S.askFor;
  if (!id || !text) return;
  hideAsk();
  try {
    await client.request('reply', { jobId: id, text });
  } catch (e) {
    toast(e.message, 'err', 'x');
  }
}

// ------------------------------------------------------------------ wand

function renderStatic() {
  $('#styles').innerHTML = STYLES.map((s) => `<button class="chip${s === S.style ? ' on' : ''}" data-style="${s}">${esc(t(`style.${s}`))}</button>`).join('');
  $('#sizes').innerHTML = Object.entries(SIZES).map(([k, v]) => `<button data-size="${k}" class="${k === S.size ? 'on' : ''}"><b>${k}</b><small>${v.replace(/x/g, '×')}</small></button>`).join('');
  $('#lang-code').textContent = getLang().toUpperCase();
  renderWand();
}

function renderWand() {
  $$('#styles .chip').forEach((b) => b.classList.toggle('on', b.dataset.style === S.style));
  $$('#sizes button').forEach((b) => {
    b.classList.toggle('on', b.dataset.size === S.size);
    b.title = t(`size.${b.dataset.size}`);
  });
  $('#facing-text').textContent = t(`facing.${S.facing}`).slice(0, 1);
  $('#btn-facing').title = `${t('wand.facing')}: ${t(`facing.${S.facing}`)}`;
  $('.facing-arrow').style.transform = `rotate(${FACINGS.indexOf(S.facing) * 90}deg)`;
  $('#anchor-text').textContent = S.anchor ? S.anchor.join(', ') : t('wand.viewCenter');
  $('#btn-clear-anchor').hidden = !S.anchor;
  $('#pick-label').textContent = S.picking ? t('wand.picking') : t('wand.pick');
  $('#btn-pick').classList.toggle('on', S.picking);
  updateSitePreview();
}

function sitePreviewBox(anchor) {
  const size = SIZES[S.size].split('x').map(Number);
  return defaultAllowedBox(anchor, S.facing, { x: size[0], y: size[1], z: size[2] }, S.info?.depthBelow ?? 12, S.status?.world ?? undefined);
}

function updateSitePreview(hoverAnchor) {
  const a = hoverAnchor ?? S.anchor;
  view.showBox('site', a ? sitePreviewBox(a) : null);
  view.showAnchor(a, S.facing);
}

function setPicking(on) {
  S.picking = on;
  $('#view').style.cursor = on ? 'crosshair' : '';
  $('#hint').hidden = !on;
  if (on) $('#hint').innerHTML = `${icon('target')}<span>${esc(t('pick.hint'))}</span>`;
  if (!on) view.showHover(null);
  renderWand();
}

async function startJob(mode) {
  const ta = $('#prompt');
  const prompt = ta.value.trim();
  if (!prompt) {
    ta.focus();
    ta.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 260 });
    return;
  }
  let anchor = S.anchor;
  if (!anchor) {
    const hit = await raycast(view.centerRay(), { ignoreFluids: false });
    if (hit) anchor = hit.pos;
  }
  const body = { prompt, mode, size: SIZES[S.size], facing: S.facing, player: PLAYER };
  if (anchor) body.anchor = anchor;
  if (S.style !== 'auto') body.style = S.style;
  const btn = mode === 'plan' ? $('#btn-plan') : $('#btn-build');
  btn.disabled = true;
  try {
    const r = await client.request('start_job', body, 30_000);
    toast(t('toast.started'), 'ok', 'wand');
    S.anchor = null;
    renderWand();
    onJob(r.job);
    select(r.job.id, { fly: true });
  } catch (e) {
    toast(e.message, 'err', 'x');
  } finally {
    btn.disabled = false;
  }
}

async function undoRedo(kind) {
  const job = S.selected ? S.jobs.get(S.selected) : null;
  try {
    const r = await client.request(kind, { player: job?.player ?? PLAYER });
    toast(r.message ?? kind, 'ok', kind);
  } catch (e) {
    toast(e.message, 'err', 'x');
  }
}

// ------------------------------------------------------------------ toolbar actions

function setFollow(on) {
  S.follow = on;
  view.setFollow(on);
  $('#btn-follow').classList.toggle('on', on);
  saveSettings();
}

function setTime(name) {
  view.setTime(name);
  $$('#time-seg button').forEach((b) => b.classList.toggle('on', b.dataset.time === name));
  settings.time = name;
  saveSettings();
}

function updateLayerRange() {
  const r = $('#layer-range');
  if (!S.area) return;
  r.min = String(S.area.min[1]);
  r.max = String(S.area.max[1]);
  if (S.cut === null || S.cut > S.area.max[1] || S.cut < S.area.min[1]) r.value = String(Math.min(S.area.max[1], (S.ground ?? S.area.min[1]) + 6));
}

let cutRaf = 0;
function setCut(y) {
  S.cut = y;
  $('#layer-value').textContent = y === null ? '' : t('layer.y', { y });
  if (cutRaf) return;
  cutRaf = requestAnimationFrame(() => {
    cutRaf = 0;
    view.setCut(S.cut);
    worker.postMessage({ t: 'cut', y: S.cut });
  });
}

function setLayers(on) {
  S.layers = on;
  $('#layers').hidden = !on;
  $('#btn-layers').classList.toggle('on', on);
  if (on) {
    updateLayerRange();
    setCut(Number($('#layer-range').value));
  } else setCut(null);
}

async function screenshot() {
  const job = S.selected ? S.jobs.get(S.selected) : null;
  const blob = await view.screenshot(job ? job.prompt.slice(0, 60) : '');
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mcai-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(t('toast.shot'), 'ok', 'camera');
}

function toggleUi() {
  $('#app').classList.toggle('ui-hidden');
}

// ------------------------------------------------------------------ overlays

function setLoading(title, frac, sub) {
  const el = $('#loading');
  if (title === null) {
    el.classList.add('done');
    return;
  }
  el.classList.remove('done');
  $('#loading-title').textContent = title;
  const bar = $('#loading-bar');
  bar.parentElement.classList.toggle('indeterminate', frac === null || frac === undefined);
  bar.style.width = frac == null ? '' : `${Math.round(frac * 100)}%`;
  $('#loading-sub').textContent = sub ?? '';
}

function setBanner(text, kind = '') {
  const b = $('#banner');
  if (!text) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  b.className = kind;
  $('#banner-text').textContent = text;
}

function toast(text, kind = '', ic = 'spark') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'err' ? 'x' : ic)}<span>${esc(text)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, kind === 'err' ? 5200 : 3200);
}

function showTitle(a, b) {
  const el = $('#title-overlay');
  $('.t1', el).textContent = a;
  $('.t2', el).textContent = b;
  el.classList.add('show');
  clearTimeout(showTitle.tm);
  showTitle.tm = setTimeout(() => el.classList.remove('show'), 2600);
}

// ------------------------------------------------------------------ UI wiring

function wireUi() {
  $('#styles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-style]');
    if (!b) return;
    S.style = b.dataset.style;
    saveSettings();
    renderWand();
  });
  $('#sizes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]');
    if (!b) return;
    S.size = b.dataset.size;
    saveSettings();
    renderWand();
  });
  $('#btn-facing').addEventListener('click', () => rotateFacing());
  $('#btn-pick').addEventListener('click', () => setPicking(!S.picking));
  $('#btn-clear-anchor').addEventListener('click', () => {
    S.anchor = null;
    renderWand();
  });
  $('#btn-build').addEventListener('click', () => startJob('build'));
  $('#btn-plan').addEventListener('click', () => startJob('plan'));
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      startJob('build');
    }
  });
  $('#history-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) select(li.dataset.id, { fly: true });
  });
  $('#btn-flyto').addEventListener('click', () => S.selected && select(S.selected, { fly: true }));
  $('#btn-cancel').addEventListener('click', async () => {
    if (!S.selected) return;
    try {
      await client.request('cancel_job', { jobId: S.selected });
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  $('#btn-undo').addEventListener('click', () => undoRedo('undo'));
  $('#btn-redo').addEventListener('click', () => undoRedo('redo'));
  $$('.tabs .tab').forEach((b) =>
    b.addEventListener('click', () => {
      S.feedTab = b.dataset.tab;
      $$('.tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
      $('#feed-thoughts').hidden = S.feedTab !== 'thoughts';
      $('#feed-chat').hidden = S.feedTab !== 'chat';
      $('#feeds').classList.remove('collapsed');
    }),
  );
  $('#btn-collapse-feed').addEventListener('click', () => $('#feeds').classList.toggle('collapsed'));
  $('#time-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-time]');
    if (b) setTime(b.dataset.time);
  });
  $$('#time-seg button').forEach((b) => b.classList.toggle('on', b.dataset.time === (settings.time ?? 'day')));
  $('#btn-layers').addEventListener('click', () => setLayers(!S.layers));
  $('#layer-range').addEventListener('input', (e) => setCut(Number(e.target.value)));
  $('#btn-follow').addEventListener('click', () => setFollow(!S.follow));
  $('#btn-fly').addEventListener('click', () => {
    view.setFly(!view.fly.on);
  });
  view.on('fly', (on) => {
    $('#btn-fly').classList.toggle('on', on);
    if (on) toast(t('toast.flyHelp'), '', 'fly');
  });
  view.on('userCamera', () => {
    // manual camera input pauses auto-follow drift for a moment
    if (S.follow) view.follow.target = null;
  });
  $('#btn-shadows').addEventListener('click', () => {
    settings.shadows = !(settings.shadows ?? true);
    view.setShadows(settings.shadows);
    $('#btn-shadows').classList.toggle('on', settings.shadows);
    saveSettings();
  });
  $('#btn-shadows').classList.toggle('on', settings.shadows ?? true);
  $('#btn-shot').addEventListener('click', screenshot);
  $('#btn-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  $('#btn-ui').addEventListener('click', toggleUi);
  $('#btn-help').addEventListener('click', () => ($('#help').hidden = false));
  $('#btn-lang').addEventListener('click', () => setLang(getLang() === 'de' ? 'en' : 'de'));
  $$('.modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) {
        if (m.id === 'ask') dismissAsk();
        else m.hidden = true;
      }
    }),
  );
  $('#ask-options').addEventListener('click', (e) => {
    const b = e.target.closest('[data-opt]');
    if (b) answer(b.dataset.opt);
  });
  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    answer($('#ask-input').value.trim());
  });
  $('#ask-later').addEventListener('click', dismissAsk);

  // canvas: picking, hover, double-click focus
  const cv = $('#view');
  let down = null;
  let hoverBusy = false;
  cv.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  cv.addEventListener('pointermove', async (e) => {
    if (!S.picking || hoverBusy) return;
    hoverBusy = true;
    const hit = await raycast(view.rayAt(e.clientX, e.clientY));
    hoverBusy = false;
    if (!S.picking) return;
    view.showHover(hit?.pos ?? null);
    updateSitePreview(hit?.pos);
  });
  cv.addEventListener('pointerup', async (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (!S.picking || moved > 5 || e.button !== 0) return;
    const hit = await raycast(view.rayAt(e.clientX, e.clientY));
    if (!hit) return toast(t('toast.noHit'), 'err');
    S.anchor = hit.pos;
    setPicking(false);
    view.pulse(hit.pos);
    toast(t('toast.anchor', { pos: hit.pos.join(', ') }), 'ok', 'target');
  });
  cv.addEventListener('dblclick', async (e) => {
    if (S.picking) return;
    const hit = await raycast(view.rayAt(e.clientX, e.clientY));
    if (hit) view.focusBlock(hit.pos);
  });

  window.addEventListener('keydown', onKey);
  setInterval(tick, 1000);
  view.on('frame', () => {
    $('#compass .rose').style.transform = `rotate(${view.azimuth()}rad)`;
  });
  setInterval(renderHud, 600);
}

function dismissAsk() {
  const key = $('#ask').dataset.key;
  if (key) S.dismissedQ.add(key);
  hideAsk();
}

function rotateFacing() {
  S.facing = FACINGS[(FACINGS.indexOf(S.facing) + 1) % 4];
  renderWand();
}

function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable;
  if (e.key === 'Escape') {
    if (!$('#ask').hidden) return dismissAsk();
    if (!$('#help').hidden) return void ($('#help').hidden = true);
    if (S.picking) return setPicking(false);
    if (view.fly.on) return view.setFly(false);
    if (typing) return document.activeElement.blur();
    if ($('#app').classList.contains('ui-hidden')) return toggleUi();
    $('#app').classList.remove('show-job');
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$('#ask').hidden && /^[1-9]$/.test(e.key)) {
    const b = $$('#ask-options [data-opt]')[Number(e.key) - 1];
    if (b) answer(b.dataset.opt);
    return;
  }
  if (view.fly.on && /^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space)$/.test(e.code)) return e.preventDefault();
  switch (e.key.toLowerCase()) {
    case 'b':
      e.preventDefault();
      if ($('#app').classList.contains('ui-hidden')) toggleUi();
      $('#app').classList.remove('show-job');
      $('#prompt').focus();
      return;
    case 'l': return setLayers(!S.layers);
    case 'f': return setFollow(!S.follow);
    case 'g': return view.setFly(!view.fly.on);
    case 'h': return toggleUi();
    case 'p': return void screenshot();
    case 't': {
      const order = ['day', 'sunset', 'night'];
      return setTime(order[(order.indexOf(view.timeName) + 1) % 3]);
    }
    case 'r': return rotateFacing();
    case '[':
    case ']': {
      if (!S.layers) setLayers(true);
      const r = $('#layer-range');
      r.value = String(Number(r.value) + (e.key === ']' ? 1 : -1));
      return setCut(Number(r.value));
    }
    case '?': return void ($('#help').hidden = false);
  }
}

function tick() {
  const job = S.selected ? S.jobs.get(S.selected) : null;
  if (job && isActive(job) && job.startedAt) $('#st-time').textContent = fmtDuration(Date.now() - job.startedAt);
  if (Math.random() < 0.05) renderHistory(); // refresh "x min ago"
}

function renderHud() {
  const tg = view.controls.target;
  const st = view.meshStats();
  const p = view.fly.on ? view.camera.position : tg;
  $('#hud').textContent = `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}   ${Math.round(st.fps)} fps   ${(st.tris / 1000).toFixed(0)}k tris`;
}

// ------------------------------------------------------------------ settings

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('mcai.viewer') ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem('mcai.viewer', JSON.stringify({ ...settings, style: S.style, size: S.size, follow: S.follow }));
  } catch {}
}
