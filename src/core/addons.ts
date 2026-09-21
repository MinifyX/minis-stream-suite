import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from './config';
import type { CoreConfig } from './coreConfig';
import type { EventBus } from './eventBus';
import { createLogger, type Logger } from './log';
import { HttpError, type ApiHandler, type LocalServer } from './server';
import type { TwitchApi } from './twitch/api';
import type { TwitchAuth, TwitchUser } from './twitch/auth';
import type { EventOfType, StreamEvent, StreamEventType } from './twitch/events';

/** Steckbrief eines Addons – das, was im Addon-Store angezeigt wird. */
export interface AddonManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  /** Emoji als Icon */
  icon: string;
  /** Einstellungsseite relativ zu public/addons/<id>/, z.B. "settings.html" */
  settingsPage?: string;
}

export interface Addon extends AddonManifest {
  activate(ctx: AddonContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/**
 * Alles, was ein Addon vom Core bekommt. Event-Listener und API-Routen werden
 * beim Deaktivieren automatisch wieder entfernt.
 */
export interface AddonContext {
  log: Logger;
  events: {
    on<T extends StreamEventType>(type: T, handler: (event: EventOfType<T>) => unknown): () => void;
    onAny(handler: (event: StreamEvent) => unknown): () => void;
    emit(event: StreamEvent): void;
  };
  /** Twitch Helix API */
  twitch: TwitchApi;
  /** Eingeloggter Twitch-Nutzer (oder null) */
  getUser(): TwitchUser | null;
  /** Eigene Einstellungsdatei des Addons */
  settings<T extends object>(defaults: T): ConfigStore<T>;
  overlay: {
    /** Schickt Daten an alle offenen Overlays dieses Addons */
    broadcast(data: unknown): void;
    /** Basis-URL der Addon-Dateien, z.B. http://127.0.0.1:7474/addons/alerts */
    baseUrl: string;
  };
  /** Eigene API-Routen unter /api/addons/<id>/… */
  api: {
    get(path: string, handler: ApiHandler): void;
    post(path: string, handler: ApiHandler): void;
    /** Datei-Upload: body ist ein Buffer, der Dateiname steht in query */
    upload(path: string, handler: ApiHandler): void;
  };
  /** Eigener Datenordner (z.B. für hochgeladene Dateien) … */
  dataDir: string;
  /** … und die URL, unter der er ausgeliefert wird, z.B. /addon-data/alerts */
  dataUrl: string;
  /** Eine Schnittstelle für andere Addons anbieten (z.B. "channelpoints") */
  provide(name: string, service: object): void;
  /** Schnittstelle eines anderen Addons holen – undefined, wenn es nicht aktiv ist */
  use<T extends object>(name: string): T | undefined;
}

interface Deps {
  bus: EventBus;
  api: TwitchApi;
  auth: TwitchAuth;
  server: LocalServer;
  config: ConfigStore<CoreConfig>;
}

function manifestOf(addon: Addon): AddonManifest {
  const { id, name, description, version, author, icon, settingsPage } = addon;
  return { id, name, description, version, author, icon, settingsPage };
}

export class AddonManager {
  private active = new Map<string, Array<() => void>>();
  private services = new Map<string, object>();
  private log = createLogger('Addons');

  constructor(
    private addons: Addon[],
    private deps: Deps,
  ) {}

  list() {
    const enabled = this.deps.config.get('enabledAddons');
    return this.addons.map((addon) => ({
      ...manifestOf(addon),
      enabled: enabled.includes(addon.id),
      active: this.active.has(addon.id),
    }));
  }

  async startEnabled(): Promise<void> {
    for (const id of this.deps.config.get('enabledAddons')) {
      const addon = this.addons.find((a) => a.id === id);
      if (!addon) continue;
      await this.activate(addon).catch((err) => this.log.error(`${addon.name} konnte nicht starten:`, err));
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const addon = this.addons.find((a) => a.id === id);
    if (!addon) throw new HttpError(404, 'Addon nicht gefunden');
    const list = this.deps.config.get('enabledAddons').filter((x) => x !== id);
    if (enabled) list.push(id);
    this.deps.config.set('enabledAddons', list);
    if (enabled) await this.activate(addon);
    else await this.deactivate(addon);
  }

  async stopAll(): Promise<void> {
    for (const addon of this.addons) await this.deactivate(addon);
  }

  private async activate(addon: Addon): Promise<void> {
    if (this.active.has(addon.id)) return;
    const { bus, api, auth, server } = this.deps;
    const cleanup: Array<() => void> = [];
    const track = (off: () => void) => {
      cleanup.push(off);
      return off;
    };
    const apiBase = `/api/addons/${addon.id}`;
    const dataDir = path.join(app.getPath('userData'), 'addon-data', addon.id);
    const dataUrl = `/addon-data/${addon.id}`;
    fs.mkdirSync(dataDir, { recursive: true });
    server.mount(addon.id, dataUrl, dataDir);

    const ctx: AddonContext = {
      log: createLogger(addon.name),
      events: {
        on: (type, handler) => track(bus.on(type, handler)),
        onAny: (handler) => track(bus.onAny(handler)),
        emit: (event) => bus.emit(event),
      },
      twitch: api,
      getUser: () => auth.user,
      settings: (defaults) => new ConfigStore(`addons/${addon.id}`, defaults),
      overlay: {
        broadcast: (data) => server.broadcast(addon.id, data),
        baseUrl: `${server.url}/addons/${addon.id}`,
      },
      api: {
        get: (path, handler) => server.route(addon.id, 'GET', apiBase + path, handler),
        post: (path, handler) => server.route(addon.id, 'POST', apiBase + path, handler),
        upload: (path, handler) => server.route(addon.id, 'POST', apiBase + path, handler, { upload: true }),
      },
      dataDir,
      dataUrl,
      provide: (name, service) => {
        this.services.set(name, service);
        cleanup.push(() => this.services.delete(name));
      },
      use: <T extends object>(name: string) => this.services.get(name) as T | undefined,
    };

    this.active.set(addon.id, cleanup);
    try {
      await addon.activate(ctx);
      this.log.info(`${addon.name} aktiviert`);
    } catch (err) {
      await this.deactivate(addon);
      throw err;
    }
  }

  private async deactivate(addon: Addon): Promise<void> {
    const cleanup = this.active.get(addon.id);
    if (!cleanup) return;
    try {
      await addon.deactivate?.();
    } catch (err) {
      this.log.error(`${addon.name}: Fehler beim Beenden:`, err);
    }
    cleanup.forEach((off) => off());
    this.deps.server.clearScope(addon.id);
    this.active.delete(addon.id);
    this.log.info(`${addon.name} deaktiviert`);
  }
}
