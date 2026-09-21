import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { builtInAddons, upcomingAddons } from './addons';
import { AddonManager } from './core/addons';
import { ConfigStore } from './core/config';
import { defaultCoreConfig, type CoreConfig } from './core/coreConfig';
import { registerCoreRoutes } from './core/coreRoutes';
import { EventBus } from './core/eventBus';
import { createLogger } from './core/log';
import { LocalServer } from './core/server';
import { TwitchApi } from './core/twitch/api';
import { TwitchAuth } from './core/twitch/auth';
import { EventSubClient } from './core/twitch/eventsub';

/** Port des lokalen Servers (Overlays in OBS: http://127.0.0.1:7474/…) */
const PORT = 7474;

let mainWindow: BrowserWindow | null = null;

async function bootstrap(): Promise<void> {
  const config = new ConfigStore<CoreConfig>('config', defaultCoreConfig);
  const bus = new EventBus();
  const auth = new TwitchAuth(config, createLogger('Twitch'));
  const api = new TwitchApi(auth);
  const eventsub = new EventSubClient(auth, api, bus, createLogger('EventSub'));
  const server = new LocalServer(path.join(app.getAppPath(), 'public'), PORT, createLogger('Server'));
  const addons = new AddonManager(builtInAddons, { bus, api, auth, server, config });

  registerCoreRoutes({ server, auth, eventsub, addons, upcomingAddons, bus });

  auth.on('login', () => eventsub.start());
  auth.on('logout', () => eventsub.stop());
  app.on('before-quit', () => {
    eventsub.stop();
    void addons.stopAll();
  });

  try {
    await server.start();
  } catch (err) {
    const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
    throw new Error(inUse ? `Port ${PORT} ist schon belegt – läuft die Suite vielleicht schon?` : String(err));
  }

  await addons.startEnabled();
  await auth.init();
  createWindow(server.url);
}

function createWindow(baseUrl: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "Mini's Stream Suite",
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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(`${baseUrl}/app/`);
}

// Nur eine Instanz erlauben (sonst wäre der Port doppelt belegt)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      dialog.showErrorBox("Mini's Stream Suite konnte nicht starten", (err as Error).message);
      app.quit();
    });
}
