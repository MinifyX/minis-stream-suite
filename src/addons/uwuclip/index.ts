import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Addon } from '../../core/addons';
import { ConfigStore } from '../../core/config';
import { HttpError } from '../../core/server';
import { ALERT_SHOWN_SERVICE, type AlertShownListener } from '../alerts';
import { CHANNELPOINTS_SERVICE, type ChannelPointsService } from '../channelpoints/service';
import {
  alertShownEvent,
  EventIds,
  Forwarder,
  normalizeServerUrl,
  shouldForward,
  toSuiteEvent,
  type ForwarderConfig,
} from './forwarder';

/**
 * UwUClip-Addon: leitet Stream-Events an den UwUClip-Server weiter (automatisches Clippen).
 * Damit erkennt der Server z.B. HudFX-Jumpscares (Kanalpunkte-Gruppe „HudFX“), Werbepausen,
 * den Moment, in dem ein Alert erscheint, Umfragen, Raids und Abos.
 */

interface Settings {
  enabled: boolean;
  serverUrl: string;
}

const DEFAULTS: Settings = { enabled: true, serverUrl: '' };
const MAX_SECRET = 500;

export const uwuclipAddon: Addon = {
  id: 'uwuclip',
  name: 'UwUClip',
  icon: '✂️',
  version: '0.1.0',
  author: 'Mini',
  description: 'Schickt Stream-Events (HudFX, Werbepausen, Alerts, Umfragen, Raids …) an deinen UwUClip-Server, damit er automatisch die besten Momente clippt.',
  settingsPage: 'index.html',

  activate(ctx) {
    const settings = ctx.settings<Settings>(DEFAULTS);

    // Schlüssel verschlüsselt unter secrets/ – die Sicherung nimmt nur addons/*.json mit
    const secrets = new ConfigStore<{ secret: string | null }>('secrets/uwuclip', { secret: null });
    const readSecret = (): string => {
      const stored = secrets.get('secret');
      if (!stored) return '';
      try {
        return stored.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')) : stored;
      } catch {
        return '';
      }
    };
    let secret = readSecret();
    const writeSecret = (value: string) => {
      secret = value;
      if (!value) return secrets.set('secret', null);
      if (safeStorage.isEncryptionAvailable()) return secrets.set('secret', `enc:${safeStorage.encryptString(value).toString('base64')}`);
      // Ohne Schlüsselbund (z. B. Linux ohne Secret Service) bleibt nur Klartext – nicht stillschweigend
      ctx.log.warn('Kein Schlüsselbund verfügbar – der UwUClip-Schlüssel wird unverschlüsselt gespeichert');
      secrets.set('secret', value);
    };
    /** Liegt der gespeicherte Schlüssel im Klartext auf der Platte? */
    const secretPlain = (): boolean => {
      const stored = secrets.get('secret');
      return !!stored && !stored.startsWith('enc:');
    };
    if (secretPlain()) ctx.log.warn('Der UwUClip-Schlüssel liegt unverschlüsselt auf der Platte');

    const config = (): ForwarderConfig | null => {
      const { enabled, serverUrl } = settings.all();
      return enabled && serverUrl && secret ? { serverUrl, secret } : null;
    };

    const forwarder = new Forwarder({
      file: path.join(app.getPath('userData'), 'uwuclip', 'outbox.json'),
      version: app.getVersion(),
      config,
      log: ctx.log,
    });
    forwarder.start();
    ctx.onDispose(() => forwarder.stop());

    const ids = new EventIds();

    // Nur einsammeln, wenn die Weiterleitung eingerichtet ist (pausiert nach 401/403 zählt als eingerichtet)
    ctx.events.onAny((event) => {
      if (!config() || !shouldForward(event)) return;
      const id = randomUUID();
      ids.remember(event, id);
      const effect = event.type === 'redemption'
        ? ctx.use<ChannelPointsService>(CHANNELPOINTS_SERVICE)?.effectOf(event.reward.id) ?? null
        : undefined;
      forwarder.enqueue(toSuiteEvent(event, { id, at: Date.now(), effect }));
    });

    // Der Alert erscheint gerade im Overlay
    const alertListener: AlertShownListener = {
      alertShown(event, info) {
        if (event.test || !config()) return;
        // Ohne Bezug (Event nicht weitergeleitet, z. B. ein Hype-Train-Zwischenstand) kann UwUClip nichts damit anfangen
        const ref = ids.find(event);
        if (!ref) return;
        forwarder.enqueue(alertShownEvent({
          id: randomUUID(),
          at: Date.now(),
          ref,
          variant: info?.variant ?? null,
          category: info?.category,
          event,
        }));
      },
    };
    ctx.provide(ALERT_SHOWN_SERVICE, alertListener);

    // ------------------------------------------------------------ API für die Einstellungsseite

    const state = () => ({
      settings: { ...settings.all(), hasSecret: !!secret, secretPlain: secretPlain() },
      status: forwarder.status(),
    });

    ctx.api.get('/state', state);

    /** { enabled?, serverUrl?, secret?, clearSecret? } – leerer Schlüssel = alten behalten */
    ctx.api.post('/settings', ({ body }) => {
      const patch: Partial<Settings> = {};
      if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body?.serverUrl === 'string') {
        try {
          patch.serverUrl = normalizeServerUrl(body.serverUrl.slice(0, 500));
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
      settings.update(patch);
      if (body?.clearSecret === true) writeSecret('');
      else if (typeof body?.secret === 'string' && body.secret.trim()) writeSecret(body.secret.trim().slice(0, MAX_SECRET));
      forwarder.resume();
      void forwarder.flush();
      return state();
    });

    /** { serverUrl?, secret? } – leeres Paket schicken; ohne Angaben mit den gespeicherten Werten */
    ctx.api.post('/test', async ({ body }) => {
      let serverUrl = '';
      if (typeof body?.serverUrl === 'string') {
        try {
          serverUrl = normalizeServerUrl(body.serverUrl.slice(0, 500));
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
      const testSecret = typeof body?.secret === 'string' ? body.secret.trim().slice(0, MAX_SECRET) : '';
      const result = await forwarder.test({ serverUrl, secret: testSecret });
      // Klappt es mit den gespeicherten Werten, sofort weiter senden
      const sameAsSaved = (!serverUrl || serverUrl === settings.get('serverUrl')) && (!testSecret || testSecret === secret);
      if (result.ok && sameAsSaved) {
        forwarder.resume();
        void forwarder.flush();
      }
      return { result, ...state() };
    });

    ctx.api.post('/resume', () => {
      forwarder.resume();
      void forwarder.flush();
      return state();
    });

    ctx.api.post('/clear', () => {
      forwarder.clear();
      return state();
    });
  },
};
