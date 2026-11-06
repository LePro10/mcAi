import { runScript } from './src/core/script.ts';
import { Registry } from './src/core/registry.ts';
import { topLevelHelpers } from './src/core/script-worker.ts';
const reg = Registry.loadDefault();
const code1 = `// helpers
const lerp = (a, b, t) => a + (b - a) * t;
function top(x, z) { return 5 + x * 0; }
const STONE = "stone"; const re = /a\\/b;c/g; const t = \`x;\${1+2}\`;
set(0,0,0,"dirt");
define("pillar", function (p) { for (let y = 0; y < p.h; y++) set(p.x, top(p.x, 0) + y, 0, STONE); return lerp(0, 10, 0.5); });
log(call("pillar", { x: 1, h: 2 }));`;
console.log(topLevelHelpers(code1));
const r1 = await runScript({ code: code1 }, reg);
console.log(r1.error, r1.logs, Object.keys(r1.defines ?? {}));
const r2 = await runScript({ code: 'log(call("pillar", {x: 3, h: 1}), topY(3, 0), topY(3, 0, {includeOwn:false}))', generators: r1.defines, readBox: { min: [-5, -5, -5], max: [5, 10, 5] } }, reg);
console.log(r2.error, r2.logs, r2.entries);
