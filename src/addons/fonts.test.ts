import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

// Die Overlays laden Webschriften nur aus public/addons/fonts – nie von Google Fonts
const FONT_DIR = path.join(process.cwd(), 'public/addons/fonts');
const RENDERERS = ['alerts/renderer.js', 'goals/render.js', 'chat/render.js'];

function runRenderer(file: string) {
  const head: { id?: string; href?: string }[] = [];
  const document = {
    head: { append: (el: { id?: string; href?: string }) => head.push(el) },
    createElement: () => ({}),
    getElementById: (id: string) => head.find((el) => el.id === id) ?? null,
  };
  const window: Record<string, { FONTS: Record<string, string | null>; loadFont?: (n: string) => void }> = {};
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/addons', file), 'utf8'), { window, document });
  return { api: Object.values(window)[0], head };
}

test('jede Webschrift der Overlays liegt selbst gehostet mit Lizenz vor', () => {
  const css = fs.readFileSync(path.join(FONT_DIR, 'fonts.css'), 'utf8');
  const families = new Set([...css.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1]));
  for (const file of RENDERERS) {
    for (const [name, weights] of Object.entries(runRenderer(file).api.FONTS)) {
      if (weights === null) continue;
      assert.ok(families.has(name), `${name} (${file}) fehlt in fonts.css`);
      assert.ok(fs.existsSync(path.join(FONT_DIR, `LICENSE-${name.toLowerCase().replace(/ /g, '-')}.txt`)), `Lizenz für ${name}`);
    }
  }
  for (const [, file] of css.matchAll(/url\(\.\/([^)]+)\)/g)) assert.ok(fs.existsSync(path.join(FONT_DIR, file)), file);
});

test('loadFont bindet einmal die lokale fonts.css ein, Systemschriften gar nichts', () => {
  for (const file of ['goals/render.js', 'chat/render.js']) {
    const { api, head } = runRenderer(file);
    api.loadFont!('Arial');
    assert.equal(head.length, 0);
    api.loadFont!('Roboto');
    api.loadFont!('Bangers');
    assert.deepEqual(head.map((el) => el.href), ['/addons/fonts/fonts.css']);
  }
});

test('kein Overlay-Code fragt Google Fonts an', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(path.join(process.cwd(), 'public')).filter((f) => /\.(js|css|html)$/.test(f))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fonts\.(googleapis|gstatic)\.com/, file);
  }
});
