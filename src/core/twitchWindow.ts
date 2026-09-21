import { BrowserWindow, shell } from 'electron';

/**
 * Fenster mit der echten Twitch-Webseite (z.B. Belohnungsverwaltung im Dashboard).
 * Twitch erlaubt Apps nicht, Belohnungen anderer Apps (z.B. HudFX) oder Bilder zu ändern,
 * im Dashboard geht das aber. So bleibt man dafür trotzdem in der Suite.
 *
 * Das Twitch-Login wird in einem eigenen, dauerhaften Speicher ("persist:twitch") abgelegt.
 * Die Seite bekommt keinerlei Zugriff auf die Suite (kein Preload, Sandbox an).
 */

const PARTITION = 'persist:twitch';
const ALLOWED_HOSTS = /(^|\.)twitch\.tv$/;

let win: BrowserWindow | null = null;

export function isTwitchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** Twitch zeigt manchen eingebetteten Browsern Warnungen – deshalb ein normaler Chrome-User-Agent */
function chromeUserAgent(ua: string): string {
  return ua.replace(/\s(Electron|minis-stream-suite|Mini's Stream Suite)\/\S+/gi, '');
}

export function openTwitchWindow(url: string): void {
  if (!isTwitchUrl(url)) throw new Error('Nur Twitch-Seiten können hier geöffnet werden.');

  if (win && !win.isDestroyed()) {
    void win.loadURL(url);
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 800,
    minHeight: 600,
    title: 'Twitch-Dashboard',
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const contents = win.webContents;
  contents.setUserAgent(chromeUserAgent(contents.getUserAgent()));

  // Twitch-Links bleiben im Fenster, alles andere öffnet der normale Browser
  contents.setWindowOpenHandler(({ url: target }) => {
    if (isTwitchUrl(target)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, target) => {
    if (!isTwitchUrl(target)) {
      event.preventDefault();
      if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    }
  });

  win.on('closed', () => {
    win = null;
  });
  void win.loadURL(url);
}
