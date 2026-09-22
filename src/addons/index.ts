import type { Addon, AddonManifest } from '../core/addons';
import { alertsAddon } from './alerts';
import { channelPointsAddon } from './channelpoints';
import { chatAddon } from './chat';
import { commandsAddon } from './commands';
import { lurkAddon } from './lurk';
import { pollsAddon } from './polls';
import { timersAddon } from './timers';

/** Alle eingebauten Addons. Neues Addon? Hier eintragen. */
export const builtInAddons: Addon[] = [
  alertsAddon, channelPointsAddon, commandsAddon, timersAddon, pollsAddon, lurkAddon, chatAddon,
];
// Addons von außerhalb: siehe core/plugins.ts (Ordner „plugins“ im Datenordner)

/** Werden im Store als „Bald verfügbar“ angezeigt. */
export const upcomingAddons: AddonManifest[] = [];
