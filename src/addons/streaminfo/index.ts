import type { Addon, AddonContext } from '../../core/addons';
import { parseRole, roleLevel, ROLE_LEVEL, type Role } from '../../core/chat';
import { HttpError } from '../../core/server';
import type { EventOfType } from '../../core/twitch/events';

/**
 * Stream-Info-Addon: Titel, Kategorie, Tags und Sprache des Kanals direkt in der Suite ändern.
 * Dazu Vorlagen (z.B. „Minecraft-Abend“), die alles mit einem Klick setzen, zuletzt benutzte
 * Titel/Kategorien als Schnellauswahl und !title / !game für Mods im Chat.
 *
 * Änderungen, die woanders passieren (Twitch-Dashboard, anderes Tool), kommen über das
 * channelupdate-Event rein und werden sofort angezeigt.
 */

// ------------------------------------------------------------------ Datenmodell

/** Twitch-Kategorie (Spiel) */
interface Category {
  id: string;
  name: string;
  /** Box-Art-URL (144×192) oder "" */
  image: string;
}

/** So ist der Kanal gerade bei Twitch eingestellt */
interface ChannelInfo {
  title: string;
  /** null = keine Kategorie */
  category: Category | null;
  tags: string[];
  /** ISO 639-1 (z.B. "de") oder "other" */
  language: string;
}

/** Vorlage. Leere Felder (bzw. null) = bleibt beim Anwenden, wie es ist. */
interface Preset {
  id: string;
  name: string;
  /** Darf Variablen enthalten, z.B. {datum} oder {nr} */
  title: string;
  category: Category | null;
  /** null = Tags nicht ändern, [] = alle Tags entfernen */
  tags: string[] | null;
  /** "" = nicht ändern */
  language: string;
}

interface Settings {
  presets: Preset[];
  recentTitles: string[];
  recentCategories: Category[];
  /** Stream-Zähler für {nr} – wird bei jedem Anwenden eines Titels mit {nr} hochgezählt */
  counter: number;
  chat: {
    enabled: boolean;
    /** Command-Namen ohne "!" – leer = aus */
    titleCmd: string;
    gameCmd: string;
    /** Wer Titel/Kategorie ändern darf */
    minRole: Role;
    /** Dürfen alle ohne Text fragen („!title“ → aktueller Titel)? Sonst nur ab minRole. */
    everyoneCanAsk: boolean;
  };
}

const DEFAULTS: Settings = {
  presets: [],
  recentTitles: [],
  recentCategories: [],
  counter: 0,
  chat: { enabled: true, titleCmd: 'title', gameCmd: 'game', minRole: 'moderator', everyoneCanAsk: true },
};

/** Dinge, die das Speichern ändern soll. undefined = nicht anfassen. */
interface InfoPatch {
  title?: string;
  /** null = Kategorie entfernen */
  category?: Category | null;
  tags?: string[];
  language?: string;
}

const MAX_TITLE = 140;
const MAX_TAGS = 10;
const MAX_TAG_LEN = 25;
const MAX_RECENT = 15;
const MAX_PRESETS = 100;
/** Abklingzeit für „!title“/„!game“ ohne Text (Sekunden, für alle zusammen) */
const ASK_COOLDOWN_MS = 10_000;

const CMD_RE = /^[\p{L}\p{N}_-]{1,30}$/u;
/** Twitch erlaubt in Tags nur Buchstaben und Zahlen (keine Leerzeichen, keine Sonderzeichen) */
const TAG_RE = /^[\p{L}\p{N}]+$/u;
const LANG_RE = /^([a-z]{2}|other)$/;
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, max);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** Box-Art in einer festen Größe (Twitch liefert mal eine Vorlage mit {width}, mal eine fertige Größe) */
function boxArt(url: string | undefined): string {
  if (!url) return '';
  return url
    .replace('{width}', '144')
    .replace('{height}', '192')
    .replace(/-\d+x\d+(\.\w+)$/, '-144x192$1');
}

function parseCategory(input: unknown): Category | null {
  const c = input as Partial<Category> | null;
  if (!c || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string') return null;
  return { id: c.id.slice(0, 30), name: c.name.slice(0, 100), image: typeof c.image === 'string' ? c.image.slice(0, 300) : '' };
}

/** Tags prüfen und aufräumen. Wirft einen verständlichen Fehler, wenn Twitch sie ablehnen würde. */
function cleanTags(input: unknown): string[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'Tags fehlen.');
  const tags: string[] = [];
  for (const raw of input) {
    const tag = String(raw ?? '').trim().replace(/^#/, '');
    if (!tag) continue;
    if (tag.length > MAX_TAG_LEN) throw new HttpError(400, `Der Tag „${tag}“ ist zu lang (höchstens ${MAX_TAG_LEN} Zeichen).`);
    if (!TAG_RE.test(tag)) throw new HttpError(400, `Der Tag „${tag}“ geht nicht: nur Buchstaben und Zahlen, keine Leerzeichen oder Sonderzeichen.`);
    if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) throw new HttpError(400, `Twitch erlaubt höchstens ${MAX_TAGS} Tags.`);
  return tags;
}

function cleanLanguage(input: unknown): string {
  const lang = String(input ?? '').trim().toLowerCase();
  if (!LANG_RE.test(lang)) throw new HttpError(400, 'Unbekannte Sprache.');
  return lang;
}

/** Twitch-Fehler in verständliches Deutsch übersetzen */
function explain(err: unknown): Error {
  if (err instanceof HttpError) return err;
  const message = (err as Error)?.message ?? String(err);
  if (/nicht (bei Twitch )?eingeloggt/i.test(message)) return new HttpError(401, 'Du bist nicht bei Twitch eingeloggt. Verbinde dich zuerst in der Übersicht.');
  if (/Twitch API 401/.test(message)) return new HttpError(401, 'Der Twitch-Login ist abgelaufen – bitte in der Übersicht neu verbinden.');
  if (/Twitch API 403/.test(message)) {
    return new HttpError(403, 'Die Suite darf Titel und Kategorie nicht ändern. Verbinde dich einmal neu mit Twitch (Übersicht), damit die Rechte stimmen.');
  }
  if (/Twitch API 429/.test(message)) return new HttpError(429, 'Zu viele Änderungen in kurzer Zeit – warte einen Moment und versuch es nochmal.');
  if (/Twitch API 400/.test(message)) {
    if (/tag/i.test(message)) return new HttpError(400, `Twitch hat die Tags abgelehnt (nur Buchstaben und Zahlen, max. ${MAX_TAG_LEN} Zeichen, max. ${MAX_TAGS} Stück, manche Wörter sind gesperrt). Twitch sagt: ${message.replace(/^Twitch API 400:\s*/, '')}`);
    if (/game/i.test(message)) return new HttpError(400, 'Twitch kennt diese Kategorie nicht (mehr). Such sie bitte nochmal neu.');
    if (/title/i.test(message)) return new HttpError(400, `Twitch hat den Titel abgelehnt. Twitch sagt: ${message.replace(/^Twitch API 400:\s*/, '')}`);
    if (/language/i.test(message)) return new HttpError(400, 'Twitch kennt diese Sprache nicht.');
    return new HttpError(400, `Twitch hat die Änderung abgelehnt: ${message.replace(/^Twitch API 400:\s*/, '')}`);
  }
  if (/Twitch API 5\d\d/.test(message)) return new HttpError(502, 'Twitch hat gerade technische Probleme. Versuch es gleich nochmal.');
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(message)) return new HttpError(502, 'Keine Verbindung zu Twitch. Ist das Internet da?');
  return err instanceof Error ? err : new Error(message);
}

// ------------------------------------------------------------------ Addon

export const streaminfoAddon: Addon = {
  id: 'streaminfo',
  name: 'Stream-Info',
  icon: '📝',
  version: '0.1.0',
  author: 'Mini',
  description: 'Titel, Kategorie, Tags und Sprache direkt ändern. Mit Vorlagen für einen Klick, zuletzt benutzten Titeln und !title / !game für Mods.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);

    /** Letzter bekannter Stand bei Twitch (null = noch nicht geladen) */
    let current: ChannelInfo | null = null;
    /** Warum der Stand nicht geladen werden konnte */
    let loadError: string | null = null;
    /** Box-Art pro Kategorie-ID (spart Anfragen) */
    const artCache = new Map<string, string>();
    let lastAsk = { title: 0, game: 0 };

    const requireUser = () => {
      const user = ctx.getUser();
      if (!user) throw new HttpError(401, 'Du bist nicht bei Twitch eingeloggt. Verbinde dich zuerst in der Übersicht.');
      return user;
    };

    // -------------------------------------------------------- Twitch

    const fetchBoxArt = async (id: string): Promise<string> => {
      if (!id) return '';
      if (artCache.has(id)) return artCache.get(id)!;
      try {
        const res = await ctx.twitch.request<{ data: { id: string; box_art_url: string }[] }>('GET', '/games', { query: { id } });
        const image = boxArt(res.data[0]?.box_art_url);
        artCache.set(id, image);
        return image;
      } catch {
        return '';
      }
    };

    /** Aktuellen Stand von Twitch holen */
    const loadInfo = async (): Promise<ChannelInfo | null> => {
      const user = ctx.getUser();
      if (!user) {
        current = null;
        loadError = null;
        return null;
      }
      try {
        const res = await ctx.twitch.request<{
          data: { title: string; game_id: string; game_name: string; tags?: string[]; broadcaster_language: string }[];
        }>('GET', '/channels', { query: { broadcaster_id: user.id } });
        const d = res.data[0];
        if (!d) throw new Error('Kanal nicht gefunden');
        current = {
          title: d.title ?? '',
          category: d.game_id ? { id: d.game_id, name: d.game_name, image: await fetchBoxArt(d.game_id) } : null,
          tags: d.tags ?? [],
          language: d.broadcaster_language || 'other',
        };
        loadError = null;
      } catch (err) {
        loadError = explain(err).message;
      }
      return current;
    };

    /** Titel/Kategorie in die „Zuletzt benutzt“-Listen */
    const remember = (title: string | undefined, category: Category | null | undefined) => {
      const patch: Partial<Settings> = {};
      if (title) {
        patch.recentTitles = [title, ...settings.get('recentTitles').filter((t) => t !== title)].slice(0, MAX_RECENT);
      }
      if (category) {
        patch.recentCategories = [category, ...settings.get('recentCategories').filter((c) => c.id !== category.id)].slice(0, MAX_RECENT);
      }
      if (Object.keys(patch).length) settings.update(patch);
    };

    /** Allen offenen Stream-Info-Seiten den neuen Stand schicken */
    const pushInfo = () => ctx.overlay.broadcast({ type: 'info', info: current, error: loadError });

    /** Eine Änderung an Twitch schicken (ein einziges PATCH) */
    const saveInfo = async (patch: InfoPatch) => {
      const user = requireUser();
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) {
        const title = oneLine(patch.title, 1000);
        if (!title) throw new HttpError(400, 'Der Titel darf nicht leer sein.');
        if (title.length > MAX_TITLE) throw new HttpError(400, `Der Titel ist zu lang (${title.length} von höchstens ${MAX_TITLE} Zeichen).`);
        body.title = title;
      }
      if (patch.category !== undefined) body.game_id = patch.category?.id ?? '';
      if (patch.tags !== undefined) body.tags = patch.tags;
      if (patch.language !== undefined) body.broadcaster_language = patch.language;
      if (!Object.keys(body).length) throw new HttpError(400, 'Es gibt nichts zu speichern.');

      await ctx.twitch.request('PATCH', '/channels', { query: { broadcaster_id: user.id }, body }).catch((err) => {
        throw explain(err);
      });
      if (patch.category?.id && patch.category.image) artCache.set(patch.category.id, patch.category.image);
      if (patch.category && !patch.category.image) patch.category.image = await fetchBoxArt(patch.category.id);
      remember(body.title as string | undefined, patch.category);

      // Neu laden (falls sich woanders auch etwas geändert hat). Twitch liefert direkt nach dem
      // Speichern manchmal noch den alten Stand – deshalb das Gespeicherte auf jeden Fall drüberlegen.
      const before = current;
      await loadInfo();
      const base = current ?? before;
      current = {
        title: (body.title as string) ?? base?.title ?? '',
        category: patch.category !== undefined ? patch.category : base?.category ?? null,
        tags: patch.tags ?? base?.tags ?? [],
        language: patch.language ?? base?.language ?? 'other',
      };
      pushInfo();
      ctx.log.info(`Stream-Info geändert: ${Object.keys(body).join(', ')}`);
    };

    /** Kategorien bei Twitch suchen */
    const searchCategories = async (q: string): Promise<Category[]> => {
      requireUser();
      const res = await ctx.twitch
        .request<{ data: { id: string; name: string; box_art_url: string }[] }>('GET', '/search/categories', { query: { query: q, first: '12' } })
        .catch((err) => {
          throw explain(err);
        });
      return res.data.map((g) => ({ id: g.id, name: g.name, image: boxArt(g.box_art_url) }));
    };

    // -------------------------------------------------------- Variablen im Titel

    /**
     * Titel einer Vorlage mit Variablen ausfüllen. Eigene Variablen: {datum}, {wochentag}, {nr}.
     * {game} zeigt die Kategorie der Vorlage (nicht die alte). Alles andere macht der Core ({channel}, {random:1-6} …).
     */
    const renderTitle = async (template: string, nr: number, category: Category | null) => {
      const now = new Date();
      const values: Record<string, string> = {
        datum: now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        wochentag: WEEKDAYS[now.getDay()],
        nr: String(nr),
      };
      if (category) values.game = category.name;
      return oneLine(await ctx.chat.render(template, { values }), 1000);
    };
    const usesCounter = (template: string) => /\{nr\}/i.test(template);

    // -------------------------------------------------------- Vorlagen

    const parsePreset = (input: unknown, id: string): Preset => {
      const p = (input ?? {}) as Partial<Preset>;
      const name = oneLine(p.name, 60);
      if (!name) throw new HttpError(400, 'Die Vorlage braucht einen Namen.');
      const title = oneLine(p.title, 500);
      return {
        id,
        name,
        title,
        category: parseCategory(p.category),
        tags: p.tags === null || p.tags === undefined ? null : cleanTags(p.tags),
        language: p.language ? cleanLanguage(p.language) : '',
      };
    };

    const findPreset = (id: unknown) => {
      const preset = settings.get('presets').find((p) => p.id === id);
      if (!preset) throw new HttpError(404, 'Vorlage nicht gefunden.');
      return preset;
    };

    const applyPreset = async (preset: Preset) => {
      const nr = settings.get('counter') + 1;
      const patch: InfoPatch = {};
      if (preset.title) {
        const title = await renderTitle(preset.title, nr, preset.category);
        if (title.length > MAX_TITLE) {
          throw new HttpError(400, `Mit eingesetzten Variablen ist der Titel ${title.length} Zeichen lang – Twitch erlaubt höchstens ${MAX_TITLE}.`);
        }
        patch.title = title;
      }
      if (preset.category) patch.category = { ...preset.category };
      if (preset.tags) patch.tags = [...preset.tags];
      if (preset.language) patch.language = preset.language;
      await saveInfo(patch);
      if (preset.title && usesCounter(preset.title)) settings.set('counter', nr);
    };

    // -------------------------------------------------------- Chat: !title / !game

    const reply = (text: string, messageId: string) =>
      ctx.chat.send(text, messageId).catch((err) => ctx.log.warn('Chat-Nachricht fehlgeschlagen:', err));

    ctx.events.on('chat', async (event: EventOfType<'chat'>) => {
      if (event.test || ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(event.user.id)) return;
      const chat = settings.get('chat');
      if (!chat.enabled) return;
      const text = event.message.trim();
      if (!text.startsWith('!')) return;
      const [first, ...rest] = text.slice(1).split(/\s+/);
      const cmd = (first ?? '').toLowerCase();
      const kind = cmd && cmd === chat.titleCmd ? 'title' : cmd && cmd === chat.gameCmd ? 'game' : null;
      if (!kind) return;

      const broadcaster = ctx.getUser();
      if (!broadcaster) return;
      const level = roleLevel(event.badges, event.user.id === broadcaster.id);
      const allowed = level >= ROLE_LEVEL[chat.minRole];
      const arg = oneLine(rest.join(' '), 500);

      // Ohne Text: aktuellen Stand zeigen
      if (!arg) {
        if (!allowed) {
          if (!chat.everyoneCanAsk) return;
          if (Date.now() - lastAsk[kind] < ASK_COOLDOWN_MS) return;
        }
        lastAsk = { ...lastAsk, [kind]: Date.now() };
        const info = (await loadInfo()) ?? current;
        if (!info) return;
        if (kind === 'title') reply(`Aktueller Titel: ${info.title || '(keiner)'}`, event.messageId);
        else reply(`Aktuelle Kategorie: ${info.category?.name ?? '(keine)'}`, event.messageId);
        return;
      }

      if (!allowed) return;
      try {
        if (kind === 'title') {
          if (arg.length > MAX_TITLE) {
            reply(`❌ Der Titel ist zu lang (${arg.length} von höchstens ${MAX_TITLE} Zeichen).`, event.messageId);
            return;
          }
          await saveInfo({ title: arg });
          reply(`✅ Neuer Titel: ${arg}`, event.messageId);
          ctx.log.info(`${event.user.name} hat den Titel geändert`);
        } else {
          const found = await searchCategories(arg);
          // Genauer Treffer (ohne Groß/Klein) gewinnt, sonst der erste
          const hit = found.find((c) => c.name.toLowerCase() === arg.toLowerCase()) ?? found[0];
          if (!hit) {
            reply(`❌ Keine Kategorie zu „${arg}“ gefunden.`, event.messageId);
            return;
          }
          await saveInfo({ category: hit });
          reply(`✅ Neue Kategorie: ${hit.name}`, event.messageId);
          ctx.log.info(`${event.user.name} hat die Kategorie auf „${hit.name}“ geändert`);
        }
      } catch (err) {
        reply(`❌ Das hat nicht geklappt: ${explain(err).message}`, event.messageId);
      }
    });

    // -------------------------------------------------------- Änderungen von außen

    // Titel oder Kategorie geändert (auch im Twitch-Dashboard) → neu laden und der Seite Bescheid geben
    ctx.events.on('channelupdate', async (event) => {
      if (event.test) return;
      await loadInfo();
      let category: Category | null = null;
      if (event.categoryId) {
        category = current?.category?.id === event.categoryId
          ? current.category
          : { id: event.categoryId, name: event.categoryName, image: await fetchBoxArt(event.categoryId) };
      }
      // Das Event ist der neueste Stand – falls Twitch beim Laden noch den alten geliefert hat
      if (current) current = { ...current, title: event.title, category };
      remember(event.title, category);
      pushInfo();
    });

    // Beim Start: Stand holen, sobald der Login da ist
    let tries = 0;
    let startup: NodeJS.Timeout | null = null;
    const initialLoad = async () => {
      if (!ctx.getUser()) {
        if (++tries < 30) startup = setTimeout(initialLoad, 2000);
        return;
      }
      await loadInfo();
      pushInfo();
    };
    startup = setTimeout(initialLoad, 1000);
    ctx.onDispose(() => {
      if (startup) clearTimeout(startup);
    });

    // -------------------------------------------------------- API

    const publicState = () => ({
      loggedIn: !!ctx.getUser(),
      info: ctx.getUser() ? current : null,
      error: loadError,
      presets: settings.get('presets'),
      recentTitles: settings.get('recentTitles'),
      recentCategories: settings.get('recentCategories'),
      counter: settings.get('counter'),
      chat: settings.get('chat'),
      channelPointsActive: !!ctx.use('channelpoints'),
    });

    ctx.api.get('/state', async () => {
      if (!current || !ctx.getUser()) await loadInfo();
      return publicState();
    });

    ctx.api.post('/refresh', async () => {
      await loadInfo();
      pushInfo();
      return publicState();
    });

    /** { title?, category? (null = entfernen), tags?, language? } – alles in einem PATCH */
    ctx.api.post('/save', async ({ body }) => {
      const patch: InfoPatch = {};
      if (body?.title !== undefined) patch.title = String(body.title);
      if (body?.category !== undefined) {
        patch.category = body.category === null ? null : parseCategory(body.category);
        if (body.category !== null && !patch.category) throw new HttpError(400, 'Ungültige Kategorie.');
      }
      if (body?.tags !== undefined) patch.tags = cleanTags(body.tags);
      if (body?.language !== undefined) patch.language = cleanLanguage(body.language);
      await saveInfo(patch);
      return publicState();
    });

    ctx.api.get('/categories/search', async ({ query }) => {
      const q = String(query.get('q') ?? '').trim().slice(0, 100);
      if (!q) return [];
      return searchCategories(q);
    });

    /** Vorschau eines Titels mit Variablen (zählt nichts hoch) */
    ctx.api.post('/preview', async ({ body }) => {
      const template = oneLine(body?.title, 500);
      const title = await renderTitle(template, settings.get('counter') + 1, parseCategory(body?.category));
      return { title, length: title.length, max: MAX_TITLE };
    });

    ctx.api.post('/presets/save', ({ body }) => {
      const presets = settings.get('presets');
      const id = typeof body?.id === 'string' && presets.some((p) => p.id === body.id) ? body.id : newId();
      const preset = parsePreset(body, id);
      const index = presets.findIndex((p) => p.id === id);
      if (index < 0 && presets.length >= MAX_PRESETS) throw new HttpError(400, `Höchstens ${MAX_PRESETS} Vorlagen.`);
      settings.set('presets', index < 0 ? [...presets, preset] : presets.map((p) => (p.id === id ? preset : p)));
      return publicState();
    });

    ctx.api.post('/presets/duplicate', ({ body }) => {
      const preset = findPreset(body?.id);
      const presets = settings.get('presets');
      if (presets.length >= MAX_PRESETS) throw new HttpError(400, `Höchstens ${MAX_PRESETS} Vorlagen.`);
      const copy: Preset = { ...structuredClone(preset), id: newId(), name: `${preset.name} (Kopie)`.slice(0, 60) };
      const index = presets.findIndex((p) => p.id === preset.id);
      settings.set('presets', [...presets.slice(0, index + 1), copy, ...presets.slice(index + 1)]);
      return publicState();
    });

    ctx.api.post('/presets/delete', ({ body }) => {
      settings.set('presets', settings.get('presets').filter((p) => p.id !== body?.id));
      return publicState();
    });

    /** { ids } – neue Reihenfolge */
    ctx.api.post('/presets/order', ({ body }) => {
      const ids: unknown[] = Array.isArray(body?.ids) ? body.ids : [];
      const presets = settings.get('presets');
      const sorted = [
        ...ids.map((id) => presets.find((p) => p.id === id)).filter((p): p is Preset => !!p),
        ...presets.filter((p) => !ids.includes(p.id)),
      ];
      settings.set('presets', sorted);
      return publicState();
    });

    ctx.api.post('/presets/apply', async ({ body }) => {
      await applyPreset(findPreset(body?.id));
      return publicState();
    });

    /** { kind: 'title', value } – Titel aus „Zuletzt benutzt“ entfernen */
    ctx.api.post('/recent/remove', ({ body }) => {
      if (body?.kind === 'title') settings.set('recentTitles', settings.get('recentTitles').filter((t) => t !== body.value));
      return publicState();
    });

    ctx.api.post('/settings', ({ body }) => {
      if (body?.counter !== undefined) settings.set('counter', Math.max(0, Math.min(1_000_000, Math.round(Number(body.counter) || 0))));
      if (body?.chat) {
        const c = body.chat;
        const old = settings.get('chat');
        const clean = (v: unknown) => String(v ?? '').trim().replace(/^!+/, '').toLowerCase();
        const titleCmd = c.titleCmd !== undefined ? clean(c.titleCmd) : old.titleCmd;
        const gameCmd = c.gameCmd !== undefined ? clean(c.gameCmd) : old.gameCmd;
        for (const name of [titleCmd, gameCmd]) {
          if (name && !CMD_RE.test(name)) throw new HttpError(400, `Ungültiger Command-Name: „${name}“.`);
        }
        if (titleCmd && titleCmd === gameCmd) throw new HttpError(400, `„!${titleCmd}“ ist doppelt vergeben.`);
        const minRole = parseRole(c.minRole ?? old.minRole, 'moderator');
        settings.set('chat', {
          enabled: typeof c.enabled === 'boolean' ? c.enabled : old.enabled,
          titleCmd,
          gameCmd,
          // Ändern darf mindestens ein VIP – sonst könnte jeder Zuschauer den Titel umstellen
          minRole: ROLE_LEVEL[minRole] < ROLE_LEVEL.vip ? 'vip' : minRole,
          everyoneCanAsk: typeof c.everyoneCanAsk === 'boolean' ? c.everyoneCanAsk : old.everyoneCanAsk,
        });
      }
      return publicState();
    });
  },
};
