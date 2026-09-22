// Baut die Browser-Erweiterung "Mini's Chat" für Chrome und Firefox.
//   npm run build:extension
// Ergebnis: browser-extension/dist/chrome, …/firefox und je eine .zip-Datei.
//
// Die Regeln (wer Markdown/Farben darf, welche Belohnungen stumm sind) werden aus den
// Einstellungen der Stream Suite übernommen – nach Änderungen einfach neu bauen.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcDir = path.join(here, 'src');
const distDir = path.join(here, 'dist');
const VERSION = '1.0.0';
// Für welchen Kanal? npm run build:extension -- --channel deinkanal  (oder Umgebungsvariable MSS_CHANNEL)
const channelArg = process.argv.find((a, i) => process.argv[i - 1] === '--channel') ?? process.argv.find((a) => a.startsWith('--channel='))?.slice(10);
const CHANNEL = String(channelArg || process.env.MSS_CHANNEL || '').replace(/^@/, '').toLowerCase();
if (!/^[a-z0-9_]{3,25}$/.test(CHANNEL)) {
  console.error('Bitte den Twitch-Kanal angeben: npm run build:extension -- --channel deinkanal');
  process.exit(1);
}

// ------------------------------------------------------------------ Einstellungen aus der Suite

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function suiteDir() {
  const appData = process.env.APPDATA || '';
  return ["Mini's Stream Suite", 'minis-stream-suite'].map((n) => path.join(appData, n)).find((d) => fs.existsSync(d)) ?? null;
}

function buildConfig() {
  const config = {
    channel: CHANNEL,
    markdown: { enabled: true, minRole: 'everyone' },
    colors: { enabled: true, minRole: 'subscriber' },
    hiddenRewardIds: [],
  };
  const dir = suiteDir();
  if (!dir) {
    console.log('ℹ Keine Einstellungen der Stream Suite gefunden – nehme Standardwerte.');
    return config;
  }
  const chat = readJson(path.join(dir, 'addons', 'chat.json'));
  if (chat?.markdown) config.markdown = { enabled: chat.markdown.enabled !== false, minRole: chat.markdown.minRole || 'everyone' };
  if (chat?.colors) config.colors = { enabled: chat.colors.enabled !== false, minRole: chat.colors.minRole || 'subscriber' };

  // Stumme Belohnungen (wie im Alert-Filter), damit auch dieser Chat keine Spoiler zeigt
  if (chat?.respectAlertFilter !== false) {
    const alerts = readJson(path.join(dir, 'addons', 'alerts.json'));
    const cp = readJson(path.join(dir, 'addons', 'channelpoints.json'));
    const own = alerts?.rewards ?? {};
    const hidden = new Set(Object.entries(own).filter(([, r]) => r?.alert === false).map(([id]) => id));
    const muted = new Set(alerts?.mutedGroups ?? []);
    for (const group of cp?.groups ?? []) {
      if (!muted.has(group.id)) continue;
      for (const id of group.rewardIds ?? []) if (own[id]?.alert !== true) hidden.add(id);
    }
    config.hiddenRewardIds = [...hidden];
  }
  console.log(`✔ Einstellungen übernommen: Markdown ${config.markdown.enabled ? `ab ${config.markdown.minRole}` : 'aus'}, `
    + `Farben ${config.colors.enabled ? `ab ${config.colors.minRole}` : 'aus'}, ${config.hiddenRewardIds.length} stumme Belohnung(en).`);
  return config;
}

// ------------------------------------------------------------------ Symbol (PNG, selbst gezeichnet)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Lila-pinkes abgerundetes Quadrat mit weißer Sprechblase und drei Punkten */
function makeIcon(size) {
  const S = 4; // Kantenglättung durch Mehrfach-Abtastung
  const px = Buffer.alloc(size * size * 4);
  const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
    const cx = Math.max(x0 + r, Math.min(x, x1 - r));
    const cy = Math.max(y0 + r, Math.min(y, y1 - r));
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
  };
  const inTri = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const u = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / d;
    const v = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / d;
    return u >= 0 && v >= 0 && u + v <= 1;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          if (!inRoundRect(u, v, 0, 0, 1, 1, 0.22)) continue;
          const t = (u + v) / 2;
          let cr = 145 + (255 - 145) * t, cg = 70 + (79 - 70) * t, cb = 255 + (216 - 255) * t;
          const bubble = inRoundRect(u, v, 0.2, 0.24, 0.8, 0.66, 0.12) || inTri(u, v, [0.3, 0.6], [0.46, 0.6], [0.28, 0.8]);
          if (bubble) {
            cr = cg = cb = 255;
            for (const dx of [0.36, 0.5, 0.64]) {
              if ((u - dx) ** 2 + (v - 0.45) ** 2 <= 0.055 ** 2) { cr = 145; cg = 70; cb = 255; }
            }
          }
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      const cover = a / n;
      px[i] = cover ? (r / (a / 255)) : 0;
      px[i + 1] = cover ? (g / (a / 255)) : 0;
      px[i + 2] = cover ? (b / (a / 255)) : 0;
      px[i + 3] = cover;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ Manifeste

function manifest(target) {
  const icons = { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' };
  const m = {
    manifest_version: 3,
    name: "Mini's Chat für Twitch",
    short_name: "Mini's Chat",
    version: VERSION,
    description: `Eigener Chat im Kanal ${CHANNEL}: 7TV-, BTTV- und FFZ-Emotes, Markdown und Farben.`,
    icons,
    permissions: ['storage'],
    host_permissions: [
      'https://7tv.io/*',
      'https://api.betterttv.net/*',
      'https://api.frankerfacez.com/*',
      'https://api.ivr.fi/*',
    ],
    content_scripts: [{
      matches: ['https://www.twitch.tv/*', 'https://twitch.tv/*'],
      js: ['config.js', 'render.js', 'content.js'],
      css: ['content.css'],
      run_at: 'document_idle',
    }],
  };
  if (target === 'firefox') {
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = {
      gecko: {
        id: 'minis-chat@minifyx',
        strict_min_version: '115.0',
        // Die Erweiterung sammelt keine Daten (verlangt Mozilla bei neuen Erweiterungen)
        data_collection_permissions: { required: ['none'] },
      },
    };
  } else {
    m.background = { service_worker: 'background.js' };
  }
  return m;
}

// ------------------------------------------------------------------ Bauen

const config = buildConfig();
const configJs = `// Automatisch erzeugt von build.mjs (${new Date().toLocaleString('de-DE')})\nglobalThis.MSS_CONFIG = ${JSON.stringify(config, null, 2)};\n`;
const renderJs = fs.readFileSync(path.join(root, 'public', 'addons', 'chat', 'render.js'), 'utf8');
const icons = Object.fromEntries([16, 32, 48, 128].map((s) => [s, makeIcon(s)]));

fs.rmSync(distDir, { recursive: true, force: true });
for (const target of ['chrome', 'firefox']) {
  const out = path.join(distDir, target);
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  for (const file of ['content.js', 'content.css', 'background.js']) fs.copyFileSync(path.join(srcDir, file), path.join(out, file));
  fs.writeFileSync(path.join(out, 'render.js'), renderJs);
  fs.writeFileSync(path.join(out, 'config.js'), configJs);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2));
  for (const [s, png] of Object.entries(icons)) fs.writeFileSync(path.join(out, 'icons', `${s}.png`), png);

  const zip = path.join(distDir, `minis-chat-${target}-${VERSION}.zip`);
  try {
    // Windows 10/11 bringt tar mit, das auch .zip kann
    execFileSync('tar', ['-a', '-c', '-f', zip, '-C', out, '.'], { stdio: 'ignore' });
    console.log(`✔ ${path.relative(root, zip)}`);
  } catch {
    console.log(`✔ ${path.relative(root, out)} (zip konnte nicht erstellt werden – Ordner selbst zippen)`);
  }
}

// Nur zum Testen: alles in einer Datei, die man direkt in eine Seite laden kann
fs.writeFileSync(path.join(distDir, 'test-bundle.js'), [configJs, renderJs, fs.readFileSync(path.join(srcDir, 'content.js'), 'utf8')].join('\n;\n'));
console.log(`Fertig. Kanal: ${CHANNEL}, Version ${VERSION}.`);
