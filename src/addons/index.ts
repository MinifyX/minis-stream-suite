import type { Addon, AddonManifest } from '../core/addons';
import { alertsAddon } from './alerts';
import { channelPointsAddon } from './channelpoints';
import { commandsAddon } from './commands';

/** Alle eingebauten Addons. Neues Addon? Hier eintragen. */
export const builtInAddons: Addon[] = [alertsAddon, channelPointsAddon, commandsAddon];

/** Werden im Store als „Bald verfügbar“ angezeigt. */
export const upcomingAddons: AddonManifest[] = [
  {
    id: 'timers',
    name: 'Timer-Nachrichten',
    icon: '⏰',
    version: '–',
    author: 'Mini',
    description: 'Automatische Chat-Nachrichten alle X Minuten, z.B. Discord-Link oder Social Media.',
  },
];
