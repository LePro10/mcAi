import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const f of files) {
  const svg = fs.readFileSync(f, 'utf8');
  const m = /width="(\d+)" height="(\d+)"/.exec(svg);
  const w = Math.min(1400, Number(m?.[1] ?? 800));
  const h = Math.min(1400, Number(m?.[2] ?? 600));
  await page.setViewportSize({ width: w + 20, height: h + 20 });
  await page.setContent(`<body style="margin:10px;background:#12141a">${svg}</body>`);
  const out = f.replace(/\.svg$/, '.png');
  await page.screenshot({ path: out });
  console.log('wrote', out, w + 'x' + h);
}
await browser.close();
