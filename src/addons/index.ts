import type { Addon, AddonManifest } from '../core/addons';
import { alertsAddon } from './alerts';

/** Alle eingebauten Addons. Neues Addon? Hier eintragen. */
export const builtInAddons: Addon[] = [alertsAddon];

/** Werden im Store als „Bald verfügbar“ angezeigt. */
export const upcomingAddons: AddonManifest[] = [
  {
    id: 'channelpoints',
    name: 'Kanalpunkte',
    icon: '🎯',
    version: '–',
    author: 'Mini',
    description: 'Belohnungen anlegen, in Gruppen sortieren und z.B. alle HudFX-Belohnungen mit einem Klick pausieren.',
  },
  {
    id: 'commands',
    name: 'Chat-Commands',
    icon: '💬',
    version: '–',
    author: 'Mini',
    description: 'Eigene !commands mit Cooldowns, Rechten und Variablen.',
  },
];
