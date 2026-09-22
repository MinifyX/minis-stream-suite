// Installiert ein Plugin aus src/addons/private/<name>/ in den Plugin-Ordner der Suite.
//
//   npm run plugin:install -- lights
//
// Kopiert den kompilierten Code (dist/addons/private/<name>/*.js) nach
//   %APPDATA%\Mini's Stream Suite\plugins\<name>\
// und die Oberfläche (src/addons/private/<name>/ui/) nach …\plugins\<name>\ui\.
// Danach die Suite neu starten. Mit SUITE_DATA_DIR lässt sich ein anderer Datenordner wählen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
if (!name || !/^[\w-]+$/.test(name)) {
  console.error('Bitte den Namen des Plugins angeben: npm run plugin:install -- lights');
  process.exit(1);
}

const compiled = path.join(root, 'dist', 'addons', 'private', name);
const ui = path.join(root, 'src', 'addons', 'private', name, 'ui');
if (!fs.existsSync(path.join(compiled, 'index.js'))) {
  console.error(`Nicht gefunden: ${path.join(compiled, 'index.js')}\nGibt es src/addons/private/${name}/index.ts? (Das Skript kompiliert vorher automatisch.)`);
  process.exit(1);
}

const dataDir = process.env.SUITE_DATA_DIR || path.join(process.env.APPDATA ?? '', "Mini's Stream Suite");
const target = path.join(dataDir, 'plugins', name);

// Alte Version entfernen, dann frisch kopieren (ohne .map-Dateien)
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(compiled, target, { recursive: true, filter: (src) => !src.endsWith('.map') });
if (fs.existsSync(ui)) fs.cpSync(ui, path.join(target, 'ui'), { recursive: true });

const files = fs.readdirSync(target, { recursive: true }).filter((f) => !fs.statSync(path.join(target, f)).isDirectory());
console.log(`✔ Plugin „${name}“ installiert (${files.length} Dateien) nach:\n  ${target}\nSuite neu starten, damit es geladen wird.`);
