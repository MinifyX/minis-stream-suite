import { app, shell } from 'electron';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import type { Addon } from './addons';
import { createLogger } from './log';
import type { LocalServer } from './server';

/**
 * Plugins: Addons, die NICHT in der Suite stecken, sondern im Ordner
 *   %APPDATA%\Mini's Stream Suite\plugins\<name>\
 * liegen. Jede Version der Suite (auch nach Updates) lädt sie beim Start.
 *
 * Aufbau eines Plugins:
 *   plugins/<name>/index.js   CommonJS, exportiert ein Addon-Objekt (oder mehrere)
 *   plugins/<name>/ui/        optional: Oberfläche/Overlays, erreichbar unter /addons/<addon-id>/
 *
 * Vom Core holen sich Plugins alles über `require('@stream-suite/api')` (siehe pluginApi.ts).
 *
 * Achtung: Plugins laufen mit denselben Rechten wie die Suite. Nur Plugins aus
 * vertrauenswürdiger Quelle in den Ordner legen!
 */

export const PLUGIN_API_MODULE = '@stream-suite/api';
const log = createLogger('Plugins');

export const pluginsDir = () => path.join(app.getPath('userData'), 'plugins');

/** Leitet require('@stream-suite/api') auf dist/pluginApi.js um */
function registerApiAlias(): void {
  const target = path.join(__dirname, '..', 'pluginApi.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const M = Module as any;
  const original = M._resolveFilename;
  M._resolveFilename = function resolve(request: string, ...rest: unknown[]) {
    if (request === PLUGIN_API_MODULE) return target;
    return original.call(this, request, ...rest);
  };
}

function isAddon(value: unknown): value is Addon {
  const a = value as Addon;
  return !!a && typeof a === 'object' && typeof a.id === 'string' && typeof a.activate === 'function';
}

export interface LoadedPlugin {
  folder: string;
  addons: Addon[];
  error?: string;
}

const loaded: LoadedPlugin[] = [];

/**
 * Alle Plugins laden. Ein kaputtes Plugin wird übersprungen (steht im Log), die Suite läuft weiter.
 * `takenIds` = IDs der eingebauten Addons (Plugins dürfen sie nicht überschreiben).
 */
export function loadPlugins(takenIds: string[]): Addon[] {
  registerApiAlias();
  const dir = pluginsDir();
  fs.mkdirSync(dir, { recursive: true });
  const taken = new Set(takenIds);
  const result: Addon[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);
    const main = path.join(folder, 'index.js');
    if (!fs.existsSync(main)) continue;
    const plugin: LoadedPlugin = { folder, addons: [] };
    loaded.push(plugin);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exported = require(main) as Record<string, unknown>;
      const candidates = [exported, exported.default, ...Object.values(exported)].flatMap((v) => (Array.isArray(v) ? v : [v]));
      const ui = path.join(folder, 'ui');
      for (const addon of new Set(candidates.filter(isAddon))) {
        if (taken.has(addon.id)) {
          log.warn(`Plugin „${entry.name}“: Addon-ID „${addon.id}“ gibt es schon – übersprungen`);
          continue;
        }
        taken.add(addon.id);
        const withMeta: Addon = { ...addon, plugin: true, publicDir: addon.publicDir ?? (fs.existsSync(ui) ? ui : undefined) };
        plugin.addons.push(withMeta);
        result.push(withMeta);
      }
      if (!plugin.addons.length) plugin.error = 'Kein Addon gefunden (index.js muss ein Addon-Objekt exportieren)';
      else log.info(`Plugin „${entry.name}“ geladen: ${plugin.addons.map((a) => a.name).join(', ')}`);
    } catch (err) {
      plugin.error = (err as Error).message;
    }
    if (plugin.error) log.error(`Plugin „${entry.name}“ konnte nicht geladen werden:`, plugin.error);
  }
  return result;
}

export function registerPluginRoutes(server: LocalServer): void {
  server.route('core', 'GET', '/api/core/plugins', () => ({
    dir: pluginsDir(),
    plugins: loaded.map((p) => ({ folder: path.basename(p.folder), addons: p.addons.map((a) => a.id), error: p.error ?? null })),
  }));
  server.route('core', 'POST', '/api/core/plugins/open-folder', () => {
    void shell.openPath(pluginsDir());
  });
}
