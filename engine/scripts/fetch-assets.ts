// Pre-download the asset cache (misode/mcmeta) for offline use. Usage: node scripts/fetch-assets.ts [version]
import { ensureMcmetaCache, findClientJar } from '../src/assets/sources.ts';
import { AssetStore } from '../src/assets/assets.ts';

const version = process.argv[2] ?? '26.3';
const jar = findClientJar(version);
if (jar) console.log(`client jar found (preferred): ${jar}`);
const dir = await ensureMcmetaCache(version);
const s = await AssetStore.open(version);
const a = s.atlasData();
console.log(`cache: ${dir}\nsource: ${s.source.kind} (${s.source.where})\natlas: ${a.width}x${a.height}, ${a.names.length} textures`);
