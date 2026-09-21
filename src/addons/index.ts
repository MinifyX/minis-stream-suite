import type { Addon, AddonManifest } from '../core/addons';
import { alertsAddon } from './alerts';
import { channelPointsAddon } from './channelpoints';

/** Alle eingebauten Addons. Neues Addon? Hier eintragen. */
export const builtInAddons: Addon[] = [alertsAddon, channelPointsAddon];

/** Werden im Store als „Bald verfügbar“ angezeigt. */
export const upcomingAddons: AddonManifest[] = [
  {
    id: 'commands',
    name: 'Chat-Commands',
    icon: '💬',
    version: '–',
    author: 'Mini',
    description: 'Eigene !commands mit Cooldowns, Rechten und Variablen.',
  },
];
