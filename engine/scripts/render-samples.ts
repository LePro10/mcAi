// Renders the sample images in docs/renders (our renders of our test builds).
// Usage: node scripts/render-samples.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetStore } from '../src/assets/assets.ts';
import { renderVolume, contactSheet, renderLayers } from '../src/render/render.ts';
import { shutdownPool } from '../src/render/pool.ts';
import { SimBackend } from '../src/sim/sim-backend.ts';
import type { BlockVolume } from '../src/core/types.ts';
import { cottage, tower, showcase, bigScene } from './sample-builds.ts';

const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'renders');
mkdirSync(out, { recursive: true });
const assets = await AssetStore.open();
const save = async (name: string, p: Promise<Buffer>) => {
  const t = Date.now();
  writeFileSync(join(out, name), await p);
  console.log(`${name}  ${Date.now() - t} ms`);
};
const HD = { width: 1024, height: 768, supersample: 2 };

const c = cottage();
await save('cottage_iso_se.png', renderVolume(c, assets, { ...HD, view: 'iso_se', labels: true }));
await save('cottage_contact_sheet.png', contactSheet(c, assets, { ...HD }));
await save('cottage_front_highlight.png', renderVolume(c, assets, { ...HD, view: 'front', labels: true, highlight: { min: [6, 63, 5], max: [16, 73, 13] } }));
await save('cottage_orbit.png', renderVolume(c, assets, { ...HD, view: 'orbit', yaw: 155, pitch: 18, focus: { min: [0, 62, 2], max: [31, 74, 31] } }));
await save('cottage_sunset.png', renderVolume(c, assets, { ...HD, view: 'iso_sw', time: 'sunset' }));
await save('cottage_night.png', renderVolume(c, assets, { ...HD, view: 'iso_se', time: 'night' }));
await save('cottage_top.png', renderVolume(c, assets, { ...HD, view: 'top', labels: true }));
await save('cottage_flat_fallback.png', renderVolume(c, null, { ...HD, view: 'iso_se', labels: true, title: 'NO ASSETS (FALLBACK)' }));
await save('cottage_layers.png', renderLayers(c, assets, [63, 64, 66, 69], { cell: 12 }));
await save('tower_orbit.png', renderVolume(tower(), assets, { ...HD, view: 'orbit', yaw: 160, pitch: 22 }));
await save('block_entities_showcase.png', renderVolume(showcase(), assets, { ...HD, view: 'orbit', yaw: 160, pitch: 28 }));
await save('village_96x64x96.png', renderVolume(bigScene(), assets, { width: 1024, height: 768, view: 'iso_se', labels: true }));

// simulation terrain
const sim = new SimBackend({ seed: 1 });
async function terrain(x: number, z: number, S = 48): Promise<{ v: BlockVolume; biome: string }> {
  const hm = await sim.heightmap(x - S, z - S, x + S - 1, z + S - 1, 'ocean_floor');
  let lo = 999, hi = -999;
  for (const h of hm.data) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  const v = await sim.getBlocks({ min: [x - S, Math.max(-64, lo - 4), z - S], max: [x + S - 1, Math.min(319, hi + 14), z + S - 1] });
  return { v, biome: (await sim.biomes({ min: [x, 64, z], max: [x, 64, z] }, 1)).palette[0] };
}
for (const [name, x, z] of [['sim_plains_lake', 0, 0], ['sim_forest', -169, 91], ['sim_cherry_grove', 1756, -1174], ['sim_snowy_taiga', 400, 599], ['sim_desert', 1126, -1373]] as [string, number, number][]) {
  const { v, biome } = await terrain(x, z);
  await save(`${name}.png`, renderVolume(v, assets, { width: 1024, height: 768, view: 'iso_se', biome, labels: true, title: biome.replace('minecraft:', '').toUpperCase() }));
}
await shutdownPool();
