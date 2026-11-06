// Lazy worker_threads pool for the renderer. Workers are unref'd while idle so they never
// keep the process alive.
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { SceneData } from './scene.ts';
import type { RenderParams } from './trace.ts';

let workers: Worker[] = [];
let broken = false;
let seq = 0;
/** counters (diagnostics/tests) */
export const poolStats = { parallelRenders: 0 };

export function poolSize(): number {
  const env = Number(process.env.MCAI_RENDER_THREADS);
  if (Number.isFinite(env) && env > 0) return Math.min(32, env);
  return Math.max(1, Math.min(8, availableParallelism()));
}

function ensure(n: number): Worker[] {
  while (workers.length < n) {
    const w = new Worker(new URL('./worker.ts', import.meta.url));
    w.unref();
    w.on('error', () => {
      workers = workers.filter((x) => x !== w);
    });
    workers.push(w);
  }
  return workers.slice(0, n);
}

/** Render all rows of `fb` with the pool. Returns false if workers are unavailable. */
export async function renderParallel(scene: SceneData, params: RenderParams, fb: Float32Array): Promise<boolean> {
  if (broken) return false;
  const n = poolSize();
  if (n <= 1) return false;
  let ws: Worker[];
  try {
    ws = ensure(n);
  } catch {
    broken = true;
    return false;
  }
  const counter = new SharedArrayBuffer(4);
  const id = ++seq;
  const chunk = Math.max(1, Math.min(8, Math.floor(params.H / (n * 6))));
  try {
    await Promise.all(
      ws.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const onMsg = (m: any) => {
              if (m?.id !== id) return;
              w.off('message', onMsg);
              w.off('error', onErr);
              w.unref();
              if (m.ok) resolve();
              else reject(new Error(m.error));
            };
            const onErr = (e: Error) => {
              w.off('message', onMsg);
              reject(e);
            };
            w.ref();
            w.on('message', onMsg);
            w.on('error', onErr);
            w.postMessage({ id, scene, params, counter, fb: fb.buffer, chunk });
          }),
      ),
    );
    poolStats.parallelRenders++;
    return true;
  } catch {
    broken = true;
    for (const w of workers) void w.terminate();
    workers = [];
    return false;
  }
}

/** terminate all workers (tests / shutdown) */
export async function shutdownPool(): Promise<void> {
  const ws = workers;
  workers = [];
  await Promise.all(ws.map((w) => w.terminate()));
}
