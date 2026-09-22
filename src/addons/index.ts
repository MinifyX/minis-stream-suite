import type { Addon, AddonManifest } from '../core/addons';
import { alertsAddon } from './alerts';
import { channelPointsAddon } from './channelpoints';
import { chatAddon } from './chat';
import { commandsAddon } from './commands';
import { lurkAddon } from './lurk';
import { pollsAddon } from './polls';
import { timersAddon } from './timers';

/**
 * Eigene Addons, die nicht ins öffentliche Repo sollen, kommen nach src/addons/private/
 * (steht in .gitignore). Dort eine index.ts anlegen, die `privateAddons: Addon[]` exportiert.
 * Fehlt der Ordner, läuft die Suite einfach ohne.
 */
function loadPrivateAddons(): Addon[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('./private') as { privateAddons: Addon[] }).privateAddons;
  } catch (err) {
    // Nur „Ordner fehlt“ ist okay – andere Fehler im privaten Addon sollen auffallen
    if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND' || !String((err as Error).message).includes("'./private'")) throw err;
    return [];
  }
}

/** Alle eingebauten Addons. Neues Addon? Hier eintragen. */
export const builtInAddons: Addon[] = [
  alertsAddon, channelPointsAddon, commandsAddon, timersAddon, pollsAddon, lurkAddon, chatAddon,
  ...loadPrivateAddons(),
];

/** Werden im Store als „Bald verfügbar“ angezeigt. */
export const upcomingAddons: AddonManifest[] = [];
