import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireTools = createRequire('/opt/trio-tools/package.json');
const { chromium } = requireTools('playwright-core');
const { prepare, render, previousMaskSha256, previousLines } = JSON.parse(readFileSync(0, 'utf8'));
const origin = 'https://canvas-fixture.invalid';
const fontUrl = origin + '/font.ttf';
const font = readFileSync('/input/canvas/PretendardVariable.ttf');
const bundle = readFileSync('/input/canvas/renderer.js', 'utf8');
const fontScheme = 'trio-resource://font/pretendard-variable.ttf';
assert.ok(bundle.includes(fontScheme));
assert.equal(requireTools('playwright-core/package.json').version, '1.63.0');

const browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 20_000 });
const version = browser.version();
let output;
try {
  assert.equal(version, '153.0.8010.12');
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === origin + '/') return route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">',
    });
    if (url === fontUrl) return route.fulfill({ status: 200, contentType: 'font/ttf', body: font });
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin + '/', { timeout: 10_000 });
  await page.evaluate(source => (0, eval)(source), bundle.replaceAll(fontScheme, fontUrl));
  const prepared = await page.evaluate(input => window.SitesCandidate.prepare(input), prepare);
  if (render) {
    // A fresh browser must recreate the product renderer's in-memory prepare state.
    // Compare the source lines and mask before allowing any render in that browser.
    const replayed = createHash('sha256').update(Buffer.from(prepared.mask.maskPngBase64, 'base64')).digest('hex');
    assert.equal(replayed, previousMaskSha256);
    // The prior prepare result arrived through JSON stdout, which omits undefined fields.
    assert.deepEqual(JSON.parse(JSON.stringify(prepared.lines)), previousLines);
    assert.deepEqual(prepared.mask.identity, prepare.maskIdentity);
    output = { rendered: await page.evaluate(input => window.SitesCandidate.render(input), render), replayed };
  } else {
    output = { prepared };
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ...output, browser: { version, sandboxRequested: true, closed: !browser.isConnected() } }));
