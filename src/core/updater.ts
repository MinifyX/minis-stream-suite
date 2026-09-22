import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createLogger } from './log';
import { HttpError, type LocalServer } from './server';

/**
 * Automatische Updates über GitHub Releases.
 *
 * Die installierte App schaut beim Start und dann alle 6 Stunden nach, ob es auf GitHub eine
 * neuere Version gibt, und lädt sie im Hintergrund herunter. Installiert wird beim nächsten
 * Beenden – oder sofort per Klick in der Übersicht. Wo gesucht wird, steht in package.json
 * unter build.publish. Im Entwicklungsmodus (npm start) ist das aus.
 */

const log = createLogger('Update');
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type UpdateState =
  | { state: 'disabled' }
  | { state: 'idle'; checkedAt: number | null }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

let current: UpdateState = { state: 'disabled' };

export function startUpdater(server: LocalServer): void {
  server.route('core', 'GET', '/api/core/update', () => current);

  server.route('core', 'POST', '/api/core/update/check', async () => {
    if (current.state === 'disabled') throw new HttpError(400, 'Updates gibt es nur in der installierten App.');
    await check();
    return current;
  });

  server.route('core', 'POST', '/api/core/update/install', () => {
    if (current.state !== 'ready') throw new HttpError(400, 'Es liegt kein fertiges Update bereit.');
    // Kurz warten, damit die Antwort noch ankommt
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 300);
  });

  if (!app.isPackaged) return;

  current = { state: 'idle', checkedAt: null };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => {
    current = { state: 'checking' };
  });
  autoUpdater.on('update-not-available', () => {
    current = { state: 'idle', checkedAt: Date.now() };
  });
  autoUpdater.on('update-available', (info) => {
    log.info(`Neue Version ${info.version} gefunden – wird heruntergeladen`);
    current = { state: 'downloading', version: info.version, percent: 0 };
  });
  autoUpdater.on('download-progress', (p) => {
    if (current.state === 'downloading') current = { ...current, percent: Math.round(p.percent) };
  });
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`Version ${info.version} ist bereit und wird beim Beenden installiert`);
    current = { state: 'ready', version: info.version };
  });
  autoUpdater.on('error', (err) => {
    // Nur die erste Zeile – der Rest sind lange HTTP-Details
    log.warn('Update-Prüfung fehlgeschlagen:', String(err.message).split(/\r?\n/)[0]);
    current = { state: 'error', message: 'Update-Prüfung fehlgeschlagen (kein Internet oder GitHub nicht erreichbar).' };
  });

  setTimeout(() => void check(), 10_000);
  setInterval(() => void check(), CHECK_EVERY_MS);
}

async function check(): Promise<void> {
  if (current.state === 'downloading' || current.state === 'ready' || current.state === 'checking') return;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // wird über das 'error'-Event angezeigt
  }
}
