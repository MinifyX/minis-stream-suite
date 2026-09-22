/**
 * Schnittstelle für Plugins (Addons außerhalb der Suite, siehe core/plugins.ts).
 *
 * Plugins holen sich alles vom Core NUR hierüber:
 *   import { HttpError, type Addon } from '@stream-suite/api';
 * Die Suite leitet diesen Namen zur Laufzeit auf diese Datei um. So funktionieren Plugins
 * mit jeder neuen Version der Suite, solange sich hier nichts Grundlegendes ändert.
 * Ändert sich etwas inkompatibel, wird PLUGIN_API_VERSION erhöht.
 */

export const PLUGIN_API_VERSION = 1;

export { HttpError } from './core/server';
export { duration, roleLevel, parseRole, ROLES, ROLE_LEVEL, type Role } from './core/chat';
export { ALERT_SHOWN_SERVICE, type AlertShownListener } from './addons/alerts';
export type { Addon, AddonContext, AddonManifest } from './core/addons';
export type { StreamEvent, StreamEventType, EventOfType, TwitchUserRef, RewardRef } from './core/twitch/events';
export type { TwitchUser } from './core/twitch/auth';
export type { ApiHandler, ApiRequest } from './core/server';
export type { Logger } from './core/log';
