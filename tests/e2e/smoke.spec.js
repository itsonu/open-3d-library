import {test as base, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

const fx = n => readFileSync(new URL(`../fixtures/${n}`, import.meta.url));
const catalog = JSON.parse(readFileSync(new URL('../../public/catalog.json', import.meta.url), 'utf8')).items;

// Console messages that are not failures. Empty on purpose: the app must run clean. Add a RegExp here only with a reason.
const ALLOWED_CONSOLE_ERRORS = [];

// Every test fails on any console error or uncaught page error.
const test = base.extend({
  page: async ({page}, use) => {
    const errors = [];
    page.on('console', m => { if(m.type() === 'error' && !ALLOWED_CONSOLE_ERRORS.some(re => re.test(m.text()))) errors.push('console: ' + m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await use(page);
    expect(errors, 'console and page errors').toEqual([]);
  },
});

const frames = (page, n = 3) => page.evaluate(n => new Promise(r => { const f = () => --n > 0 ? requestAnimationFrame(f) : r(); f(); }), n);
// a model is mounted, the loading overlay is gone and at least one frame has been drawn (so shaders are compiled)
async function ready(page){
  await page.waitForFunction(() => window.mv?.meshes.length > 0 && document.querySelector('#load').hidden && window.mv.renderer.info.programs?.length > 0, null, {timeout: 45_000});
  await frames(page);
}
const brokenPrograms = page => page.evaluate(() => window.mv.renderer.info.programs.filter(p => p.diagnostics?.runnable === false).map(p => `${p.name}: ${p.diagnostics.programLog || ''}`));
const open = async (page, id) => { await page.goto('./#' + id); await ready(page); };
const openLocal = (page, name, data) => page.evaluate(({name, data}) => window.mv.openFiles([{path: name, file: new File([new Uint8Array(data)], name)}]), {name, data: [...data]});

test.describe('library', () => {
  test.beforeEach(async ({page}) => { await page.goto('./'); await expect(page.locator('.card')).toHaveCount(9); });

  test('title, cards, chips with counts, licence badges', async ({page}) => {
    await expect(page).toHaveTitle('Open 3D Library');
    const chips = await page.locator('#chips .chip').evaluateAll(cs => cs.map(c => [c.firstChild.textContent.trim(), +c.querySelector('.n').textContent]));
    expect(chips[0]).toEqual(['All', 9]);
    expect(chips.length).toBeGreaterThan(2);
    expect(chips.slice(1).reduce((s, c) => s + c[1], 0)).toBe(9);
    const lic = await page.locator('.card .lic').allTextContents();
    expect(lic).toHaveLength(9);
    for(const l of lic) expect(l.trim()).not.toBe('');
  });

  test('search filters cards', async ({page}) => {
    await page.locator('#q').fill('fox');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('Fox');
    await page.locator('#q').fill('zzzz');
    await expect(page.getByText('Nothing matches.')).toBeVisible();
  });

  test('list view toggle', async ({page}) => {
    await expect(page.locator('#lib .grid')).toBeVisible();
    await page.locator('label[title="List view"]').click();
    await expect(page.locator('#lib .list')).toBeVisible();
    await expect(page.locator('#lib .lh')).toBeVisible();
    await expect(page.locator('.card')).toHaveCount(9);
    await page.locator('label[title="Grid view"]').click();
    await expect(page.locator('#lib .grid')).toBeVisible();
  });

  test('"/" focuses search', async ({page}) => {
    await page.keyboard.press('/');
    await expect(page.locator('#q')).toBeFocused();
  });
});

// extra checks per example, on top of "mounts and every shader compiles"
const EXTRA = {
  'animal-fox': async page => {
    expect(await page.evaluate(() => window.mv.meshes.some(m => m.isSkinnedMesh))).toBe(true);
    await expect(page.locator('#inspBody [data-clip]')).toHaveCount(3);
  },
  'test-morph-stress': async page => {
    expect(await page.evaluate(() => window.mv.meshes.some(m => m.morphTargetInfluences?.length > 0))).toBe(true);
  },
  'test-obj-spot': async page => {
    await expect.poll(() => page.evaluate(() => window.mv.meshes.some(m => [].concat(m.material).some(x => x.map?.image)))).toBe(true);
  },
};

test.describe('examples open from the library', () => {
  test.beforeEach(({}, info) => { info.setTimeout(90_000); });
  for(const it of catalog) test(it.id, async ({page}) => {
    await page.goto('./');
    await page.locator(`.card[data-id="${it.id}"]`).click();
    await ready(page);
    await expect(page.locator('#title')).toContainText(it.name);
    await expect(page.locator('#err')).toBeHidden();
    expect(await brokenPrograms(page)).toEqual([]);
    await EXTRA[it.id]?.(page);
  });
});

test.describe('local files', () => {
  test('a valid glTF opens', async ({page}) => {
    await page.goto('./');
    await openLocal(page, 'triangle.gltf', fx('triangle.gltf'));
    await ready(page);
    await expect(page.locator('#title')).toContainText('triangle');
    expect(await page.evaluate(() => window.mv.locals.length)).toBe(1);
    expect(await brokenPrograms(page)).toEqual([]);
  });

  test('an invalid file shows an error panel and Back to library works', async ({page}) => {
    await page.goto('./');
    await openLocal(page, 'bad.glb', fx('bad.glb'));
    const err = page.locator('#err[role="alert"]');
    await expect(err).toBeVisible();
    await expect(err).toContainText("Couldn't open this file");
    await expect(page.locator('#errFile')).toHaveText('bad.glb');
    await expect(page.locator('#load')).toBeHidden();
    await err.getByRole('button', {name: 'Back to library'}).click();
    await expect(page.locator('#lib')).toBeVisible();
    await expect(err).toBeHidden();
  });

  test('an unknown hash shows "Asset not found"', async ({page}) => {
    await page.goto('./#no-such-asset');
    await expect(page.locator('#notice')).toContainText('Asset not found: no-such-asset');
    await expect(page.locator('#lib')).toBeVisible();
  });

  test('markup in file names is escaped (XSS)', async ({page}) => {
    await page.goto('./');
    await openLocal(page, 'xss.gltf', fx('xss/xss.gltf'));
    await ready(page);
    // three's GLTFLoader sanitises node names (spaces -> _, dots dropped); the markup must still show as text
    await expect(page.locator('#meshes button').first()).toHaveText('<img_src=x_onerror="window__xss=1">');
    await frames(page, 10);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  });
});

test.describe('viewer keyboard', () => {
  test('"w" toggles wireframe, Escape returns to the library', async ({page}) => {
    await open(page, 'animal-fox');
    const wire = page.getByRole('radio', {name: 'Wireframe'});
    await expect(wire).not.toBeChecked();
    await page.keyboard.press('w');
    await expect(wire).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.locator('#lib')).toBeVisible();
    await expect(page.locator('#viewer')).toBeHidden();
  });
});

test.describe('phone', () => {
  test.use({viewport: {width: 375, height: 812}, isMobile: true, hasTouch: true});
  test('canvas fills at least 60% of the screen with the details sheet closed', async ({page}) => {
    await open(page, 'animal-fox');
    await expect(page.locator('#viewer')).toHaveClass(/noinsp/);
    await expect.poll(() => page.evaluate(() => window.mv.renderer.domElement.getBoundingClientRect().height / innerHeight)).toBeGreaterThanOrEqual(.6);
  });
});

test.describe('scene', () => {
  test('the 3D meadow runs without shader or console errors', async ({page}, info) => {
    info.setTimeout(240_000);   // software WebGL: the heaviest path in the app
    await open(page, 'animal-fox');
    await page.locator('#bScene').click();
    await page.locator('#scenePanel [data-kind="meadow"]').click();
    await page.waitForFunction(() => window.mv.meadow, null, {timeout: 120_000});
    await page.waitForTimeout(3000);
    await frames(page);
    expect(await brokenPrograms(page)).toEqual([]);
  });
});
