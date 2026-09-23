import type { Addon, AddonManifest } from '../core/addons';
import { adsAddon } from './ads';
import { alertsAddon } from './alerts';
import { channelPointsAddon } from './channelpoints';
import { chatAddon } from './chat';
import { commandsAddon } from './commands';
import { goalsAddon } from './goals';
import { lurkAddon } from './lurk';
import { modguardAddon } from './modguard';
import { obsAddon } from './obs';
import { pollsAddon } from './polls';
import { predictionsAddon } from './predictions';
import { queueAddon } from './queue';
import { shoutoutAddon } from './shoutout';
import { streaminfoAddon } from './streaminfo';
import { timersAddon } from './timers';

/** Alle eingebauten Addons. Neues Addon? Hier eintragen. */
export const builtInAddons: Addon[] = [
  alertsAddon, channelPointsAddon, queueAddon, commandsAddon, timersAddon, pollsAddon, predictionsAddon, goalsAddon, lurkAddon,
  shoutoutAddon, adsAddon, modguardAddon, streaminfoAddon, obsAddon, chatAddon,
];
// Addons von außerhalb: siehe core/plugins.ts (Ordner „plugins“ im Datenordner)

/** Werden im Store als „Bald verfügbar“ angezeigt. */
export const upcomingAddons: AddonManifest[] = [];
