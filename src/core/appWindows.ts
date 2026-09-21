import { BrowserWindow, Menu, screen, shell } from 'electron';
import { ConfigStore } from './config';

/**
 * Eigene Fenster für Addons (z.B. das Chat-Fenster). Position, Größe und
 * "Immer im Vordergrund" werden gemerkt und beim nächsten Öffnen wiederhergestellt.
 */

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowsConfig {
  bounds: Record<string, Bounds>;
  onTop: Record<string, boolean>;
}

export interface OpenOptions {
  title: string;
  width: number;
  height: number;
  alwaysOnTop?: boolean;
}

const windows = new Map<string, BrowserWindow>();
let store: ConfigStore<WindowsConfig> | null = null;
const cfg = () => (store ??= new ConfigStore<WindowsConfig>('windows', { bounds: {}, onTop: {} }));

/** Liegt die gespeicherte Position noch auf einem vorhandenen Bildschirm? */
function visible(b: Bounds): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50);
}

export function openAppWindow(key: string, url: string, options: OpenOptions): void {
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const saved = cfg().get('bounds')[key];
  const onTop = cfg().get('onTop')[key] ?? options.alwaysOnTop ?? false;
  const win = new BrowserWindow({
    ...(saved && visible(saved) ? saved : { width: options.width, height: options.height }),
    minWidth: 280,
    minHeight: 300,
    title: options.title,
    backgroundColor: '#0e0e12',
    autoHideMenuBar: true,
    alwaysOnTop: onTop,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenu(Menu.buildFromTemplate([]));
  windows.set(key, win);

  const base = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(base)) {
      event.preventDefault();
      if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    }
  });

  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    cfg().set('bounds', { ...cfg().get('bounds'), [key]: win.getBounds() });
  };
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 500);
  };
  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);
  win.on('close', saveBounds);
  win.on('closed', () => {
    if (windows.get(key) === win) windows.delete(key);
  });

  void win.loadURL(url);
}

export function setAlwaysOnTop(key: string, on: boolean): void {
  cfg().set('onTop', { ...cfg().get('onTop'), [key]: on });
  const win = windows.get(key);
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(on);
}

export function isAlwaysOnTop(key: string): boolean {
  return cfg().get('onTop')[key] ?? false;
}

export function closeAppWindow(key: string): void {
  const win = windows.get(key);
  if (win && !win.isDestroyed()) win.close();
}

export function isWindowOpen(key: string): boolean {
  const win = windows.get(key);
  return !!win && !win.isDestroyed();
}
