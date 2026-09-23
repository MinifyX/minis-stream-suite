import { app, BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddonManager } from './addons';
import type { ConfigStore } from './config';
import type { CoreConfig } from './coreConfig';
import type { Logger } from './log';
import { HttpError, type LocalServer } from './server';

/**
 * Sicherung der Einstellungen: alles in eine Datei packen (Export) und wieder einspielen (Import).
 *
 * Eine Sicherung ist gepacktes JSON (.suitebackup) mit
 *  - config.json (OHNE Twitch-Logins: die sind mit Windows verschlüsselt und gehen auf einem
 *    anderen PC sowieso nicht, außerdem gehören sie nicht in eine Datei, die man herumschickt)
 *  - windows.json (Fensterpositionen)
 *  - addons/*.json (Einstellungen aller Addons, auch von Plugins)
 *  - addon-data/… (hochgeladene Dateien wie Bilder und Sounds; nicht der Sprachausgabe-Zwischenspeicher)
 *
 * Plugins selbst (Code im Ordner „plugins“) sind nicht dabei, nur ihre Einstellungen.
 */

const FORMAT = 'minis-stream-suite-backup';
const FORMAT_VERSION = 1;
const EXT = 'suitebackup';
/** Automatische Sicherungen: eine pro Tag, nur Einstellungen (ohne Dateien), die letzten X behalten */
const AUTO_KEEP = 10;
const AUTO_EVERY_MS = 24 * 60 * 60 * 1000;
/** Diese Einträge in config.json bleiben beim Import, wie sie sind */
const KEEP_ON_IMPORT: (keyof CoreConfig)[] = ['tokens', 'botTokens'];
/** Ordner in addon-data, die nicht gesichert werden (lassen sich neu erzeugen) */
const SKIP_DATA = ['alerts/tts'];

interface Backup {
  format: typeof FORMAT;
  version: number;
  appVersion: string;
  createdAt: string;
  /** Pfad (relativ zum Datenordner, mit /) → Inhalt der JSON-Datei */
  json: Record<string, unknown>;
  /** Pfad → Dateiinhalt als Base64 */
  files: Record<string, string>;
}

interface Deps {
  server: LocalServer;
  config: ConfigStore<CoreConfig>;
  addons: AddonManager;
  log: Logger;
}

const dataDir = () => app.getPath('userData');
const backupDir = () => path.join(dataDir(), 'backups');
/** Zeitstempel für Dateinamen in Ortszeit, z.B. 2026-09-23_14-05 */
const stamp = () => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}`;
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Alle Dateien eines Ordners (rekursiv), als Pfade relativ zu `root` mit / */
function listFiles(root: string, dir = root): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(root, full);
    return entry.isFile() ? [path.relative(root, full).split(path.sep).join('/')] : [];
  });
}

function collect(withFiles: boolean): Backup {
  const root = dataDir();
  const json: Record<string, unknown> = {};

  const config = readJson(path.join(root, 'config.json')) as Record<string, unknown> | undefined;
  if (config) {
    for (const key of KEEP_ON_IMPORT) delete config[key];
    json['config.json'] = config;
  }
  const windows = readJson(path.join(root, 'windows.json'));
  if (windows !== undefined) json['windows.json'] = windows;
  for (const rel of listFiles(path.join(root, 'addons'))) {
    if (!rel.endsWith('.json') || rel.includes('/')) continue;
    const content = readJson(path.join(root, 'addons', rel));
    if (content !== undefined) json[`addons/${rel}`] = content;
  }

  const files: Record<string, string> = {};
  if (withFiles) {
    for (const rel of listFiles(path.join(root, 'addon-data'))) {
      if (SKIP_DATA.some((skip) => rel.startsWith(`${skip}/`))) continue;
      files[`addon-data/${rel}`] = fs.readFileSync(path.join(root, 'addon-data', rel)).toString('base64');
    }
  }

  return { format: FORMAT, version: FORMAT_VERSION, appVersion: app.getVersion(), createdAt: new Date().toISOString(), json, files };
}

const pack = (backup: Backup) => zlib.gzipSync(JSON.stringify(backup));

function unpack(data: Buffer): Backup {
  let backup: Backup;
  try {
    backup = JSON.parse(zlib.gunzipSync(data).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Das ist keine Sicherung der Stream Suite (Datei kaputt oder falsches Format).');
  }
  if (backup?.format !== FORMAT || typeof backup.json !== 'object' || typeof backup.files !== 'object') {
    throw new HttpError(400, 'Das ist keine Sicherung der Stream Suite.');
  }
  if (backup.version > FORMAT_VERSION) {
    throw new HttpError(400, 'Diese Sicherung stammt aus einer neueren Version der Suite. Bitte erst die Suite aktualisieren.');
  }
  return backup;
}

/** Nur Pfade, die in eine Sicherung gehören – und nie aus dem Datenordner heraus */
function safeTarget(rel: string): string | null {
  const allowed = rel === 'config.json' || rel === 'windows.json'
    || /^addons\/[\w.-]+\.json$/.test(rel)
    || /^addon-data\/[\w.-]+\/.+/.test(rel);
  if (!allowed || rel.split('/').includes('..')) return null;
  const root = path.resolve(dataDir());
  const target = path.resolve(root, rel);
  return target.startsWith(root + path.sep) ? target : null;
}

function summary(backup: Backup) {
  const addonIds = Object.keys(backup.json)
    .filter((k) => k.startsWith('addons/'))
    .map((k) => k.slice('addons/'.length, -'.json'.length));
  const bytes = Object.values(backup.files).reduce((sum, b64) => sum + Math.floor((b64.length * 3) / 4), 0);
  return { createdAt: backup.createdAt, appVersion: backup.appVersion, addons: addonIds, files: Object.keys(backup.files).length, bytes };
}

function writeBackup(file: string, backup: Backup): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pack(backup));
}

/** Einmal am Tag automatisch sichern (nur Einstellungen) und alte automatische Sicherungen aufräumen */
function autoBackup(log: Logger): void {
  try {
    const dir = backupDir();
    const autos = listFiles(dir).filter((f) => f.startsWith('auto_') && f.endsWith(`.${EXT}`)).sort();
    const newest = autos.at(-1);
    if (newest && Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs < AUTO_EVERY_MS) return;
    const backup = collect(false);
    // Frische Installation: noch nichts zu sichern
    if (!Object.keys(backup.json).length) return;
    writeBackup(path.join(dir, `auto_${stamp()}.${EXT}`), backup);
    // Die neue ist dazugekommen → von den alten nur so viele behalten, dass es insgesamt AUTO_KEEP sind
    for (const old of autos.slice(0, Math.max(0, autos.length + 1 - AUTO_KEEP))) fs.rmSync(path.join(dir, old), { force: true });
  } catch (err) {
    log.warn('Automatische Sicherung fehlgeschlagen:', err);
  }
}

export function registerBackup({ server, config, addons, log }: Deps): void {
  const post = (urlPath: string, handler: (body: { withFiles?: boolean }) => unknown) =>
    server.route('core', 'POST', `/api/core/backup${urlPath}`, ({ body }) => handler(body ?? {}));
  const parent = () => BrowserWindow.getFocusedWindow() ?? undefined;

  autoBackup(log);
  const timer = setInterval(() => autoBackup(log), 60 * 60 * 1000);
  app.on('before-quit', () => clearInterval(timer));

  server.route('core', 'GET', '/api/core/backup', () => {
    const autos = listFiles(backupDir()).filter((f) => f.endsWith(`.${EXT}`)).sort();
    return { folder: backupDir(), count: autos.length, newest: autos.at(-1) ?? null };
  });

  /** Sicherung speichern – Windows fragt, wohin */
  post('/export', async ({ withFiles = true }) => {
    const options = {
      title: 'Sicherung speichern',
      defaultPath: path.join(app.getPath('documents'), `Stream-Suite-Sicherung_${stamp()}.${EXT}`),
      filters: [{ name: 'Stream-Suite-Sicherung', extensions: [EXT] }],
    };
    const win = parent();
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };
    const backup = collect(withFiles);
    writeBackup(result.filePath, backup);
    log.info(`Sicherung gespeichert: ${result.filePath}`);
    return { saved: true, file: result.filePath, ...summary(backup) };
  });

  /**
   * Sicherung einspielen: Datei wählen, nachfragen, vorher den jetzigen Stand sichern,
   * Dateien schreiben und die Suite neu starten (damit alle Addons die neuen Einstellungen laden).
   */
  post('/import', async () => {
    const openOptions = {
      title: 'Sicherung einspielen',
      defaultPath: app.getPath('documents'),
      filters: [{ name: 'Stream-Suite-Sicherung', extensions: [EXT] }],
      properties: ['openFile' as const],
    };
    const win = parent();
    const picked = win ? await dialog.showOpenDialog(win, openOptions) : await dialog.showOpenDialog(openOptions);
    if (picked.canceled || !picked.filePaths[0]) return { imported: false };

    const backup = unpack(fs.readFileSync(picked.filePaths[0]));
    const info = summary(backup);
    const when = new Date(info.createdAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
    const confirmOptions = {
      type: 'warning' as const,
      title: 'Sicherung einspielen?',
      message: `Sicherung vom ${when} einspielen?`,
      detail: [
        `Version ${info.appVersion} · ${info.addons.length} Addon-Einstellungen · ${info.files} Dateien`,
        '',
        'Deine jetzigen Einstellungen werden ersetzt. Vorher legt die Suite automatisch eine Sicherung davon an (Ordner „backups“).',
        'Deine Twitch-Anmeldung und der Bot bleiben verbunden.',
        '',
        'Die Suite startet danach neu.',
      ].join('\n'),
      buttons: ['Einspielen und neu starten', 'Abbrechen'],
      defaultId: 0,
      cancelId: 1,
    };
    const answer = win ? await dialog.showMessageBox(win, confirmOptions) : await dialog.showMessageBox(confirmOptions);
    if (answer.response !== 0) return { imported: false };

    // Ziele vorher prüfen, damit nicht halb eingespielt wird
    const targets = [...Object.keys(backup.json), ...Object.keys(backup.files)].map((rel) => [rel, safeTarget(rel)] as const);
    const bad = targets.find(([, target]) => !target);
    if (bad) throw new HttpError(400, `Ungültiger Eintrag in der Sicherung: ${bad[0]}`);

    const safety = path.join(backupDir(), `vor-import_${stamp()}.${EXT}`);
    writeBackup(safety, collect(true));

    // Addons beenden, damit keins beim Herunterfahren alte Einstellungen über die neuen schreibt
    await addons.stopAll();

    for (const [rel, content] of Object.entries(backup.json)) {
      let data = content;
      if (rel === 'config.json' && data && typeof data === 'object') {
        const keep = Object.fromEntries(KEEP_ON_IMPORT.map((key) => [key, config.get(key)]));
        data = { ...(data as object), ...keep };
      }
      const target = safeTarget(rel)!;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(data, null, 2));
    }
    for (const [rel, b64] of Object.entries(backup.files)) {
      const target = safeTarget(rel)!;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(b64, 'base64'));
    }
    log.info(`Sicherung eingespielt (${picked.filePaths[0]}), vorheriger Stand: ${safety}. Starte neu …`);

    // Kurz warten, damit die Antwort noch bei der Oberfläche ankommt. exit statt quit: nichts soll mehr speichern.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 300);
    return { imported: true, safety };
  });

  post('/open-folder', () => {
    fs.mkdirSync(backupDir(), { recursive: true });
    void shell.openPath(backupDir());
  });
}
