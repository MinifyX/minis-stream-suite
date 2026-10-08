// Erzeugt Test-Medien für die Intro-Sequenz: pro Segment eine WAV (48 kHz, 24 bit) und ein
// stummes Video (WebM/VP9, 1920×1080) mit Segmentname, Zähler und einem Blitz auf jedem Beat.
//
//   npm run intro:dummy                      → Dateien nach media/intro (im Projekt, steht in .gitignore)
//   npm run intro:dummy -- --out "C:\Ordner" → anderer Zielordner (z.B. der Medienordner der Suite)
//   npm run intro:dummy -- --wav-only        → nur Audio (ohne ffmpeg)
//
// Prüfen lässt sich damit:
//  - Lücken/Klicks: Der Grundton läuft über alle Loop-Wiederholungen ohne Phasensprung weiter
//    (ganze Schwingungen pro Loop). Jede Lücke wäre als Knacken zu hören.
//  - Versatz: Auf jedem Beat gibt es einen Klick im Ton und einen weißen Balken im Bild.
//
// Video braucht ffmpeg im PATH. Keine weiteren Abhängigkeiten.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(root, 'media', 'intro'));
const wavOnly = args.includes('--wav-only');

const RATE = 48000;
const BPM = 120;
const BEAT = 60 / BPM; // 0,5 s
const BAR = BEAT * 4; // 2 s

/** Segment: Länge in Takten, Grundton (Hz, ganze Schwingungen pro Takt), Farbe */
const SEGMENTS = {
  intro: { bars: 4, freq: 165, color: '0x1d3557' },
  loop1: { bars: 2, freq: 220, color: '0x6a040f' },
  main: { bars: 6, freq: 247, color: '0x2d6a4f' },
  loop2: { bars: 2, freq: 294, color: '0x7b2cbf' },
  outro: { bars: 3, freq: 196, color: '0x3a3a3a' },
};

function writeWav(file, samples) {
  const bytes = 3;
  const data = Buffer.alloc(samples.length * 2 * bytes);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    const int = Math.round(v * 0x7fffff);
    for (let ch = 0; ch < 2; ch++) data.writeIntLE(int, (i * 2 + ch) * bytes, bytes);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // Stereo
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2 * bytes, 28);
  header.writeUInt16LE(2 * bytes, 32);
  header.writeUInt16LE(bytes * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function makeAudio(id, { bars, freq }) {
  const length = Math.round(bars * BAR * RATE);
  const samples = new Float64Array(length);
  const beatLen = Math.round(BEAT * RATE);
  const clickLen = Math.round(0.03 * RATE);
  const isOutro = id === 'outro';
  for (let i = 0; i < length; i++) {
    const t = i / RATE;
    // Ausklang nur im Outro: die letzte Sekunde wird leiser
    const tail = isOutro ? Math.min(1, (length - i) / RATE) : 1;
    let v = 0.18 * Math.sin(2 * Math.PI * freq * t) * tail;
    const inBeat = i % beatLen;
    if (inBeat < clickLen) {
      const beatNo = Math.floor(i / beatLen) % 4;
      const env = Math.exp(-inBeat / (clickLen / 5));
      v += (beatNo === 0 ? 0.55 : 0.3) * env * Math.sin(2 * Math.PI * (beatNo === 0 ? 1760 : 1320) * t);
    }
    samples[i] = v;
  }
  writeWav(path.join(outDir, `${id}.wav`), samples);
  return length / RATE;
}

/** Unter Windows hat ffmpeg meist keine Fontconfig → Schrift direkt angeben */
const FONT = process.platform === 'win32' ? ":fontfile='C\\:/Windows/Fonts/arial.ttf'" : '';

function makeVideo(id, { color }, seconds) {
  const label = id.toUpperCase();
  const filter = [
    // Segmentname und Bildzähler
    `drawtext=text='${label}':fontsize=160:fontcolor=white${FONT}:x=(w-tw)/2:y=(h-th)/2-120`,
    `drawtext=text='Frame %{n}  ·  %{pts\\:hms}':fontsize=56:fontcolor=white@0.85${FONT}:x=(w-tw)/2:y=(h-th)/2+80`,
    // Beat-Blitz: 80 ms weißer Balken auf jedem Beat (dicker auf der 1)
    `drawbox=x=0:y=ih-120:w=iw:h=120:color=white:t=fill:enable='lt(mod(t\\,${BEAT})\\,0.08)'`,
    `drawbox=x=0:y=0:w=iw:h=40:color=yellow:t=fill:enable='lt(mod(t\\,${BAR})\\,0.08)'`,
  ].join(',');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=1920x1080:r=60:d=${seconds}`,
    '-vf', filter,
    '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M', '-row-mt', '1',
    path.join(outDir, `${id}.webm`),
  ], { stdio: 'inherit' });
}

fs.mkdirSync(outDir, { recursive: true });
for (const [id, seg] of Object.entries(SEGMENTS)) {
  const seconds = makeAudio(id, seg);
  process.stdout.write(`${id}: ${seconds.toFixed(2)} s Audio`);
  if (!wavOnly) {
    makeVideo(id, seg, seconds);
    process.stdout.write(' + Video');
  }
  process.stdout.write('\n');
}
console.log(`Fertig → ${outDir}`);
