// The Alexa-like simulator: its browser code bundles, and it renders the card the way the docs say
// Alexa+ does (sandboxed, CSP enforced, model context accepted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAnn } from '../src/annotations.js';
import { buildSim } from '../sim/build.js';
import { Library } from '../src/library.js';

test('the committed sample library (npm run demo) loads, and holds only the fictional notes', () => {
  const lib = new Library(fileURLToPath(new URL('../sample/library', import.meta.url))).snapshot();
  assert.deepEqual(lib.notebooks.map(n => n.name), ['Study notebook', 'Economics']);
  assert.equal(lib.pages.length, 14);
  const highlights = lib.pages.reduce((n, p) => n + parseAnn(p.annRaw).highlights.length, 0);
  assert.equal(highlights, 16);
});

test('the simulator bundles for the browser and hosts the card like Alexa+', async () => {
  const bundle = await buildSim();
  assert.ok(bundle.length > 10000);
  assert.match(bundle, /ui\/initialize/, 'includes the MCP Apps host bridge');
  const src = fs.readFileSync(new URL('../sim/sim.js', import.meta.url), 'utf8');
  assert.match(src, /setAttribute\('sandbox', 'allow-scripts'\)/, 'opaque-origin sandbox without allow-forms or allow-same-origin');
  assert.match(src, /Content-Security-Policy/, 'enforces the card\'s CSP');
  assert.match(src, /updateModelContext/, 'accepts ui/update-model-context');
  const page = fs.readFileSync(new URL('../sim/index.html', import.meta.url), 'utf8');
  assert.match(page, /not Amazon's software/, 'says it is a simulation');
});
