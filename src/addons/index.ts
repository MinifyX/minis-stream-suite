import type { Addon, AddonManifest } from '../core/addons';
import { alertsAddon } from './alerts';
import { channelPointsAddon } from './channelpoints';
import { commandsAddon } from './commands';
import { timersAddon } from './timers';

/** Alle eingebauten Addons. Neues Addon? Hier eintragen. */
export const builtInAddons: Addon[] = [alertsAddon, channelPointsAddon, commandsAddon, timersAddon];

/** Werden im Store als „Bald verfügbar“ angezeigt. */
export const upcomingAddons: AddonManifest[] = [];
