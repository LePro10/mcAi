// Module Web Worker: meshing + lighting off the main thread (logic lives in meshcore.js).
import { MeshCore } from './meshcore.js';

const core = new MeshCore((msg, transfer) => self.postMessage(msg, transfer ?? []));
let scheduled = false;

function pump() {
  scheduled = false;
  try {
    core.process(14);
  } catch (e) {
    self.postMessage({ t: 'error', message: String(e?.stack ?? e) });
  }
  if (core.dirty.size || core.pendingLight) schedule();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(pump, 0);
}

self.onmessage = (ev) => {
  try {
    core.handle(ev.data);
  } catch (e) {
    self.postMessage({ t: 'error', message: String(e?.stack ?? e) });
  }
  if (core.dirty.size || core.pendingLight) schedule();
};
