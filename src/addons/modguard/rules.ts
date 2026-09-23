/**
 * Spam-Schutz: die reine Prüf-Logik. Keine Electron-, Datei- oder Twitch-Aufrufe –
 * nur Text rein, Ergebnis raus. So lässt sich alles später leicht testen.
 */

// ------------------------------------------------------------------ Datenmodell

/** Was bei einem Treffer passiert: nur löschen, löschen + Timeout, nur Warnung im Chat */
export type ActionKind = 'delete' | 'timeout' | 'warn';
export const ACTIONS: ActionKind[] = ['delete', 'timeout', 'warn'];

export type RuleId = 'links' | 'caps' | 'words' | 'repeat' | 'symbols';
export const RULE_IDS: RuleId[] = ['links', 'caps', 'words', 'repeat', 'symbols'];

export const RULE_NAMES: Record<RuleId, string> = {
  links: 'Links',
  caps: 'Großbuchstaben',
  words: 'Verbotene Wörter',
  repeat: 'Wiederholungen',
  symbols: 'Zeichen & Emotes',
};

/** Rollen-Stufen wie im Core (0 = alle … 4 = du selbst) */
export const LEVEL = { everyone: 0, subscriber: 1, vip: 2, moderator: 3, broadcaster: 4 } as const;
export type Role = keyof typeof LEVEL;
export const ROLES = Object.keys(LEVEL) as Role[];
export const ROLE_LABELS: Record<Role, string> = {
  everyone: 'Alle', subscriber: 'Subs', vip: 'VIPs', moderator: 'Mods', broadcaster: 'Du selbst',
};

/** Ab dieser Rolle ist man ausgenommen. Mods und du selbst sind es immer. */
export type ExemptRole = 'subscriber' | 'vip' | 'moderator';

export interface RuleBase {
  enabled: boolean;
  action: ActionKind;
  /** Timeout-Dauer in Sekunden (nur bei action = "timeout") */
  timeoutSeconds: number;
  /** Subs sind von dieser Regel ausgenommen */
  exemptSubs: boolean;
  /** Warnung im Chat, {user} = Name. Leer = keine Warnung. */
  message: string;
}

export interface LinkRule extends RuleBase {
  /** Erlaubte Domains (Subdomains zählen mit), z.B. "twitch.tv" */
  allowDomains: string[];
  /** Auch „twitch . tv“ oder „twitch(dot)tv“ erkennen */
  catchObfuscated: boolean;
}

export interface CapsRule extends RuleBase {
  /** Erst ab so vielen Buchstaben prüfen (kurze Rufe wie „GG“ sind ok) */
  minLength: number;
  /** Höchstens so viel Prozent Großbuchstaben */
  maxPercent: number;
}

export interface WordsRule extends RuleBase {
  /** Ein Eintrag pro Wort. * = beliebige Buchstaben, z.B. "idiot*" */
  words: string[];
  /** Diese Wörter führen immer sofort zum Timeout */
  severeWords: string[];
  severeTimeoutSeconds: number;
}

export interface RepeatRule extends RuleBase {
  /** So oft dieselbe Nachricht … */
  count: number;
  /** … innerhalb dieser Sekunden */
  windowSeconds: number;
}

export interface SymbolsRule extends RuleBase {
  /** Höchstens so viele Emotes/Emojis in einer Nachricht (0 = egal) */
  maxEmotes: number;
  /** Höchstens so viel Prozent Sonderzeichen (0 = egal) */
  maxSymbolPercent: number;
  /** Sonderzeichen erst ab so vielen Zeichen prüfen */
  minLength: number;
}

export interface Rules {
  links: LinkRule;
  caps: CapsRule;
  words: WordsRule;
  repeat: RepeatRule;
  symbols: SymbolsRule;
}

export interface Escalation {
  enabled: boolean;
  /** Verstöße zählen so lange (Minuten seit dem letzten Verstoß) */
  windowMinutes: number;
  /** Timeouts ab dem 2. Verstoß, z.B. [60, 300, 600] – der letzte gilt danach immer */
  timeouts: number[];
}

export interface ModSettings {
  /** Nur testen: protokollieren, was passieren würde, aber nichts tun */
  dryRun: boolean;
  exemptRole: ExemptRole;
  /** Logins, die nie moderiert werden */
  allowUsers: string[];
  /** Mindestabstand zwischen zwei Warnungen im Chat (Sekunden, für alle zusammen) */
  warnGapSeconds: number;
  /** !permit: Command-Name (ohne !), Dauer, Bestätigung im Chat */
  permit: { command: string; seconds: number; message: string };
  escalation: Escalation;
  rules: Rules;
}

export const DEFAULT_SETTINGS: ModSettings = {
  dryRun: true,
  exemptRole: 'vip',
  allowUsers: [],
  warnGapSeconds: 20,
  permit: { command: 'permit', seconds: 60, message: '{user} darf in den nächsten {seconds} Sekunden einen Link posten.' },
  escalation: { enabled: false, windowMinutes: 30, timeouts: [60, 300, 600] },
  rules: {
    links: {
      enabled: true, action: 'delete', timeoutSeconds: 60, exemptSubs: false,
      message: '@{user} Bitte keine Links ohne Erlaubnis 🙏',
      allowDomains: ['twitch.tv', 'clips.twitch.tv', 'youtube.com', 'youtu.be'],
      catchObfuscated: false,
    },
    caps: {
      enabled: false, action: 'delete', timeoutSeconds: 30, exemptSubs: false,
      message: '@{user} Bitte nicht so viel in Großbuchstaben schreiben 🙉',
      minLength: 15, maxPercent: 70,
    },
    words: {
      enabled: true, action: 'delete', timeoutSeconds: 60, exemptSubs: false,
      message: '@{user} Bitte achte auf deine Wortwahl.',
      words: [], severeWords: [], severeTimeoutSeconds: 600,
    },
    repeat: {
      enabled: true, action: 'delete', timeoutSeconds: 60, exemptSubs: false,
      message: '@{user} Bitte nicht immer wieder das Gleiche schreiben.',
      count: 3, windowSeconds: 30,
    },
    symbols: {
      enabled: false, action: 'delete', timeoutSeconds: 30, exemptSubs: false,
      message: '@{user} Bitte nicht so viele Zeichen/Emotes auf einmal.',
      maxEmotes: 12, maxSymbolPercent: 60, minLength: 12,
    },
  },
};

/** Timeouts: 1 Sekunde bis 14 Tage (mehr erlaubt Twitch nicht). Dauerhafte Banns gibt es hier absichtlich nicht. */
export const MAX_TIMEOUT = 1_209_600;

// ------------------------------------------------------------------ Einstellungen prüfen

const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const oneLine = (v: unknown, max: number, fallback = '') =>
  typeof v === 'string' ? v.replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, max) : fallback;
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Liste aus Array oder Text (eine Zeile / Komma = ein Eintrag) */
function list(v: unknown, clean: (s: string) => string, max = 500): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\r\n,]+/) : [];
  return [...new Set(raw.map((s) => clean(s.trim())).filter(Boolean))].slice(0, max);
}

/** Domain säubern: "https://www.Twitch.tv/xyz" → "twitch.tv" */
export function cleanDomain(value: string): string {
  const host = value.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:\s]/)[0].replace(/\.+$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
}

const cleanLogin = (s: string) => {
  const login = s.replace(/^@/, '').toLowerCase();
  return /^\w{1,25}$/.test(login) ? login : '';
};
const cleanWord = (s: string) => s.replace(/\s+/g, ' ').slice(0, 60);

function ruleBase(input: Record<string, unknown>, def: RuleBase): RuleBase {
  return {
    enabled: bool(input.enabled, def.enabled),
    action: ACTIONS.includes(input.action as ActionKind) ? (input.action as ActionKind) : def.action,
    timeoutSeconds: int(input.timeoutSeconds, 1, MAX_TIMEOUT, def.timeoutSeconds),
    exemptSubs: bool(input.exemptSubs, def.exemptSubs),
    message: oneLine(input.message, 400, def.message),
  };
}

/**
 * Macht aus beliebigen (auch alten oder kaputten) Daten gültige Einstellungen.
 * Fehlendes wird mit Standardwerten gefüllt, Zahlen werden auf sinnvolle Grenzen gesetzt.
 */
export function normalizeSettings(input: unknown): ModSettings {
  const d = DEFAULT_SETTINGS;
  const s = obj(input);
  const r = obj(s.rules);
  const permit = obj(s.permit);
  const esc = obj(s.escalation);
  const links = obj(r.links);
  const caps = obj(r.caps);
  const words = obj(r.words);
  const repeat = obj(r.repeat);
  const symbols = obj(r.symbols);
  const command = oneLine(permit.command, 30, d.permit.command).replace(/^!+/, '').toLowerCase();
  const timeouts = (Array.isArray(esc.timeouts) ? esc.timeouts : typeof esc.timeouts === 'string' ? esc.timeouts.split(/[\s,;]+/) : d.escalation.timeouts)
    .map((t) => int(t, 1, MAX_TIMEOUT, 0))
    .filter((t) => t > 0)
    .slice(0, 10);

  return {
    dryRun: bool(s.dryRun, d.dryRun),
    exemptRole: (['subscriber', 'vip', 'moderator'] as const).includes(s.exemptRole as ExemptRole) ? (s.exemptRole as ExemptRole) : d.exemptRole,
    allowUsers: s.allowUsers === undefined ? d.allowUsers : list(s.allowUsers, cleanLogin),
    warnGapSeconds: int(s.warnGapSeconds, 0, 3600, d.warnGapSeconds),
    permit: {
      command: /^[\p{L}\p{N}_-]{1,30}$/u.test(command) ? command : d.permit.command,
      seconds: int(permit.seconds, 5, 3600, d.permit.seconds),
      message: oneLine(permit.message, 400, d.permit.message),
    },
    escalation: {
      enabled: bool(esc.enabled, d.escalation.enabled),
      windowMinutes: int(esc.windowMinutes, 1, 24 * 60, d.escalation.windowMinutes),
      timeouts: timeouts.length ? timeouts : [...d.escalation.timeouts],
    },
    rules: {
      links: {
        ...ruleBase(links, d.rules.links),
        allowDomains: links.allowDomains === undefined ? [...d.rules.links.allowDomains] : list(links.allowDomains, cleanDomain),
        catchObfuscated: bool(links.catchObfuscated, d.rules.links.catchObfuscated),
      },
      caps: {
        ...ruleBase(caps, d.rules.caps),
        minLength: int(caps.minLength, 1, 500, d.rules.caps.minLength),
        maxPercent: int(caps.maxPercent, 10, 100, d.rules.caps.maxPercent),
      },
      words: {
        ...ruleBase(words, d.rules.words),
        words: list(words.words, cleanWord),
        severeWords: list(words.severeWords, cleanWord),
        severeTimeoutSeconds: int(words.severeTimeoutSeconds, 1, MAX_TIMEOUT, d.rules.words.severeTimeoutSeconds),
      },
      repeat: {
        ...ruleBase(repeat, d.rules.repeat),
        count: int(repeat.count, 2, 20, d.rules.repeat.count),
        windowSeconds: int(repeat.windowSeconds, 5, 3600, d.rules.repeat.windowSeconds),
      },
      symbols: {
        ...ruleBase(symbols, d.rules.symbols),
        maxEmotes: int(symbols.maxEmotes, 0, 200, d.rules.symbols.maxEmotes),
        maxSymbolPercent: int(symbols.maxSymbolPercent, 0, 100, d.rules.symbols.maxSymbolPercent),
        minLength: int(symbols.minLength, 1, 500, d.rules.symbols.minLength),
      },
    },
  };
}

// ------------------------------------------------------------------ Links

/** Endungen, die fast nur als Domain vorkommen → auch ohne https:// ein Link */
const STRONG_TLDS = new Set([
  'com', 'net', 'org', 'tv', 'gg', 'io', 'ly', 'xyz', 'ru', 'su', 'de', 'co', 'uk', 'eu', 'us', 'info', 'biz', 'app', 'dev',
  'link', 'live', 'site', 'online', 'shop', 'store', 'club', 'fun', 'top', 'gl', 'ws', 'cc', 'nl', 'fr', 'pl', 'cz', 'ch',
  'ua', 'tk', 'ml', 'ga', 'cf', 'gq', 'sh', 'fm', 'pw', 'click', 'xxx', 'porn', 'sex', 'gift', 'gifts', 'win', 'bid',
  'stream', 'tube', 'vip', 'pro', 'cloud', 'space', 'website', 'tech', 'news', 'social', 'games', 'money', 'cn', 'jp',
  'br', 'pt', 'dk', 'fi', 'ai', 'gd', 'lol', 'bio', 'media', 'icu', 'buzz', 'cam', 'tw', 'kr', 'hu', 'ro', 'gr', 'sk',
  'nu', 'im', 'ms', 'sx', 'vg', 'cx', 'st', 'zone', 'world', 'life', 'today', 'email', 'host', 'page', 'blog', 'chat',
  'art', 'sale', 'cash', 'team', 'network', 'digital', 'work', 'party', 'date', 'download', 'loan', 'cyou', 'rest',
  'sbs', 'quest', 'skin', 'ooo', 'rip', 'wtf', 'bet', 'casino', 'poker', 'nft', 'crypto', 'finance', 'exchange',
]);
/** Endungen, die auch normale Wörter sind („Danke.Es“) → nur mit Pfad („t.me/xyz“) ein Link */
const WEAK_TLDS = new Set(['me', 'to', 'be', 'it', 'es', 'at', 'am', 'in', 'is', 'so', 'no', 'se', 'do', 'my', 'ma', 'id', 'la', 'ca', 'ac', 'gs']);

const SCHEME_RE = /(?:\bhttps?:\/\/|(?<![\p{L}\p{N}.@-])www\.)([^\s/?#<>"']+)/giu;
const BARE_RE = /(?<![\p{L}\p{N}@._\/-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?![\p{L}\p{N}-])(\/\S*)?/giu;

/** „twitch . tv“, „twitch(dot)tv“, „twitch [.] tv“, „twitch dot tv“ → „twitch.tv“ */
function deobfuscate(text: string): string {
  return text
    .replace(/\s*[([{]\s*(?:dot|punkt|\.)\s*[)\]}]\s*/giu, '.')
    .replace(/(?<=[a-z0-9])\s+(?:dot|punkt)\s+(?=[a-z])/giu, '.')
    .replace(/(?<=[a-z0-9])\s+\.\s+(?=[a-z])/giu, '.');
}

/** Alle Domains, die in einem Text als Link erkannt werden (klein geschrieben, ohne www.) */
export function findDomains(text: string, catchObfuscated = false): string[] {
  const found = new Set<string>();
  const scan = (t: string, strongOnly: boolean) => {
    if (!strongOnly) {
      for (const m of t.matchAll(SCHEME_RE)) {
        const host = cleanDomain(m[1]) || m[1].toLowerCase();
        found.add(host);
      }
    }
    for (const m of t.matchAll(BARE_RE)) {
      const tld = m[2].toLowerCase();
      const hasPath = !!m[3] && m[3].length > 1;
      if (STRONG_TLDS.has(tld) || (!strongOnly && hasPath && WEAK_TLDS.has(tld))) {
        found.add(m[1].toLowerCase().replace(/^www\./, ''));
      }
    }
  };
  scan(text, false);
  if (catchObfuscated) {
    const plain = deobfuscate(text);
    // Bei „versteckten“ Links nur eindeutige Endungen, sonst gibt es zu viele Fehlalarme
    if (plain !== text) scan(plain, true);
  }
  return [...found];
}

/** Ist die Domain erlaubt? Subdomains zählen mit (clips.twitch.tv passt zu twitch.tv). */
export function isAllowedDomain(host: string, allow: string[]): boolean {
  return allow.some((d) => host === d || host.endsWith(`.${d}`));
}

// ------------------------------------------------------------------ Text-Helfer

/** Klein schreiben und Akzente/Zalgo entfernen („ÌḌÎÔṪ“ → „idiot“, „ä“ → „a“) */
export function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

/** Varianten eines Texts, in denen nach verbotenen Wörtern gesucht wird */
function wordVariants(text: string): string[] {
  const folded = fold(text);
  const leet = folded.replace(/[013457@$]/g, (c) => LEET[c]);
  // Einzelne Buchstaben mit Leerzeichen dazwischen zusammenziehen: „i d i o t“ → „idiot“ (erst ab 3 Buchstaben)
  const joined = leet.replace(/(?<![\p{L}\p{N}])\p{L}(?: \p{L}(?![\p{L}\p{N}])){2,}/gu, (m) => m.replace(/ /g, ''));
  return [...new Set([folded, leet, joined])];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Macht aus einem Listeneintrag eine Suche:
 *  - ganzes Wort („hass“ findet nicht „hasskappe“), * = beliebige Buchstaben („hass*“ findet „hasskappe“)
 *  - Buchstaben dürfen sich wiederholen („haaasss“) und mit . _ - getrennt sein („h.a.s.s“)
 */
export function wordPattern(entry: string): RegExp | null {
  if (patternCache.has(entry)) return patternCache.get(entry)!;
  if (patternCache.size > 2000) patternCache.clear();
  const re = buildPattern(entry);
  patternCache.set(entry, re);
  return re;
}

const patternCache = new Map<string, RegExp | null>();

function buildPattern(entry: string): RegExp | null {
  const clean = fold(entry).trim().replace(/\s+/g, ' ');
  if (!clean || /^\*+$/.test(clean)) return null;
  let body = '';
  let prevLetter = false;
  for (const ch of clean) {
    if (ch === '*') {
      body += '[\\p{L}\\p{N}]*';
      prevLetter = false;
    } else if (ch === ' ') {
      body += '\\s+';
      prevLetter = false;
    } else {
      body += `${prevLetter ? '[._-]?' : ''}${escapeRe(ch)}+`;
      prevLetter = true;
    }
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

/** Findet das erste passende Wort aus der Liste (oder null) */
export function findWord(text: string, entries: string[]): string | null {
  const variants = wordVariants(text);
  for (const entry of entries) {
    const re = wordPattern(entry);
    if (re && variants.some((v) => re.test(v))) return entry;
  }
  return null;
}

/** Nachrichtenteile, wie sie im Chat-Event stehen (Text, Emotes, Erwähnungen) */
export interface Fragment {
  type: string;
  text: string;
}

/** Nur der „echte“ Text (ohne Emotes und @Erwähnungen) */
function plainText(message: string, fragments?: Fragment[]): string {
  if (!fragments?.length) return message;
  return fragments.filter((f) => f.type === 'text').map((f) => f.text).join(' ');
}

/** Anteil Großbuchstaben (0–100) und Anzahl Buchstaben (ohne Emotes) */
export function capsRatio(text: string): { letters: number; percent: number } {
  let upper = 0;
  let letters = 0;
  for (const ch of text) {
    if (/\p{Lu}/u.test(ch)) {
      upper++;
      letters++;
    } else if (/\p{Ll}/u.test(ch)) {
      letters++;
    }
  }
  return { letters, percent: letters ? Math.round((upper / letters) * 100) : 0 };
}

const EMOJI_RE = /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*/gu;

/** Emotes (Twitch + Emojis) und Sonderzeichen zählen */
export function symbolStats(message: string, fragments?: Fragment[]): { emotes: number; symbols: number; chars: number; percent: number } {
  const twitchEmotes = fragments?.filter((f) => f.type === 'emote' || f.type === 'cheermote').length ?? 0;
  const text = plainText(message, fragments);
  const emojis = text.match(EMOJI_RE)?.length ?? 0;
  const rest = text.replace(EMOJI_RE, '').replace(/\s+/g, '');
  const chars = [...rest].length;
  const symbols = rest.match(/[\p{P}\p{S}\p{M}]/gu)?.length ?? 0;
  return { emotes: twitchEmotes + emojis, symbols, chars, percent: chars ? Math.round((symbols / chars) * 100) : 0 };
}

/** Vergleichs-Form für Wiederholungen: ohne Groß/Klein, Satzzeichen und Leerzeichen */
export function repeatKey(message: string): string {
  const key = fold(message).replace(/[^\p{L}\p{N}]+/gu, '');
  return key || message.trim().toLowerCase();
}

// ------------------------------------------------------------------ Merker (ohne Dateien, nur im Speicher)

/** Merkt sich die letzten Nachrichten pro Zuschauer, um Wiederholungen zu erkennen */
export class RepeatTracker {
  private recent = new Map<string, { key: string; time: number }[]>();

  /** Nachricht merken und zählen, wie oft sie im Zeitfenster schon kam (inklusive dieser) */
  add(userId: string, message: string, windowMs: number, now = Date.now()): number {
    const key = repeatKey(message);
    const list = (this.recent.get(userId) ?? []).filter((m) => now - m.time < windowMs);
    list.push({ key, time: now });
    this.recent.set(userId, list.slice(-30));
    return list.filter((m) => m.key === key).length;
  }

  /** Alte Einträge wegwerfen */
  prune(maxAgeMs: number, now = Date.now()): void {
    for (const [id, list] of this.recent) {
      if (!list.some((m) => now - m.time < maxAgeMs)) this.recent.delete(id);
    }
  }

  clear(): void {
    this.recent.clear();
  }
}

/** Zählt Verstöße pro Zuschauer für die Eskalation */
export class StrikeTracker {
  private strikes = new Map<string, { count: number; last: number }>();

  /** Wie viele Verstöße gab es schon (im Zeitfenster)? */
  peek(userId: string, windowMs: number, now = Date.now()): number {
    const s = this.strikes.get(userId);
    return s && now - s.last < windowMs ? s.count : 0;
  }

  /** Verstoß zählen, gibt die neue Anzahl zurück */
  add(userId: string, windowMs: number, now = Date.now()): number {
    const count = this.peek(userId, windowMs, now) + 1;
    this.strikes.set(userId, { count, last: now });
    return count;
  }

  forget(userId: string): void {
    this.strikes.delete(userId);
  }

  prune(windowMs: number, now = Date.now()): void {
    for (const [id, s] of this.strikes) if (now - s.last >= windowMs) this.strikes.delete(id);
  }

  clear(): void {
    this.strikes.clear();
  }
}

// ------------------------------------------------------------------ Prüfen

export interface Chatter {
  login: string;
  level: number;
  isBroadcaster: boolean;
  /** Bot-Account der Suite oder eine Nachricht, die die Suite selbst geschickt hat */
  isSuite: boolean;
}

/** Warum ist jemand ausgenommen? null = wird geprüft */
export function exemptReason(s: ModSettings, who: Chatter): string | null {
  if (who.isSuite) return 'Nachricht der Suite / des Bots';
  if (who.isBroadcaster || who.level >= LEVEL.broadcaster) return 'Das bist du selbst';
  if (who.level >= LEVEL.moderator) return 'Mods sind immer ausgenommen';
  if (who.level >= LEVEL[s.exemptRole]) return `Rolle ist ausgenommen (ab ${ROLE_LABELS[s.exemptRole]})`;
  if (s.allowUsers.includes(who.login.toLowerCase())) return 'Steht auf der Erlaubt-Liste';
  return null;
}


export interface CheckInput {
  message: string;
  fragments?: Fragment[];
  level: number;
  /** Darf gerade einen Link posten (!permit) */
  permitted: boolean;
  /** Wie oft kam genau diese Nachricht im Zeitfenster schon (inklusive dieser), siehe RepeatTracker */
  repeats: number;
}

export interface Hit {
  rule: RuleId;
  /** Kurze Begründung für das Protokoll, z.B. "Link: example.com" */
  reason: string;
  /** Wort aus der „Sofort-Timeout“-Liste */
  severe?: boolean;
  /** Link wurde nur wegen !permit erlaubt (dann ist das kein Treffer, aber der Permit ist verbraucht) */
  usedPermit?: boolean;
}

/**
 * Prüft eine Nachricht gegen alle Regeln. Gibt den ersten Treffer zurück (oder null).
 * Ausnahmen für Rollen/Nutzer prüft exemptReason() vorher; hier geht es nur um „Subs ausgenommen“ je Regel.
 * Ist nur ein !permit verbraucht worden, kommt { usedPermit: true } ohne Treffer zurück.
 */
export function checkMessage(s: ModSettings, input: CheckInput): { hit: Hit | null; usedPermit: boolean } {
  const { rules } = s;
  const isSub = input.level >= LEVEL.subscriber;
  const active = (id: RuleId) => rules[id].enabled && !(rules[id].exemptSubs && isSub);
  const text = plainText(input.message, input.fragments);
  let usedPermit = false;

  // 1. Verbotene Wörter (zuerst die schlimmen)
  if (active('words')) {
    const severe = findWord(input.message, rules.words.severeWords);
    if (severe) return { hit: { rule: 'words', reason: `Sofort-Timeout-Wort: „${severe}“`, severe: true }, usedPermit };
    const word = findWord(input.message, rules.words.words);
    if (word) return { hit: { rule: 'words', reason: `Wort: „${word}“` }, usedPermit };
  }

  // 2. Links
  if (active('links')) {
    const bad = findDomains(text, rules.links.catchObfuscated).filter((d) => !isAllowedDomain(d, rules.links.allowDomains));
    if (bad.length) {
      if (input.permitted) usedPermit = true;
      else return { hit: { rule: 'links', reason: `Link: ${bad.slice(0, 3).join(', ')}` }, usedPermit };
    }
  }

  // 3. Wiederholungen (Commands mit ! zählen nicht, die haben eigene Abklingzeiten)
  if (active('repeat') && !input.message.trim().startsWith('!') && input.repeats >= rules.repeat.count) {
    return { hit: { rule: 'repeat', reason: `${input.repeats}× dieselbe Nachricht in ${rules.repeat.windowSeconds} s` }, usedPermit };
  }

  // 4. Zu viele Emotes / Sonderzeichen
  if (active('symbols')) {
    const st = symbolStats(input.message, input.fragments);
    const r = rules.symbols;
    if (r.maxEmotes && st.emotes > r.maxEmotes) {
      return { hit: { rule: 'symbols', reason: `${st.emotes} Emotes (erlaubt: ${r.maxEmotes})` }, usedPermit };
    }
    if (r.maxSymbolPercent && st.chars >= r.minLength && st.percent > r.maxSymbolPercent) {
      return { hit: { rule: 'symbols', reason: `${st.percent} % Sonderzeichen (erlaubt: ${r.maxSymbolPercent} %)` }, usedPermit };
    }
  }

  // 5. Großbuchstaben (Emotes zählen nicht mit)
  if (active('caps')) {
    const c = capsRatio(text);
    if (c.letters >= rules.caps.minLength && c.percent > rules.caps.maxPercent) {
      return { hit: { rule: 'caps', reason: `${c.percent} % Großbuchstaben (erlaubt: ${rules.caps.maxPercent} %)` }, usedPermit };
    }
  }

  return { hit: null, usedPermit };
}

export interface Decision {
  action: ActionKind;
  /** Timeout in Sekunden (nur bei "timeout") */
  seconds: number;
  /** Warnung im Chat schicken (falls die Regel einen Text hat) */
  warn: boolean;
  /** Wievielter Verstoß (nur mit Eskalation, sonst 0) */
  strike: number;
}

/**
 * Was soll bei einem Treffer passieren?
 * strike = wievielter Verstoß das ist (inklusive diesem), nur wichtig mit Eskalation.
 *
 * Eskalation: 1. Verstoß = löschen + Warnung, jeder weitere = Timeout (wird länger).
 * Regeln mit „nur Warnung“ bleiben immer bei der Warnung und zählen nicht als Verstoß.
 */
export function decide(s: ModSettings, hit: Hit, strike: number): Decision {
  const rule = s.rules[hit.rule];
  const esc = s.escalation;
  const step = (n: number) => esc.timeouts[Math.min(Math.max(0, n - 2), esc.timeouts.length - 1)] ?? 60;

  if (hit.severe) {
    const seconds = esc.enabled ? Math.max(s.rules.words.severeTimeoutSeconds, step(strike)) : s.rules.words.severeTimeoutSeconds;
    return { action: 'timeout', seconds, warn: true, strike: esc.enabled ? strike : 0 };
  }
  if (rule.action === 'warn') return { action: 'warn', seconds: 0, warn: true, strike: 0 };
  if (esc.enabled) {
    if (strike <= 1) return { action: 'delete', seconds: 0, warn: true, strike };
    return { action: 'timeout', seconds: step(strike), warn: true, strike };
  }
  return { action: rule.action, seconds: rule.action === 'timeout' ? rule.timeoutSeconds : 0, warn: true, strike: 0 };
}

/** Zählt dieser Treffer als Verstoß für die Eskalation? */
export function countsAsStrike(s: ModSettings, hit: Hit): boolean {
  return s.escalation.enabled && (hit.severe === true || s.rules[hit.rule].action !== 'warn');
}

/** Dauer lesbar: 90 → "1 Min. 30 s" */
export function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const rest = sec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} ${d === 1 ? 'Tag' : 'Tage'}`);
  if (h) parts.push(`${h} Std.`);
  if (m) parts.push(`${m} Min.`);
  if (rest && !d) parts.push(`${rest} s`);
  return parts.join(' ');
}
