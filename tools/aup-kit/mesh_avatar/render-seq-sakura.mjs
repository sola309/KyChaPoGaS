// render-seq-sakura.mjs <project> <out_dir> <motion.json> : さくら再現(KyChaPoGaS project 37)用。アバターを 1 コマずつ透明 PNG で描き出す(manual で 1/60 秒ずつ進める = 決まった絵)。
// motion.json = {frames: N, warmup: 秒, crop: [x, y, w, h], params: [{...} × N]}(コマごとの数値。省略した数値は既定)
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [projectArg, outArg, motionArg] = process.argv.slice(2);
const project = await realpath(resolve(projectArg)), out = resolve(outArg);
const rig = JSON.parse(await readFile(resolve(project, 'rig.json'), 'utf8'));
const motion = JSON.parse(await readFile(resolve(motionArg), 'utf8'));
const built = resolve(project, 'built'), assets = {};
const asset = async (name) => { assets[name] = `data:${name.endsWith('.png') ? 'image/png' : 'application/json'};base64,${(await readFile(resolve(built, name))).toString('base64')}`; };
await asset('layers.json');
const layers = JSON.parse(await readFile(resolve(built, 'layers.json'), 'utf8'));
await Promise.all(['base', 'hairmask', ...Object.keys(layers.layers)].map((n) => asset(`${n}.png`)));
await mkdir(out, { recursive: true });
const W = rig.image.width, H = rig.image.height;
const server = await createServer({ root, configFile: false, publicDir: false, appType: 'custom', cacheDir: 'node_modules/.vite-seq', optimizeDeps: { noDiscovery: true, entries: [] },
  plugins: [{ name: 'seq-page', configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url !== '/__seq__') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body style="margin:0;background:transparent"><canvas id="avatar"></canvas></body></html>'); }); } }],
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/*', (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
  await page.goto(`${origin}/__seq__`);
  await page.evaluate(async ({ rig, assets, W, H, first, warmup }) => {
    const { createMeshAvatar, PARAMS } = await import('/packages/runtime/src/index.ts');
    const c = document.getElementById('avatar'); c.style.width = `${W}px`; c.style.height = `${H}px`;
    window.DEF = Object.fromEntries(PARAMS.map((p) => [p.id, p.def]));
    window.AV = await createMeshAvatar(c, { rig, assets, manual: true, padTop: 0, padSide: 0 });
    AV.setAutoIdle(false); AV.setAutoMotion(false);
    AV.setParameters({ ...DEF, ...first }); AV.advance(warmup, 60);
    window.CROP = document.createElement('canvas');
  }, { rig, assets, W, H, first: motion.params[0], warmup: motion.warmup ?? 1 });
  const [cx, cy, cw, ch] = motion.crop ?? [0, 0, W, H];
  for (let i = 0; i < motion.frames; i++) {
    const url = await page.evaluate(({ p, cx, cy, cw, ch }) => {
      AV.setParameters({ ...DEF, ...p }); AV.advance(1 / 60, 60);
      const src = document.getElementById('avatar'); CROP.width = cw; CROP.height = ch;
      const g = CROP.getContext('2d'); g.clearRect(0, 0, cw, ch);
      g.drawImage(src, cx * src.width / src.clientWidth, cy * src.height / src.clientHeight, cw * src.width / src.clientWidth, ch * src.height / src.clientHeight, 0, 0, cw, ch);
      return CROP.toDataURL('image/png');
    }, { p: motion.params[i], cx, cy, cw, ch });
    await writeFile(resolve(out, `f_${String(i).padStart(4, '0')}.png`), Buffer.from(url.split(',')[1], 'base64'));
  }
  if (errs.length) throw new Error(errs.join('\n'));
  console.log(`wrote ${motion.frames} frames to ${out}`);
} finally { await browser?.close(); await server.close(); }
