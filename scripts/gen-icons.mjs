// usage: node scripts/gen-icons.mjs [repo] [--check]  (LUCIDE_DIR = lucide-react/dist/esm/icons, Standard: ../UwUSuite-Design)
// Sammelt data-icon="x" / 'data-icon': 'x' / icon('x') aus public/ und schreibt die Lucide-Pfade in public/app/ui.js
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.';
const check = process.argv.includes('--check');
const LUCIDE = process.env.LUCIDE_DIR ?? path.resolve(root, '../UwUSuite-Design/node_modules/lucide-react/dist/esm/icons');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(html|js)$/.test(f)) files.push(f);
  }
})(path.join(root, 'public'));
const names = new Set();
const where = {};
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/data-icon["']?\s*[=:]\s*["']([a-z0-9-]+)["']|\bicon\(\s*'([a-z0-9-]+)'|\bicon:\s*'([a-z0-9-]+)'/g)) {
    const n = m[1] ?? m[2] ?? m[3];
    names.add(n);
    (where[n] ??= new Set()).add(path.relative(root, f));
  }
}
const out = {};
const bad = [];
for (const n of [...names].sort()) {
  const file = path.join(LUCIDE, `${n}.mjs`);
  if (!fs.existsSync(file)) { bad.push(`${n} (${[...where[n]].join(', ')})`); continue; }
  let src = fs.readFileSync(file, 'utf8');
  for (let a; (a = src.match(/export \{ default \} from '\.\/([a-z0-9-]+\.mjs)'/)) && !src.includes('__iconData');) src = fs.readFileSync(path.join(LUCIDE, a[1]), 'utf8');
  const obj = src.slice(src.indexOf('const __iconData = ') + 19, src.indexOf('};\n__iconData') + 1);
  const data = Function(`return (${obj})`)();
  out[n] = data.node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
}
if (bad.length) console.log('Unbekannte Lucide-Namen:\n  ' + bad.join('\n  '));
console.log(`${Object.keys(out).length} Icons`);
if (check) process.exit(bad.length ? 1 : 0);
const ui = path.join(root, 'public/app/ui.js');
const text = fs.readFileSync(ui, 'utf8');
const body = Object.entries(out).map(([k, v]) => `    ${JSON.stringify(k)}: '${v}',`).join('\n');
const next = text.replace(/(\/\/ icons:start\n)[\s\S]*?(\n\s*\/\/ icons:end)/, `$1  const ICONS = {\n${body}\n  };$2`);
fs.writeFileSync(ui, next);
