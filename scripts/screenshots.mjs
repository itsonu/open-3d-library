// Regenerates the README/docs screenshots in docs/images/: `npm run screenshots`.
// Builds the app and serves the same static preview the e2e tests use (software WebGL in headless Chromium).
import {build, preview} from 'vite';
import {chromium} from '@playwright/test';
import {writeFileSync} from 'node:fs';

const OUT = 'docs/images/', LIMIT = 400e3, only = process.argv.slice(2);   // optional filter: npm run screenshots -- meadow
await build({logLevel: 'warn'});
const server = await preview({logLevel: 'warn', preview: {host: '127.0.0.1', port: 4174, strictPort: true}});
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']});

const frames = (page, n = 30) => page.evaluate(n => new Promise(r => { const f = () => --n > 0 ? requestAnimationFrame(f) : r(); f(); }), n);
// PNG handles noisy 3D scenes badly: if a shot is over LIMIT, drop colour depth (6, then 5 bits per channel; below that the sky bands visibly) until it fits
const quantize = (page, png, bits) => page.evaluate(async ([b64, bits]) => {
  const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
  const c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d'); g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), s = 1 << (8 - bits);
  for(let i = 0; i < d.data.length; i++) if(i % 4 < 3) d.data[i] = Math.min(255, Math.floor(d.data[i] / s) * s + s / 2);
  g.putImageData(d, 0, 0);
  return [...new Uint8Array(await (await c.convertToBlob({type: 'image/png'})).arrayBuffer())];
}, [png.toString('base64'), bits]).then(a => Buffer.from(a));
async function shot(name, size, fn, ctx = {}){
  if(only.length && !only.some(o => name.includes(o))) return;
  const context = await browser.newContext({viewport: size, ...ctx}), page = await context.newPage();
  page.on('pageerror', e => console.error(name, e.message));
  await page.goto(base);
  await page.locator('.card').first().waitFor();
  await page.waitForFunction(() => [...document.images].every(i => i.complete));
  await fn(page);
  await frames(page);
  await page.evaluate(() => document.activeElement?.blur());
  let png = await page.screenshot(), bits = 8;
  for(const b of [6, 5]) if(png.length > LIMIT) png = await quantize(page, png, bits = b);
  writeFileSync(OUT + name, png);
  console.log('wrote', OUT + name, Math.round(png.length / 1e3) + ' KB', bits < 8 ? `(${bits}-bit colour)` : '');
  await context.close();
}
async function open(page, id){
  await page.locator(`.card[data-id="${id}"]`).click();
  await page.waitForFunction(() => window.mv.meshes.length > 0 && document.querySelector('#load').hidden && window.mv.renderer.info.programs?.length > 0, null, {timeout: 60_000});
  await frames(page);
}
const wide = {width: 1440, height: 900};
try{
  await shot('library-grid.png', wide, async () => {});
  await shot('viewer-fox.png', wide, async page => { await open(page, 'animal-fox'); await page.waitForTimeout(1000); });
  await shot('viewer-chair.png', wide, async page => { await open(page, 'material-sheen-chair'); await page.waitForTimeout(1000); });
  await shot('meadow.png', {width: 1024, height: 640}, async page => {
    await open(page, 'animal-fox');
    await page.locator('#bScene').click();
    await page.locator('#scenePanel [data-kind="meadow"]').click();
    await page.waitForFunction(() => window.mv.meadow, null, {timeout: 120_000});
    await page.keyboard.press('Escape');            // close the Scene panel
    await page.waitForTimeout(6000);                // let grass, wildlife and clouds settle
  });
  await shot('mobile-viewer.png', {width: 375, height: 812}, async page => { await open(page, 'material-sheen-chair'); await page.waitForTimeout(1000); }, {deviceScaleFactor: 2, isMobile: true, hasTouch: true});
} finally {
  await browser.close();
  await server.close();
}
