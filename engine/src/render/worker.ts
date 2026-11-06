// Render worker: traces row chunks of a shared framebuffer (see pool.ts).
import { parentPort } from 'node:worker_threads';
import { createTracer } from './trace.ts';

parentPort!.on('message', (m: any) => {
  try {
    const tracer = createTracer(m.scene, m.params);
    const ctr = new Int32Array(m.counter);
    const fb = new Float32Array(m.fb);
    const H = m.params.H;
    for (;;) {
      const r0 = Atomics.add(ctr, 0, m.chunk);
      if (r0 >= H) break;
      tracer.renderRows(r0, Math.min(H, r0 + m.chunk), fb);
    }
    parentPort!.postMessage({ id: m.id, ok: true });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: String((e as Error)?.stack ?? e) });
  }
});
