// Shared helper for timing assertions: how much slower than an idle machine are we right now?
// Tests run in parallel (and other processes may load the CPU), so fixed millisecond bounds are
// flaky. loadFactor() times a fixed CPU workload and returns max(1, measured / idle reference).
import os from 'node:os';

const IDLE_REF_MS = 25;

export function loadFactor(): number {
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < 4_000_000; i++) acc += Math.sqrt(i) * 1.0000001;
  const ms = performance.now() - t0;
  if (acc < 0) console.log(acc);
  const cpu = os.loadavg()[0]! / Math.max(1, os.availableParallelism());
  return Math.max(1, ms / IDLE_REF_MS, cpu);
}
