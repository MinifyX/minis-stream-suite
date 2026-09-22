import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import type { ConfigStore } from './config';
import type { CoreConfig } from './coreConfig';
import { HttpError, type LocalServer } from './server';

/**
 * Alles rund um die installierte Windows-App: Hauptfenster, Symbol im Infobereich (Tray),
 * „Schließen = im Hintergrund weiterlaufen“ und Autostart mit Windows.
 *
 * Die Suite soll während des Streams immer laufen (Overlays, Commands, Bot …). Deshalb
 * schließt das X standardmäßig nur das Fenster, beendet wird über das Tray-Menü.
 */

const TITLE = "Mini's Stream Suite";
/** Mit diesem Argument startet Windows die Suite beim Anmelden → dann ohne Fenster */
const HIDDEN_ARG = '--hidden';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let hintShown = false;

interface Options {
  config: ConfigStore<CoreConfig>;
  server: LocalServer;
}

const iconPath = () => path.join(app.getAppPath(), 'public', 'app', 'icon.png');

export function startDesktop({ config, server }: Options): void {
  app.on('before-quit', () => {
    quitting = true;
  });

  const open = () => showMainWindow(server.url, config);
  createTray(open);
  registerRoutes(config, server);

  const startedHidden = process.argv.includes(HIDDEN_ARG);
  if (!startedHidden) showMainWindow(server.url, config);
  else hintShown = true; // beim Autostart keinen Hinweis-Ballon zeigen

  // Zweiter Start (z.B. Doppelklick auf die Verknüpfung) → vorhandenes Fenster zeigen
  app.on('second-instance', open);
  // Ohne Tray-Modus beendet das Schließen des letzten Fensters die App
  app.on('window-all-closed', () => {
    if (!config.get('closeToTray')) app.quit();
  });
}

export function showMainWindow(baseUrl: string, config: ConfigStore<CoreConfig>): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: TITLE,
    icon: iconPath(),
    backgroundColor: '#0e0e12',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });

  // Externe Links (Twitch, Doku, …) im normalen Browser öffnen
  const openExternal = (url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    if (quitting || !config.get('closeToTray')) return;
    // Nur verstecken – die Suite läuft im Infobereich weiter
    event.preventDefault();
    mainWindow?.hide();
    if (!hintShown && tray) {
      hintShown = true;
      tray.displayBalloon({
        title: TITLE,
        content: 'Läuft im Hintergrund weiter (Overlays, Commands, Bot). Beenden über das Symbol hier unten rechts.',
        iconType: 'info',
      });
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(`${baseUrl}/app/`);
}

function createTray(open: () => void): void {
  const icon = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(TITLE);
  tray.on('click', open);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Öffnen', click: open },
      { type: 'separator' },
      {
        label: 'Beenden',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ------------------------------------------------------------------ Einstellungen (Übersicht)

/** Autostart geht nur in der installierten App (im Entwicklungsmodus würde sonst electron.exe starten) */
const autostartAvailable = () => app.isPackaged;

function status(config: ConfigStore<CoreConfig>) {
  return {
    packaged: app.isPackaged,
    autostartAvailable: autostartAvailable(),
    autostart: autostartAvailable() ? app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin : false,
    closeToTray: config.get('closeToTray'),
    dataDir: app.getPath('userData'),
  };
}

function registerRoutes(config: ConfigStore<CoreConfig>, server: LocalServer): void {
  server.route('core', 'GET', '/api/core/desktop', () => status(config));
  server.route('core', 'POST', '/api/core/desktop', ({ body }) => {
    if (typeof body?.closeToTray === 'boolean') config.set('closeToTray', body.closeToTray);
    if (typeof body?.autostart === 'boolean') {
      if (!autostartAvailable()) throw new HttpError(400, 'Autostart geht nur in der installierten App.');
      app.setLoginItemSettings({ openAtLogin: body.autostart, args: [HIDDEN_ARG] });
    }
    return status(config);
  });
  server.route('core', 'POST', '/api/core/desktop/open-data', () => {
    void shell.openPath(app.getPath('userData'));
  });
}
