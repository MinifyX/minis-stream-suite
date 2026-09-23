// Sucht deutsche Oberflächen-Texte und prüft, ob es sie in public/app/i18n/en.json gibt.
//
//   npm run i18n:check          → listet Texte ohne Übersetzung (Exit-Code 1, wenn welche fehlen)
//   node scripts/i18n.mjs list  → alle gefundenen Texte als JSON (mit Datei und Zeile)
//
// Gescannt werden:
//   - alle Seiten unter public/, die /app/ui.js laden (Overlays für OBS bleiben bewusst Deutsch),
//     dazu alle Skripte, die diese Seiten einbinden
//   - src/**/*.ts: Fehlermeldungen (new HttpError / new Error), die als Toast im UI landen,
//     und Name/Beschreibung der Addons (Addon-Store)
//
// Ob ein Text „deutsch“ ist, entscheidet eine Faustregel (Umlaute, typische Wörter, Sätze,
// großgeschriebene Einzelwörter). Was trotzdem kein Oberflächen-Text ist, auf Englisch gleich heißt
// oder Nutzerdaten sind (Vorlagen für Chat-Nachrichten), steht unten in IGNORE, IGNORE_TEMPLATES und
// USER_DATA. Template-Strings (`… ${x} …`) brauchen in en.json ein passendes Pattern.
// Keine Abhängigkeiten, nur Node.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EN_FILE = path.join(root, 'public', 'app', 'i18n', 'en.json');

// ------------------------------------------------------------------ Ausnahmen

/** Texte, die auf Englisch genauso heißen oder keine Oberflächen-Texte sind */
const IGNORE = new Set([
  // gleiche Wörter auf Englisch
  'Alerts', 'Alert', 'Bits', 'Bot', 'Chat', 'Cheer', 'Cheers', 'Clip', 'Clips', 'Commands', 'Command', 'Countdown',
  'Emote', 'Emotes', 'Events', 'Event', 'Follow', 'Follows', 'Follower', 'Gift', 'Hype Train', 'Log', 'Lurk', 'Markdown',
  'Mod', 'Mods', 'Name', 'OBS', 'Overlay', 'Overlays', 'Raid', 'Raids', 'Resub', 'Shoutout', 'Shoutouts', 'Sub', 'Subs',
  'Text', 'Timer', 'Timeout', 'Twitch', 'Twitch Developer Console', 'Application Integration', 'Client-ID', 'Satellite',
  'Stream', 'Streamer', 'Tags', 'Tag', 'Test', 'Token', 'Top', 'Start', 'Status', 'Standard', 'Links', 'Link',
  'Modus', 'Filter', 'Plugin', 'Plugins', 'Addon', 'Addons', 'Chatterino', 'HudFX', 'VIP', 'VIPs',
  'Broadcaster', 'Streamer.bot', 'WebSocket', 'Voice', 'Volume', 'Input', 'Output', 'Info', 'Level', 'Hype',
  // Tastennamen, Schriften, technische Werte
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Shift', 'Control', 'Alt', 'Meta', 'Space', 'Home', 'End',
  'Insert', 'Pause', 'Inter', 'Arial', 'Segoe UI', 'Consolas', 'Georgia', 'Verdana', 'Impact', 'Tahoma',
  'Content-Type', 'GET', 'POST', 'Error', 'TestUser', 'Win', 'Esc', 'Play/Pause', 'App', 'Keybind', 'Cooldown', 'Lurks',
  // Namen und Sprachwahl bleiben, wie sie sind
  "Mini's Stream Suite", 'Stream Suite', 'Mini', 'English', 'Sprache / Language', "Chat – Mini's Stream Suite",
  'Live', 'Offline', 'Num', 'Num Enter', '(Golden Kappa!)',
  // Schnell-Antworten für Vorhersagen (landen so als Antwort im Formular = Nutzerdaten)
  'Schaff ich', 'Schaff ich nicht', 'Sieg', 'Niederlage',
  // Beispiel-Chat in der Vorschau (wird als Chat-Nachricht angezeigt und nie übersetzt)
  'Hallo zusammen!', 'Luna', '@Luna', 'zuschauer123', 'Kappa', 'Das war **mega** gut, *wirklich*! [regenbogen]GG[/]',
  'Denkt an die [gelb]Chat-Regeln[/] ✌️', 'Willkommen Raider! Hier ist `!discord` für euch ~~nicht~~',
  'Nightbot', 'Folgt gerne auf Insta!', 'Spoilerfan', 'Trollo', 'gelöschte Nachricht', 'Fragefix',
  // Beispielwerte in Vorschauen, die wie das echte Overlay aussehen (class="no-i18n")
  'Schon ein Jahr dabei!', 'Hydrate!', 'Text vom Zuschauer',
  // Alert-Editor: auf Englisch gleich
  'Normal', 'Medium', 'Black', 'Transparent', 'Greenscreen', 'Layout', 'Autoplay', 'Party', 'Pop', 'Fanfare',
  'Level-Up', 'Whoosh', 'Blip', 'Tada', 'Golden Kappa Train', 'Treasure Train', 'Tier 1 / Prime', 'Tier 2', 'Tier 3',
  'SOUND', 'BTTV', 'CAPS', 'COMMAND', 'RAIDS', 'Browser', 'Animation', 'Resubs', 'Emojis', 'Port', 'Position',
  'Partner', 'Affiliate', 'Hindi', 'Thai', 'Tagalog', 'Dashboard',
  'nur Golden Kappa', // Teil der Zusammenfassung „… · nur Golden Kappa“ (Pattern deckt den ganzen Text ab)
  'Geschenkeonkel', // Beispielname in der Vorschau
  '~~durchgestrichen~~', // Markdown-Beispiel im <code>
]);

/**
 * Template-Strings (als Pattern, wie `check` sie ausgibt), die nie allein angezeigt werden: Teilstücke, die
 * mit „ · “ oder += an einen anderen Text gehängt werden (die en.json-Patterns decken den ganzen Satz ab),
 * und Namen, die als Nutzerdaten gespeichert werden.
 */
const IGNORE_TEMPLATES = new Set([
  '^Tier (.+)$', '^ab (.+) Monaten$', '^ab Level (.+)$', // Alert-Editor: Teile der Zusammenfassung
  '^Variante (.+)$', '^(.+) \\(Kopie\\)$', // Namen neuer Varianten (Nutzerdaten)
  '^@(.+) spielst du nachher noch was anderes\\?$', // Chat: Beispiel-Nachricht in der Vorschau
  '^· (.+) 🔒 übersprungen$', '^· (.+) übersprungen \\(🔒\\)$', '^(.+) Belohnung\\(en\\) (.+)$', // Kanalpunkte: Toast in Teilen
  '^Deine Korrektur: (.+)(.+)\\.$', '^Davon von Hand korrigiert: (.+)(.+)\\.$', // Ziele: Zusatz zum Info-Text
  '^→ (.+)(.+)$', // Spam-Schutz-Test: „→ Löschen + Timeout …“ (Patterns für die fertigen Texte)
  '^👁 (.+) (.+)(.+)$', '^✨ (.+) (.+)(.+)$', // OBS: Schritte mit Namen aus OBS (class="no-i18n")
  // Werbepausen: ${fmtSeconds(…)} ist immer „30 s“, „1 Min.“ oder „1 Min. 30 s“ – dafür gibt es eigene Patterns
  '^Jetzt (.+) Werbung starten\\? Deine Zuschauer sehen dann sofort Werbung\\.$', '^Werbung gestartet \\((.+)\\)$',
  // auf Englisch gleich
  '^Num (.+)$', '^Twitch: (.+)$',
]);

/** Deutsche Wörter, an denen man Texte erkennt (klein, ohne Wörter, die es auch auf Englisch gibt) */
const GERMAN_WORDS = new Set(`
  der das den dem des ein eine einen einem einer eines kein keine keinen keiner keins und oder aber nicht nur
  noch schon auch mit ohne von vom zum zur im auf aus bei bis nach vor unter ist sind wird werden wurde wurden
  haben kann muss soll darf du dich dein deine deinen deiner dir wir sie er es hier wenn dann als wie was wer wo
  halten alle alles jede jeder jedes neu neue neuen neuer neues bitte ja nein sek std sekunden minuten stunden tage
  tagen mal pro je gerade jetzt sofort immer nie oben unten gibt geht gilt wieder nochmal zuerst
  danach sich selbst einfach etwa eigene eigenen eigener eigenes zeigt zeigen speichern gespeichert abbrechen
  entfernen bearbeiten erstellen anlegen angelegt aktiv aktiviert inaktiv pausiert starten gestartet stoppen
  beenden beendet senden gesendet schicken einstellungen farbe schrift hintergrund rand breite dauer zeit ton
  bild testen vorschau fehler verbunden verbinden getrennt laden kopieren kopiert zeile zeilen liste gruppe
  gruppen belohnung belohnungen kanalpunkte zuschauer nachricht nachrichten befehl umfrage umfragen vorhersage
  vorhersagen werbung ziel ziele titel kategorie sprache vorlage vorlagen szene szenen quelle quellen uhr
  sekunde minute stunde heute gestern zuletzt letzte letzten erste ersten weiter fertig erledigt offen warten
  wartet leer lang kurz wenig viel viele mehr weniger andere anderen gleich einmal ab seit dann damit dafür
  sonst also zeichen wort wörter ganz genau richtig falsch dieser diese dieses diesem diesen welche welcher
  hinzu dazu drin darin dort regeln cheert raidet folgt verschenkt varianten anzeige
`.split(/\s+/).filter(Boolean));

/** Aufrufe, deren erstes Argument nie Oberflächen-Text ist */
const SKIP_CALLS = new Set([
  'querySelector', 'querySelectorAll', 'getElementById', 'closest', 'matches', 'addEventListener',
  'removeEventListener', 'getAttribute', 'setAttribute', 'removeAttribute', 'hasAttribute', 'toggleAttribute',
  'createElement', 'createElementNS', 'add', 'remove', 'toggle', 'contains', 'api', 'fetch', 'require', 'import',
  'log', 'warn', 'error', 'info', 'debug', 'getItem', 'setItem', 'removeItem', 'postMessage', 'emit', 'on', 'off',
  'call', 'botCall', 'getPropertyValue', 'setProperty', 'send', 'setTimeout', 'Symbol', 'runTest',
]);

/**
 * Weitere Server-Texte, die im UI angezeigt werden (Status, Hinweise, Protokolle einzelner Addons).
 * Datei → Regex für die Code-Zeile (oder die Zeile davor), in der der String steht.
 */
const SRC_UI = {
  'src/core/twitch/auth.ts': /message:|AuthError\(|message === /,
  'src/core/bot.ts': /\.reject\(/,
  'src/core/plugins.ts': /\.error = /,
  'src/core/updater.ts': /message:/,
  'src/core/keyActions.ts': /return '/,
  'src/core/satellite.ts': /EADDRINUSE/,
  'src/addons/obs/client.ts': /\bfail\(|\.error = |\.error \?\?|rejectAll\(|^\s*(\d+: |case .*return|default: return)/,
  'src/addons/obs/index.ts': /addLog\(|applyRename\(/,
  'src/addons/obs/model.ts': /return /,
  'src/addons/modguard/rules.ts': /reason: |return '|return `/,
  'src/addons/shoutout/index.ts': /\b(text|note|apiNote|reason): |notes(: \[|\.push\()|clipNote|Achtung|Kommt \$/,
  'src/addons/commands/index.ts': /detail: /,
  'src/addons/chat/index.ts': /text: |golden = |begin: |lock: |end: /,
};
/** …aber nie Log-Zeilen und Chat-Nachrichten (die schreibt die Suite in den Twitch-Chat) */
const SRC_SKIP = /\blog\.(info|warn|error|debug)\(|\breply\(|\bsay\(|\.send\(|createLogger\(/;

/**
 * Voreinstellungen, die als Nutzerdaten gespeichert werden (Vorlagen für Chat-Nachrichten, Namen von
 * Vorlagen) – die werden nicht übersetzt. Datei → Eigenschaften, deren Strings übersprungen werden.
 */
const USER_DATA = {
  'public/addons/timers/tm.js': ['name', 'messages'],
  'public/addons/commands/cmd.js': ['response', 'aliases'],
  'public/addons/ads/ads.js': ['message'],
};

// ------------------------------------------------------------------ Faustregel „deutsch?“

const UMLAUT = /[äöüÄÖÜß]/;
/** Typisch deutsche Wortenden (für kleingeschriebene Wörter wie „aktivieren“) */
const GERMAN_ENDING = /(ieren|iert|ierte|ungen|ung|keit|heit|lich|isch|schaft|chen|lung)$/;

export function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function looksGerman(raw) {
  const text = normalize(raw);
  if (!text || IGNORE.has(text)) return false;
  // Emojis, Zeichen und Zahlen am Rand weg, nur für die Prüfung
  const core = text.replace(/^[^A-Za-zÄÖÜäöüß]+|[^A-Za-zÄÖÜäöüß.!?…)]+$/gu, '');
  if (!core || !/[A-Za-zÄÖÜäöüß]{2}/.test(core) || IGNORE.has(core)) return false;
  // URLs, Pfade, Selektoren, Code
  if (/^(https?:|wss?:|data:|mailto:|\/|\.\/|\.\.\/|#[\w-]|\.[a-z][\w-]*|\[[\w-]+)/i.test(text)) return false;
  // (Platzhalter wie {count} oder {random:1-6} sind kein Code)
  const probe = text.replace(/\{[\w:|!.,-]*\}/g, 'X');
  if (/[{};]|=>|===|!==|&&|\|\||\$\(|^\w+\(.*\)$|sans-serif|monospace/.test(probe)) return false;
  if (/^[\w.-]+\/[\w./*-]+$/.test(text)) return false; // image/png, core/status
  const hasSpace = /\s/.test(core);
  if (!hasSpace) {
    // camelCase, snake_case, kebab-case klein → Bezeichner
    if (/^[a-z][a-z0-9]*([A-Z_-][\w-]*)+$/.test(core)) return false;
    if (/^[a-z]{1,2}$/.test(core)) return false; // Sprachcodes wie „es“, „ja“
    // GROSS geschrieben: Überschrift („GRUPPEN“) oder KONSTANTE
    if (/^[A-ZÄÖÜ0-9_-]+$/.test(core)) return /^[A-ZÄÖÜ]{4,}(-[A-ZÄÖÜ]+)*$/.test(core);
  }
  // Zwischenüberschriften in GROSSBUCHSTABEN („VORLESEN (TEXT-TO-SPEECH)“)
  if (hasSpace && /^[A-ZÄÖÜ][A-ZÄÖÜ0-9 ()&!?,.:/…–-]+$/.test(text) && /[A-ZÄÖÜ]{4}/.test(text)) return true;
  const words = core.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  if (UMLAUT.test(core)) return !/^[a-z]+[A-Z]/.test(core);
  if (words.some((w) => GERMAN_WORDS.has(w))) {
    // einzelnes kleines Wort ohne Leerzeichen („aus“, „ab“) nur, wenn es wirklich allein steht
    return hasSpace || /^[A-Za-z]+(-[A-Za-z]+)*[.!?:…]*$/.test(core);
  }
  if (words.some((w) => GERMAN_ENDING.test(w))) return hasSpace || /^[A-Za-z]+(-[A-Za-z]+)*[.!?:…]*$/.test(core);
  if (!hasSpace) return /^[A-ZÄÖÜ][a-zäöüß]+([-/][A-ZÄÖÜa-zäöüß][a-zäöüß]*)*[.!?:…]*$/.test(core);
  // mehrere Wörter: Satz, der mit Großbuchstaben anfängt und ein längeres großgeschriebenes Wort hat
  // (Wörter aus IGNORE zählen nicht: „Twitch: …“, „Hype Train …“)
  const capitalized = core.match(/\b[A-ZÄÖÜ][a-zäöüß]{2,}\b/g)?.filter((w) => !IGNORE.has(w)) ?? [];
  return /^[A-ZÄÖÜ]/.test(core) && capitalized.length > 0 && !/\b(px|rgba?|em|rem|vh|vw)\b/.test(core);
}

// ------------------------------------------------------------------ JS/TS lesen

const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** Zerlegt JS/TS in Tokens. Strings: {k:'str', v}; Template-Strings: {k:'tpl', parts, slots} */
export function lexJs(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  let last = null;
  const push = (t) => {
    if (t.line === undefined) t.line = line;
    toks.push(t);
    last = t;
    return t;
  };

  function unescape(at) {
    const c = src[at + 1];
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
    if (c in simple) return [simple[c], 2];
    if (c === 'u') {
      if (src[at + 2] === '{') {
        const end = src.indexOf('}', at);
        return [String.fromCodePoint(parseInt(src.slice(at + 3, end), 16)), end - at + 1];
      }
      return [String.fromCharCode(parseInt(src.substr(at + 2, 4), 16)), 6];
    }
    if (c === 'x') return [String.fromCharCode(parseInt(src.substr(at + 2, 2), 16)), 4];
    if (c === '\n') {
      line++;
      return ['', 2];
    }
    if (c === '\r') return ['', src[at + 2] === '\n' ? 3 : 2];
    return [c, 2];
  }

  function readString(quote) {
    const startLine = line;
    let v = '';
    i++;
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') {
        const [ch, len] = unescape(i);
        v += ch;
        i += len;
        continue;
      }
      if (src[i] === '\n') break;
      v += src[i++];
    }
    i++;
    push({ k: 'str', v, line: startLine });
  }

  function readTemplate() {
    const tok = push({ k: 'tpl', parts: [''], slots: [] });
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') {
        const [ch, len] = unescape(i);
        tok.parts[tok.parts.length - 1] += ch;
        i += len;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        last = { k: 'p', v: '${' };
        const from = toks.length;
        lexCode(true);
        // Strings im ${…} gehören zum Template: nur als mögliche Werte merken, nicht einzeln melden
        const inner = toks.splice(from);
        tok.slots.push(inner.filter((t) => t.k === 'str' || t.k === 'tpl').map((t) => (t.k === 'str' ? t.v : t.parts.join('7'))));
        tok.parts.push('');
        continue;
      }
      if (src[i] === '\n') line++;
      tok.parts[tok.parts.length - 1] += src[i++];
    }
    i++;
    last = tok;
  }

  function regexAllowed() {
    if (!last) return true;
    if (last.k === 'p') return ![')', ']', '}'].includes(last.v);
    if (last.k === 'id') return KW_BEFORE_REGEX.has(last.v);
    return false;
  }

  function readRegex() {
    let inClass = false;
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '\n') break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      i++;
    }
    i++;
    while (/[a-z]/.test(src[i] ?? '')) i++;
    push({ k: 're' });
  }

  function lexCode(inInterpolation) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') {
        line++;
        i++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') {
        i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        const end = e < 0 ? src.length : e + 2;
        line += (src.slice(i, end).match(/\n/g) ?? []).length;
        i = end;
        continue;
      }
      if (c === '"' || c === "'") {
        readString(c);
        continue;
      }
      if (c === '`') {
        readTemplate();
        continue;
      }
      if (c === '/') {
        if (regexAllowed()) readRegex();
        else {
          push({ k: 'p', v: src[i + 1] === '=' ? '/=' : '/' });
          i += last.v.length;
        }
        continue;
      }
      if (/[A-Za-z_$À-￿]/.test(c)) {
        let j = i;
        while (j < src.length && /[\w$À-￿]/.test(src[j])) j++;
        push({ k: 'id', v: src.slice(i, j) });
        i = j;
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
        let j = i + 1;
        while (j < src.length && /[\w.]/.test(src[j])) j++;
        push({ k: 'num', v: src.slice(i, j) });
        i = j;
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (inInterpolation && depth === 0) {
          i++;
          return;
        }
        depth--;
      }
      const m = /^(===|!==|\.\.\.|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=)/.exec(src.slice(i, i + 3));
      const v = m ? m[1] : c;
      push({ k: 'p', v });
      i += v.length;
    }
  }

  lexCode(false);
  return toks;
}

/** Kontext prüfen: Ist dieser String sicher kein Oberflächen-Text (Objekt-Schlüssel, Vergleich, Selektor …)? */
function codeContext(toks, idx) {
  const prev = toks[idx - 1];
  const prev2 = toks[idx - 2];
  const next = toks[idx + 1];
  if (next?.k === 'p' && next.v === ':' && prev?.k === 'p' && (prev.v === '{' || prev.v === ',')) return true;
  // Werte von IDs und Typen ({ id: 'links', type: 'text' })
  if (prev?.k === 'p' && prev.v === ':' && prev2?.k === 'id' && /^(id|type|kind|key|mode|event|value|rule)$/.test(prev2.v)) return true;
  if (prev?.k === 'p' && ['===', '!==', '==', '!='].includes(prev.v)) return true;
  if (next?.k === 'p' && ['===', '!==', '==', '!='].includes(next.v)) return true;
  if (prev?.k === 'id' && (prev.v === 'case' || prev.v === 'from' || prev.v === 'import')) return true;
  if (prev?.k === 'p' && prev.v === '(' && prev2?.k === 'id' && SKIP_CALLS.has(prev2.v)) return true;
  // Inhalt von h('code', {}, …) – <code> übersetzt ui.js nicht
  if (prev?.v === ',' && toks[idx - 2]?.v === '}' && toks[idx - 3]?.v === '{' && toks[idx - 4]?.v === ',' && toks[idx - 5]?.k === 'str' && toks[idx - 5].v === 'code') return true;
  // obj['key'] (aber nicht ein Array wie notes: ['Text'])
  if (prev?.v === '[' && next?.v === ']' && (prev2?.k === 'id' || prev2?.v === ')' || prev2?.v === ']')) return true;
  return false;
}

/** Alle Tokens in den Argumenten von new HttpError(...) / new Error(...) */
function errorArgs(toks) {
  const inside = new Set();
  for (let j = 0; j < toks.length - 2; j++) {
    if (toks[j].k === 'id' && toks[j].v === 'new' && toks[j + 1].k === 'id' && /^(HttpError|Error)$/.test(toks[j + 1].v) && toks[j + 2].v === '(') {
      let depth = 0;
      for (let k = j + 2; k < toks.length; k++) {
        const t = toks[k];
        if (t.k === 'p' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++;
        else if (t.k === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) {
          if (--depth === 0) break;
        } else if (t.k === 'str' || t.k === 'tpl') inside.add(t);
      }
    }
  }
  return inside;
}

/** name: '…' / description: '…' in einem Addon-Objekt (erkennbar an settingsPage/activate in der Nähe) */
function manifestStrings(toks) {
  const found = new Set();
  for (let j = 2; j < toks.length; j++) {
    const t = toks[j];
    if ((t.k !== 'str') || toks[j - 1].v !== ':' || toks[j - 2].k !== 'id' || !/^(name|description)$/.test(toks[j - 2].v)) continue;
    const near = toks.slice(j, j + 60);
    if (near.some((n) => n.k === 'id' && (n.v === 'settingsPage' || n.v === 'activate'))) found.add(t);
  }
  return found;
}

/** Strings in prop: '…' oder prop: ['…', '…'] für die angegebenen Eigenschaften */
function userDataStrings(toks, props) {
  const found = new Set();
  if (!props.length) return found;
  for (let j = 0; j < toks.length - 2; j++) {
    if (toks[j].k !== 'id' || !props.includes(toks[j].v) || toks[j + 1].v !== ':') continue;
    if (toks[j + 2].k === 'str' || toks[j + 2].k === 'tpl') found.add(toks[j + 2]);
    else if (toks[j + 2].v === '[') {
      for (let k = j + 3; k < toks.length && toks[k].v !== ']'; k++) if (toks[k].k === 'str' || toks[k].k === 'tpl') found.add(toks[k]);
    }
  }
  return found;
}

// ------------------------------------------------------------------ HTML lesen

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'code']);
const HTML_ATTRS = ['title', 'placeholder', 'aria-label'];

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”', times: '×', rarr: '→', larr: '←' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return named[e] ?? m;
  });
}

/** Texte und übersetzte Attribute aus HTML; liefert [{text, line, inlineScript?}] */
export function scanHtml(src) {
  const out = [];
  const stack = []; // {tag, skip}
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let pos = 0;
  let m;
  const lineAt = (idx) => src.slice(0, idx).split('\n').length;
  const skipping = () => stack.some((s) => s.skip);
  while ((m = re.exec(src))) {
    const between = src.slice(pos, m.index);
    if (between.trim() && !skipping()) out.push({ text: decodeEntities(between), line: lineAt(pos) });
    pos = re.lastIndex;
    if (!m[2]) continue; // Kommentar
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.map((s) => s.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:@-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const skip = RAW.has(tag) || /(^|\s)(no-i18n|cr-msg|cr-text|q-input)(\s|$)/.test(attrs.class ?? '');
    if (!skip && !skipping()) for (const name of HTML_ATTRS) if (attrs[name]) out.push({ text: attrs[name], line: lineAt(m.index) });
    if (tag === 'script' && !attrs.src) {
      // Inline-Skript: bis </script> als JS lesen
      const end = src.indexOf('</script>', re.lastIndex);
      out.push({ script: src.slice(re.lastIndex, end < 0 ? src.length : end), line: lineAt(re.lastIndex) });
      re.lastIndex = pos = end < 0 ? src.length : end + '</script>'.length;
      continue;
    }
    if (tag === 'style') {
      const end = src.indexOf('</style>', re.lastIndex);
      re.lastIndex = pos = end < 0 ? src.length : end + '</style>'.length;
      continue;
    }
    if (!VOID.has(tag) && !m[3].trim().endsWith('/')) stack.push({ tag, skip });
  }
  return out;
}

// ------------------------------------------------------------------ Dateien sammeln

function walk(dir, filter, list = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, list);
    else if (filter(full)) list.push(full);
  }
  return list;
}

const rel = (file) => path.relative(root, file).split(path.sep).join('/');

/**
 * Renderer der OBS-Overlays. Die Einstellungsseiten nutzen sie nur für Vorschauen (class="no-i18n")
 * bzw. für Chat-Nachrichten (.cr-msg) – dort wird nichts übersetzt, also auch nicht prüfen.
 */
const OVERLAY_SCRIPTS = new Set([
  'public/addons/alerts/renderer.js', 'public/addons/alerts/effects.js', 'public/addons/goals/render.js', 'public/addons/chat/render.js',
]);

/** Seiten mit ui.js und die Skripte, die sie laden */
function uiFiles() {
  const pub = path.join(root, 'public');
  const pages = walk(pub, (f) => f.endsWith('.html')).filter((f) => /<script[^>]+src=["'][^"']*\/?ui\.js["']/.test(fs.readFileSync(f, 'utf8')));
  const scripts = new Set();
  for (const page of pages) {
    for (const m of fs.readFileSync(page, 'utf8').matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
      const src = m[1];
      if (/^https?:/.test(src)) continue;
      const file = src.startsWith('/') ? path.join(pub, src) : path.join(path.dirname(page), src);
      if (fs.existsSync(file) && !OVERLAY_SCRIPTS.has(rel(file))) scripts.add(path.normalize(file));
    }
  }
  return { pages, scripts: [...scripts] };
}

/** Pattern-Vorschlag für einen Template-String: ${…} wird zu (.+) */
function patternFor(parts) {
  let re = '';
  parts.forEach((p, idx) => {
    const piece = idx === 0 ? p.replace(/^\s+/, '') : idx === parts.length - 1 ? p.replace(/\s+$/, '') : p;
    re += piece.replace(/\s+/g, ' ').replace(/[.*+?^$()[\]{}|\\/]/g, '\\$&');
    if (idx < parts.length - 1) re += '(.+)';
  });
  return `^${re}$`;
}

/** 'Text ' + 'mehr Text' → ein Template-Token (nur direkt aneinandergehängte Strings) */
function mergeConcat(toks, errs) {
  const out = [];
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j];
    const isLit = (x) => x && (x.k === 'str' || x.k === 'tpl');
    if (!isLit(t) || toks[j + 1]?.v !== '+' || !isLit(toks[j + 2])) {
      out.push(t);
      continue;
    }
    const merged = { k: 'tpl', parts: [''], slots: [], line: t.line };
    const add = (x) => {
      if (x.k === 'str') merged.parts[merged.parts.length - 1] += x.v;
      else {
        merged.parts[merged.parts.length - 1] += x.parts[0];
        x.parts.slice(1).forEach((p, n) => {
          merged.slots.push(x.slots[n]);
          merged.parts.push(p);
        });
      }
    };
    add(t);
    while (toks[j + 1]?.v === '+' && isLit(toks[j + 2])) {
      add(toks[j + 2]);
      j += 2;
    }
    if (errs?.has(t)) errs.add(merged);
    out.push(merged);
  }
  return out;
}

function collectJs(file, src, isTs) {
  const found = [];
  const lines = src.split('\n');
  const uiLine = SRC_UI[file];
  const extraUi = (t) => {
    if (!uiLine) return false;
    const here = lines[t.line - 1] ?? '';
    if (SRC_SKIP.test(here)) return false;
    return uiLine.test(here) || uiLine.test(lines[t.line - 2] ?? '');
  };
  const lexed = lexJs(src);
  const errs = isTs ? errorArgs(lexed) : null;
  const toks = mergeConcat(lexed, errs);
  const manifest = isTs ? manifestStrings(toks) : null;
  const userData = userDataStrings(toks, USER_DATA[file] ?? []);
  toks.forEach((tok, idx) => {
    if (tok.k !== 'str' && tok.k !== 'tpl') return;
    if (isTs && !errs.has(tok) && !manifest.has(tok) && !extraUi(tok)) return;
    if (codeContext(toks, idx)) return;
    if (userData.has(tok)) return;
    for (const t of splitUser(tok)) check(t);
  });
  return found;

  function check(t) {
    if (t.k === 'str') {
      if (/<[a-z][\w-]*[\s>]/i.test(t.v)) {
        for (const piece of scanHtml(t.v)) if (piece.text && looksGerman(piece.text)) found.push({ file, line: t.line, text: normalize(piece.text) });
        return;
      }
      if (looksGerman(t.v)) found.push({ file, line: t.line, text: normalize(t.v) });
      return;
    }
    const staticText = t.parts.join(' X ');
    if (/<[a-z][\w-]*[\s>]/i.test(staticText)) return; // HTML/SVG-Schnipsel
    // deutsch, wenn der feste Teil deutsch ist – oder ein String im ${…} (`${name} ${on ? 'an' : 'aus'}`)
    if (!looksGerman(staticText) && !t.slots.flat().some((v) => looksGerman(v))) return;
    if (t.slots.length === 0) {
      found.push({ file, line: t.line, text: normalize(t.parts[0]) });
      return;
    }
    if (IGNORE_TEMPLATES.has(patternFor(t.parts))) return;
    found.push({ file, line: t.line, template: t.parts.map((p, n) => (n ? '${…}' : '') + p).join(''), parts: t.parts, slots: t.slots, pattern: patternFor(t.parts) });
  }
}

/**
 * Event-Texte im Chat-Fenster: „{user} folgt jetzt!“ wird beim Anzeigen am {user} geteilt
 * (Name als eigenes Element) – übersetzt werden die Stücke davor und danach.
 */
function splitUser(t) {
  const MARK = '{user}';
  if (t.k === 'str') return t.v.includes(MARK) ? t.v.split(MARK).map((v) => ({ ...t, v })) : [t];
  const at = t.parts.findIndex((p) => p.includes(MARK));
  if (at < 0) return [t];
  const [before, after] = [t.parts[at].slice(0, t.parts[at].indexOf(MARK)), t.parts[at].slice(t.parts[at].indexOf(MARK) + MARK.length)];
  const first = { ...t, parts: [...t.parts.slice(0, at), before], slots: t.slots.slice(0, at) };
  const second = { ...t, parts: [after, ...t.parts.slice(at + 1)], slots: t.slots.slice(at) };
  return [first, ...splitUser(second)];
}

export function collect() {
  const all = [];
  const { pages, scripts } = uiFiles();
  for (const page of pages) {
    const src = fs.readFileSync(page, 'utf8');
    const title = /<title>([^<]*)<\/title>/i.exec(src);
    for (const piece of scanHtml(src)) {
      if (piece.script) {
        for (const f of collectJs(rel(page), piece.script, false)) all.push({ ...f, line: f.line + piece.line - 1 });
      } else if (looksGerman(piece.text)) all.push({ file: rel(page), line: piece.line, text: normalize(piece.text) });
    }
    if (title && looksGerman(title[1])) all.push({ file: rel(page), line: 1, text: normalize(decodeEntities(title[1])) });
  }
  for (const file of scripts) all.push(...collectJs(rel(file), fs.readFileSync(file, 'utf8'), false));
  const srcDir = path.join(root, 'src');
  const tsFiles = walk(srcDir, (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts') && !f.includes(`${path.sep}private${path.sep}`));
  for (const file of tsFiles) all.push(...collectJs(rel(file), fs.readFileSync(file, 'utf8'), true));
  return all;
}

// ------------------------------------------------------------------ Abgleich mit en.json

function loadDict() {
  const dict = JSON.parse(fs.readFileSync(EN_FILE, 'utf8'));
  return { texts: dict.texts ?? {}, patterns: (dict.patterns ?? []).map(([re, to]) => [new RegExp(re), to]) };
}

function translated(dict, text) {
  if (dict.texts[text] !== undefined) return true;
  return dict.patterns.some(([re]) => re.test(text));
}

/** Template-String: mit Beispielwerten füllen und schauen, ob ein Pattern (oder Text) passt */
function templateCovered(dict, entry) {
  const choices = entry.slots.map((nested) => ['7', 'Xyz', '', ...nested]);
  let combos = [[]];
  for (const c of choices) {
    const next = [];
    for (const combo of combos) for (const v of c) next.push([...combo, v]);
    combos = next.slice(0, 5000);
  }
  const covered = combos.filter((combo) => {
    let s = entry.parts[0];
    combo.forEach((v, n) => (s += v + entry.parts[n + 1]));
    return translated(dict, normalize(s));
  });
  if (!covered.length) return false;
  // Jeder deutsche Text in einem ${…} muss in mindestens einer übersetzten Variante vorkommen
  return entry.slots.every((nested, n) => nested.filter((v) => looksGerman(v)).every((v) => covered.some((combo) => combo[n] === v)));
}

function main() {
  const mode = process.argv[2] ?? 'check';
  const found = collect();
  if (mode === 'list') {
    const seen = new Set();
    const unique = found.filter((f) => {
      const key = f.text ?? f.pattern;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(JSON.stringify(unique.map(({ slots, parts, ...rest }) => rest), null, 1));
    return;
  }
  if (mode !== 'check') {
    console.error('Benutzung: node scripts/i18n.mjs check|list');
    process.exit(2);
  }
  const dict = loadDict();
  const missing = [];
  const seen = new Set();
  for (const f of found) {
    const key = f.text ?? f.pattern;
    if (seen.has(key)) continue;
    const ok = f.text !== undefined ? translated(dict, f.text) : templateCovered(dict, f);
    if (!ok) {
      seen.add(key);
      missing.push(f);
    }
  }
  for (const f of missing) {
    if (f.text !== undefined) console.log(`${f.file}:${f.line}  ${JSON.stringify(f.text)}`);
    else console.log(`${f.file}:${f.line}  tpl ${JSON.stringify(f.template)}  →  ${JSON.stringify(f.pattern)}`);
  }
  const total = new Set(found.map((f) => f.text ?? f.pattern)).size;
  console.log(missing.length ? `\n${missing.length} von ${total} Texten fehlen in public/app/i18n/en.json.` : `Alle ${total} Texte sind übersetzt.`);
  process.exit(missing.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
