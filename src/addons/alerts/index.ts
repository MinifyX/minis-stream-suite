import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Addon } from '../../core/addons';
import { ConfigStore } from '../../core/config';
import { HttpError } from '../../core/server';
import { makeTestEvent, type EventOfType, type RewardRef, type StreamEvent } from '../../core/twitch/events';
import {
  CATEGORY_IDS,
  DEFAULT_CONDITIONS,
  DEFAULT_DESIGN,
  DEFAULT_SETTINGS,
  describeEvent,
  fillPlain,
  pickVariant,
  rewardAllowed,
  sanitizeCategories,
  type AlertSettings,
  type CategoryId,
  type RewardSetting,
  type Variant,
} from './model';
import { Tts } from './tts';
import { CHANNELPOINTS_SERVICE, type ChannelPointsService } from '../channelpoints/service';

interface HelixReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
  is_paused: boolean;
  background_color: string;
  image: { url_1x: string } | null;
  default_image: { url_1x: string } | null;
}

interface MediaFile {
  id: string;
  name: string;
  kind: 'image' | 'video' | 'audio';
  size: number;
  uploadedAt: number;
}

const MEDIA_TYPES: Record<string, MediaFile['kind']> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.webm': 'video',
  '.mp4': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
};

/** Test-Event, das zu den Bedingungen einer Variante passt */
function testEventFor(category: CategoryId, variant: Variant | null, reward?: Partial<RewardRef>): StreamEvent {
  const c = variant?.conditions ?? DEFAULT_CONDITIONS;
  const tier = c.tier === 'any' ? '1000' : c.tier;
  switch (category) {
    case 'sub':
      if (c.subKind === 'resub' || c.minMonths > 1) {
        const e = makeTestEvent('resub') as EventOfType<'resub'>;
        return { ...e, tier, months: Math.max(12, c.minMonths) };
      }
      return { ...(makeTestEvent('sub') as EventOfType<'sub'>), tier };
    case 'giftsub': {
      const e = makeTestEvent('giftsub') as EventOfType<'giftsub'>;
      return { ...e, tier, count: Math.max(5, c.minCount) };
    }
    case 'cheer': {
      const e = makeTestEvent('cheer') as EventOfType<'cheer'>;
      return { ...e, bits: Math.max(100, c.minBits) };
    }
    case 'raid': {
      const e = makeTestEvent('raid') as EventOfType<'raid'>;
      return { ...e, viewers: Math.max(42, c.minViewers) };
    }
    case 'redemption':
      return makeTestEvent('redemption', reward);
    default:
      return makeTestEvent(category);
  }
}

export const alertsAddon: Addon = {
  id: 'alerts',
  name: 'Alerts',
  icon: '🔔',
  version: '0.2.0',
  author: 'Mini',
  description: 'Alert-Editor mit Varianten für Follows, Abos, Bits, Raids und Kanalpunkte, pro Belohnung ein- oder ausschaltbar.',
  settingsPage: 'editor.html',

  activate(ctx) {
    const settings = ctx.settings<AlertSettings>(DEFAULT_SETTINGS);
    // Alte oder kaputte Einstellungen auf das aktuelle Format bringen
    settings.set('categories', sanitizeCategories(settings.get('categories')));

    const mediaDir = path.join(ctx.dataDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const mediaIndex = new ConfigStore<{ files: MediaFile[] }>('addons/alerts-media', { files: [] });
    const tts = new Tts(path.join(ctx.dataDir, 'tts'), `${ctx.dataUrl}/tts`);

    /** Alert bauen (inkl. Sprachausgabe) und ans Overlay schicken */
    const send = async (category: CategoryId, variant: Variant, event: StreamEvent) => {
      const { values, userMessage } = describeEvent(event);
      const design = variant.design;
      let ttsUrl: string | null = null;
      if (design.tts.enabled) {
        let text = fillPlain(design.message, values);
        if (design.tts.readUserMessage && userMessage) text += `. ${userMessage}`;
        try {
          ttsUrl = await tts.speak(text, design.tts.voice, design.tts.rate);
        } catch (err) {
          ctx.log.warn('Sprachausgabe fehlgeschlagen:', err);
        }
      }
      ctx.overlay.broadcast({
        kind: 'alert',
        alert: {
          id: randomUUID(),
          category,
          variant: variant.name,
          design,
          values,
          userMessage: design.showUserMessage ? userMessage : '',
          ttsUrl,
        },
      });
    };

    /** Gruppen aus dem Kanalpunkte-Addon (leer, wenn es aus ist) */
    const channelPoints = () => ctx.use<ChannelPointsService>(CHANNELPOINTS_SERVICE);
    const groupsOf = (rewardId: string) => channelPoints()?.groupsOf(rewardId).map((g) => g.id) ?? [];

    ctx.events.onAny(async (event) => {
      const picked = pickVariant(settings.all(), event, groupsOf);
      if (picked) await send(picked.category, picked.variant, event);
    });

    // ------------------------------------------------------------ Einstellungen

    ctx.api.get('/settings', () => settings.all());

    ctx.api.get('/defaults', () => ({ design: DEFAULT_DESIGN, conditions: DEFAULT_CONDITIONS }));

    ctx.api.post('/categories', ({ body }) => {
      settings.set('categories', sanitizeCategories(body?.categories));
      return settings.get('categories');
    });

    ctx.api.post('/settings', ({ body }) => {
      if (body?.canvas) {
        const width = Math.round(Number(body.canvas.width));
        const height = Math.round(Number(body.canvas.height));
        if (!(width >= 100 && width <= 3840 && height >= 100 && height <= 2160)) {
          throw new HttpError(400, 'Größe muss zwischen 100 und 3840 × 2160 liegen');
        }
        settings.set('canvas', { width, height });
      }
      if (typeof body?.newRewardDefault === 'boolean') settings.set('newRewardDefault', body.newRewardDefault);
      if (Array.isArray(body?.mutedGroups)) settings.set('mutedGroups', body.mutedGroups.map(String));
      return settings.all();
    });

    // ------------------------------------------------------------ Belohnungen

    ctx.api.get('/rewards', async () => {
      const user = ctx.getUser();
      if (!user) throw new HttpError(401, 'Bitte zuerst in der Übersicht mit Twitch verbinden.');
      const res = await ctx.twitch.request<{ data: HelixReward[] }>('GET', '/channel_points/custom_rewards', {
        query: { broadcaster_id: user.id },
      });
      const s = settings.all();
      const cp = channelPoints();
      return {
        groups: cp?.groups() ?? null,
        rewards: res.data
          .map((r) => ({
            id: r.id,
            title: r.title,
            cost: r.cost,
            enabled: r.is_enabled,
            paused: r.is_paused,
            color: r.background_color,
            image: (r.image ?? r.default_image)?.url_1x ?? null,
            custom: r.id in s.rewards,
            groups: cp?.groupsOf(r.id).map((g) => g.id) ?? [],
            alert: rewardAllowed(s, r.id, groupsOf(r.id)),
          }))
          .sort((a, b) => a.cost - b.cost),
      };
    });

    /** Belohnungs-Filter: { changes: { [rewardId]: { alert, title } | null } } – null = zurück auf Standard */
    ctx.api.post('/rewards', ({ body }) => {
      const changes = body?.changes;
      if (!changes || typeof changes !== 'object') throw new HttpError(400, '"changes" fehlt');
      const rewards = { ...settings.get('rewards') };
      for (const [id, change] of Object.entries(changes as Record<string, RewardSetting | null>)) {
        if (change === null) delete rewards[id];
        else if (typeof change?.alert === 'boolean') rewards[id] = { alert: change.alert, title: String(change.title ?? '') };
      }
      settings.set('rewards', rewards);
    });

    // ------------------------------------------------------------ Test

    /**
     * { category, variantId } → genau diese Variante ins Overlay schicken.
     * { category, reward }    → wie ein echtes Event (Filter + Variantenwahl); sagt, ob ein Alert käme.
     */
    ctx.api.post('/test', async ({ body }) => {
      const category = body?.category as CategoryId;
      if (!CATEGORY_IDS.includes(category)) throw new HttpError(400, 'Unbekannte Kategorie');
      const s = settings.all();

      if (body.variantId) {
        const variant = s.categories[category].variants.find((v) => v.id === body.variantId);
        if (!variant) throw new HttpError(404, 'Variante nicht gefunden');
        await send(category, variant, testEventFor(category, variant, body.reward));
        return { shown: true, variant: variant.name };
      }

      const event = testEventFor(category, null, body.reward);
      const picked = pickVariant(s, event, groupsOf);
      if (!picked) return { shown: false };
      await send(picked.category, picked.variant, event);
      return { shown: true, variant: picked.variant.name };
    });

    /** Nach dem Übernehmen einer Belohnung (neue ID): Filter und Varianten umziehen */
    ctx.api.post('/rewards/migrate', ({ body }) => {
      const from = String(body?.from ?? '');
      const to = String(body?.to ?? '');
      if (!from || !to) throw new HttpError(400, 'from/to fehlt');
      const rewards = { ...settings.get('rewards') };
      if (rewards[from]) {
        rewards[to] = rewards[from];
        delete rewards[from];
        settings.set('rewards', rewards);
      }
      const categories = settings.get('categories');
      for (const v of categories.redemption.variants) {
        v.conditions.rewardIds = v.conditions.rewardIds.map((id) => (id === from ? to : id));
      }
      settings.set('categories', categories);
    });

    ctx.api.post('/skip', () => ctx.overlay.broadcast({ kind: 'skip' }));

    // ------------------------------------------------------------ Sprachausgabe

    ctx.api.get('/voices', () => tts.voices());

    ctx.api.post('/tts', async ({ body }) => {
      const text = String(body?.text ?? '').trim();
      if (!text) throw new HttpError(400, 'Kein Text');
      return { url: await tts.speak(text, String(body?.voice ?? ''), Number(body?.rate) || 0) };
    });

    // ------------------------------------------------------------ Eigene Dateien

    ctx.api.get('/media', () => mediaIndex.get('files'));

    ctx.api.upload('/media', ({ body, query }) => {
      const name = String(query.get('name') ?? 'datei').slice(0, 120);
      const ext = path.extname(name).toLowerCase();
      const kind = MEDIA_TYPES[ext];
      if (!kind) throw new HttpError(400, `Dateityp ${ext || '?'} wird nicht unterstützt (erlaubt: ${Object.keys(MEDIA_TYPES).join(', ')})`);
      const data = body as Buffer;
      if (!data.length) throw new HttpError(400, 'Leere Datei');
      const file: MediaFile = { id: `${randomUUID()}${ext}`, name, kind, size: data.length, uploadedAt: Date.now() };
      fs.writeFileSync(path.join(mediaDir, file.id), data);
      mediaIndex.set('files', [...mediaIndex.get('files'), file]);
      ctx.log.info(`Datei hochgeladen: ${name}`);
      return file;
    });

    ctx.api.post('/media/delete', ({ body }) => {
      const files = mediaIndex.get('files');
      const file = files.find((f) => f.id === body?.id);
      if (!file) throw new HttpError(404, 'Datei nicht gefunden');
      fs.rmSync(path.join(mediaDir, file.id), { force: true });
      mediaIndex.set('files', files.filter((f) => f.id !== file.id));
    });
  },
};
