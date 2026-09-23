const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/modguard';

/** saved = so wie gespeichert, draft = was gerade bearbeitet wird */
const state = { saved: null, draft: null, dirty: false, log: [], logKey: '', open: new Set(['links']) };

const RULES = [
  { id: 'links', name: 'Links', icon: '🔗', desc: 'Links zu fremden Seiten (erlaubte Domains ausgenommen, Mods können mit !permit einen Link erlauben)' },
  { id: 'caps', name: 'Großbuchstaben', icon: '🔠', desc: 'Nachrichten, die fast nur aus GROSSBUCHSTABEN bestehen (Emotes zählen nicht)' },
  { id: 'words', name: 'Verbotene Wörter', icon: '🤬', desc: 'Wörter aus deiner Liste, auch leicht versteckt (h.a.s.s, haaass, h4ss)' },
  { id: 'repeat', name: 'Wiederholungen', icon: '🔁', desc: 'Dieselbe Nachricht mehrmals hintereinander von derselben Person' },
  { id: 'symbols', name: 'Zeichen & Emotes', icon: '🔣', desc: 'Emote-Wände und Nachrichten voller Sonderzeichen' },
];
const RULE_NAME = Object.fromEntries(RULES.map((r) => [r.id, r.name]));
const ACTIONS = { delete: 'Nur löschen', timeout: 'Löschen + Timeout', warn: 'Nur Warnung im Chat' };

/** Sekunden lesbar: 90 → „1 Min. 30 s“ */
function fmtSec(sec) {
  if (sec < 60) return `${sec} s`;
  const d = Math.floor(sec / 86_400);
  const hrs = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const rest = sec % 60;
  const parts = [];
  if (d) parts.push(`${d} ${d === 1 ? 'Tag' : 'Tage'}`);
  if (hrs) parts.push(`${hrs} Std.`);
  if (m) parts.push(`${m} Min.`);
  if (rest && !d) parts.push(`${rest} s`);
  return parts.join(' ');
}
const fmtTime = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ============================================================ Laden & Speichern

async function load() {
  try {
    const data = await api(`${BASE}/state`);
    setSaved(data.settings);
    setLog(data.log);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function setSaved(settings) {
  state.saved = settings;
  state.draft = structuredClone(settings);
  setDirty(false);
  renderAll();
}

function setDirty(on) {
  state.dirty = on;
  $('#save-bar').hidden = !on;
}

async function save() {
  try {
    const data = await api(`${BASE}/settings`, state.draft);
    setSaved(data.settings);
    toast('Gespeichert', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** „Nur testen“ sofort umschalten (ohne die anderen, ungespeicherten Änderungen anzufassen) */
async function setDryRun(on) {
  try {
    const data = await api(`${BASE}/settings`, { dryRun: on });
    state.saved.dryRun = data.settings.dryRun;
    state.draft.dryRun = data.settings.dryRun;
    renderDryRun();
    toast(on ? 'Nur testen: es wird nichts mehr gelöscht' : 'Spam-Schutz ist jetzt scharf geschaltet 🛡️', 'ok');
  } catch (err) {
    toast(err.message, 'err');
    renderDryRun(true);
  }
}

// ============================================================ Eingabefelder (schreiben direkt in den Entwurf)

const changed = () => setDirty(true);
const field = (label, ...controls) => h('div', { class: 'field' }, h('label', {}, label), ...controls);
const vars = (list) => h('div', { class: 'note' }, 'Variablen: ', list.map((v, i) => [i ? ', ' : '', h('code', {}, v)]));

function numInput(obj, key, attrs = {}, after) {
  return h('input', {
    type: 'number', value: obj[key], ...attrs,
    oninput: (e) => { obj[key] = Number(e.target.value); changed(); after?.(); },
  });
}

function textInput(obj, key, attrs = {}) {
  return h('input', { type: 'text', value: obj[key], ...attrs, oninput: (e) => { obj[key] = e.target.value; changed(); } });
}

/** Liste als Textfeld: ein Eintrag pro Zeile (der Server räumt auf) */
function listArea(obj, key, placeholder, rows = 4) {
  const t = h('textarea', { rows, placeholder, oninput: (e) => { obj[key] = e.target.value; changed(); } });
  t.value = Array.isArray(obj[key]) ? obj[key].join('\n') : obj[key];
  return t;
}

function selectInput(obj, key, options, after) {
  const sel = h('select', { onchange: (e) => { obj[key] = e.target.value; changed(); after?.(); } },
    ...Object.entries(options).map(([value, label]) => h('option', { value, selected: obj[key] === value }, label)));
  return sel;
}

function optRow(obj, key, label, after) {
  return h('div', { class: 'opt-row' },
    toggle(obj[key], (on) => { obj[key] = on; changed(); after?.(); }, label),
    h('span', {}, label));
}

// ============================================================ Anzeigen

function renderAll() {
  renderDryRun();
  renderRules();
  renderEscalation();
  renderExempt();
  renderHelp();
  renderQuickTests();
}

function renderDryRun(force = false) {
  const on = state.saved.dryRun;
  const box = $('#dry-toggle');
  if (force || box.dataset.on !== String(on)) {
    box.dataset.on = String(on);
    box.replaceChildren(toggle(on, setDryRun, 'Nur testen'), 'Nur testen');
  }
  $('#dry-banner').replaceChildren(...(on
    ? [h('div', { class: 'dry-banner' }, '🧪 „Nur testen“ ist an: Es wird nichts gelöscht, niemand getimeoutet und keine Warnung gesendet. Im Protokoll siehst du, was passiert wäre. Wenn alles passt, schalte oben rechts „Nur testen“ aus.')]
    : []));
}

/** Kurzfassung für den Kopf einer Regel, z.B. „Löschen + Timeout (1 Min.)“ */
function actionSummary(rule) {
  if (!rule.enabled) return h('span', { class: 'badge' }, 'aus');
  if (state.draft.escalation.enabled && rule.action !== 'warn') return h('span', { class: 'badge accent' }, 'Eskalation');
  const text = rule.action === 'timeout' ? `Timeout ${fmtSec(rule.timeoutSeconds)}` : ACTIONS[rule.action];
  return h('span', { class: `badge ${rule.action === 'timeout' ? 'err' : rule.action === 'warn' ? 'warn' : 'ok'}` }, text);
}

function renderRules() {
  $('#rules').replaceChildren(...RULES.map((meta) => {
    const rule = state.draft.rules[meta.id];
    const open = state.open.has(meta.id);
    const rerender = () => renderRules();
    const flip = () => {
      if (open) state.open.delete(meta.id);
      else state.open.add(meta.id);
      rerender();
    };
    return h('div', { class: `rule${rule.enabled ? '' : ' off'}` },
      h('div', { class: 'rule-head' },
        toggle(rule.enabled, (on) => { rule.enabled = on; changed(); rerender(); }, `${meta.name} an/aus`),
        h('div', { class: 'rule-title', onclick: flip }, h('b', {}, `${meta.icon} ${meta.name}`), h('span', {}, meta.desc)),
        actionSummary(rule),
        h('button', { class: 'icon-btn', title: open ? 'Zuklappen' : 'Einstellungen', onclick: flip }, open ? '▾' : '▸')),
      open ? h('div', { class: 'rule-body' }, ...ruleFields(meta.id, rule, rerender)) : null);
  }));
}

function ruleFields(id, rule, rerender) {
  const common = [
    h('div', { class: 'f-row' },
      field('Was passiert?', selectInput(rule, 'action', ACTIONS, rerender)),
      rule.action === 'timeout' ? field('Timeout (Sekunden)', numInput(rule, 'timeoutSeconds', { min: 1, max: 1209600 })) : h('div')),
    field('Warnung im Chat (leer = keine)', textInput(rule, 'message', { maxlength: 400 })),
    vars(['{user}', '{rule}', '{seconds}']),
    optRow(rule, 'exemptSubs', 'Subs sind von dieser Regel ausgenommen'),
  ];
  const specific = {
    links: () => [
      h('div', { class: 'sub' }, 'ERLAUBTE DOMAINS'),
      listArea(rule, 'allowDomains', 'twitch.tv\nyoutube.com'),
      h('p', { class: 'note' }, 'Eine pro Zeile. Subdomains zählen mit: „twitch.tv“ erlaubt auch „clips.twitch.tv“.'),
      optRow(rule, 'catchObfuscated', 'Auch versteckte Links erkennen („twitch . tv“, „seite(dot)com“)'),
      h('p', { class: 'note' }, 'Kann selten Fehlalarme geben. Normale Links (mit oder ohne https://) werden immer erkannt.'),
    ],
    caps: () => [
      h('div', { class: 'f-row' },
        field('Erst ab so vielen Buchstaben', numInput(rule, 'minLength', { min: 1, max: 500 })),
        field('Höchstens … % Großbuchstaben', numInput(rule, 'maxPercent', { min: 10, max: 100 }))),
      h('p', { class: 'note' }, 'Kurze Rufe wie „GG“ oder „LETS GO“ bleiben so erlaubt.'),
    ],
    words: () => [
      h('div', { class: 'sub' }, 'VERBOTENE WÖRTER'),
      listArea(rule, 'words', 'ein Wort pro Zeile'),
      h('div', { class: 'sub' }, 'SOFORT-TIMEOUT (IMMER TIMEOUT, EGAL WAS OBEN EINGESTELLT IST)'),
      listArea(rule, 'severeWords', 'ein Wort pro Zeile', 3),
      field('Timeout für diese Wörter (Sekunden)', numInput(rule, 'severeTimeoutSeconds', { min: 1, max: 1209600 })),
      h('p', { class: 'note' }, 'Groß/klein ist egal. Es zählen ganze Wörter: „hass“ trifft nicht „Hasskappe“. Mit * für beliebige Buchstaben: „hass*“ trifft auch „Hasskappe“, „*mist“ trifft „Kackmist“. Einfache Tricks wie „h.a.s.s“, „haaasss“, „h4ss“ oder „h a s s“ werden erkannt.'),
    ],
    repeat: () => [
      h('div', { class: 'f-row' },
        field('So oft dieselbe Nachricht …', numInput(rule, 'count', { min: 2, max: 20 })),
        field('… innerhalb von (Sekunden)', numInput(rule, 'windowSeconds', { min: 5, max: 3600 }))),
      h('p', { class: 'note' }, 'Groß/klein und Satzzeichen zählen nicht („hi!!“ = „HI“). Commands mit ! zählen nicht, die haben eigene Abklingzeiten.'),
    ],
    symbols: () => [
      h('div', { class: 'f-row3' },
        field('Höchstens … Emotes (0 = egal)', numInput(rule, 'maxEmotes', { min: 0, max: 200 })),
        field('Höchstens … % Sonderzeichen (0 = egal)', numInput(rule, 'maxSymbolPercent', { min: 0, max: 100 })),
        field('Sonderzeichen erst ab … Zeichen', numInput(rule, 'minLength', { min: 1, max: 500 }))),
      h('p', { class: 'note' }, 'Emotes = Twitch-Emotes und Emojis. Sonderzeichen = alles außer Buchstaben, Zahlen und Leerzeichen (auch ⣿-Bilder und Zalgo-Text).'),
    ],
  };
  return [...common, ...specific[id]()];
}

function renderEscalation() {
  const esc = state.draft.escalation;
  const timeouts = { value: Array.isArray(esc.timeouts) ? esc.timeouts.join(', ') : esc.timeouts };
  $('#escalation').replaceChildren(h('div', { class: 'box' },
    optRow(esc, 'enabled', 'Eskalation an', () => { renderRules(); renderEscalation(); }),
    h('p', { class: 'note' }, '1. Verstoß: Nachricht löschen + Warnung. Jeder weitere Verstoß innerhalb der Zeit unten: Timeout, der jedes Mal länger wird. Ersetzt die Aktionen der Regeln – außer bei Regeln mit „Nur Warnung“, die bleiben bei der Warnung.'),
    esc.enabled ? h('div', { class: 'f-row' },
      field('Verstöße zählen (Minuten)', numInput(esc, 'windowMinutes', { min: 1, max: 1440 })),
      field('Timeouts ab dem 2. Verstoß (Sekunden)', h('input', {
        type: 'text', value: timeouts.value, placeholder: '60, 300, 600',
        oninput: (e) => { esc.timeouts = e.target.value; changed(); },
      }))) : null,
    esc.enabled ? h('p', { class: 'note' }, 'Beispiel „60, 300, 600“: 2. Verstoß = 1 Min., 3. = 5 Min., ab dem 4. immer 10 Min. Die Zeit läuft ab dem letzten Verstoß.') : null));
}

function renderExempt() {
  const d = state.draft;
  $('#exempt').replaceChildren(h('div', { class: 'box' },
    h('div', { class: 'f-row' },
      field('Ausgenommen sind', selectInput(d, 'exemptRole', { subscriber: 'Subs und höher', vip: 'VIPs und höher', moderator: 'nur Mods' })),
      field('Warnungen im Chat höchstens alle (Sek.)', numInput(d, 'warnGapSeconds', { min: 0, max: 3600 }))),
    h('p', { class: 'note' }, 'Mods, du selbst, dein Bot-Account und Nachrichten der Suite sind immer ausgenommen. Dieselbe Person bekommt höchstens einmal pro Minute eine Warnung – gelöscht wird trotzdem.'),
    h('div', { class: 'sub' }, 'ERLAUBT-LISTE (NIE MODERIEREN)'),
    listArea(d, 'allowUsers', 'ein Twitch-Name pro Zeile, z.B. streamelements', 3),
    h('div', { class: 'sub' }, '!PERMIT (NUR MODS)'),
    h('div', { class: 'f-row' },
      field('Command (ohne !)', textInput(d.permit, 'command', { maxlength: 30 })),
      field('Link erlaubt für (Sekunden)', numInput(d.permit, 'seconds', { min: 5, max: 3600 }))),
    field('Bestätigung im Chat (leer = keine)', textInput(d.permit, 'message', { maxlength: 400 })),
    vars(['{user}', '{seconds}'])));
}

function renderHelp() {
  const p = state.saved.permit;
  $('#chat-help').replaceChildren(
    h('div', {}, h('code', {}, `!${p.command} @name`), ` – Mods erlauben dieser Person einen Link in den nächsten ${p.seconds} Sekunden.`),
    h('div', { class: 'note' }, 'Getimeoutet wird mit deinem Account. Timeouts hebst du im Protokoll mit ↩ wieder auf.'));
}

// ============================================================ Protokoll

function setLog(list) {
  const key = JSON.stringify(list);
  if (key === state.logKey) return;
  state.logKey = key;
  state.log = list;
  renderLog();
}

function actionBadge(e) {
  let text = e.action === 'timeout' ? `Timeout ${fmtSec(e.seconds)}` : e.action === 'delete' ? 'Gelöscht' : 'Warnung';
  if (e.dryRun) text = `nur Test: ${e.action === 'timeout' ? `Timeout ${fmtSec(e.seconds)}` : e.action === 'delete' ? 'löschen' : 'Warnung'}`;
  const cls = e.error ? 'err' : e.undone ? '' : e.dryRun ? 'accent' : e.action === 'timeout' ? 'err' : e.action === 'warn' ? 'warn' : 'ok';
  return [
    h('span', { class: `badge ${cls}`, title: e.error || '' }, e.error ? `⚠ ${text}` : e.undone ? `${text} (aufgehoben)` : text),
    e.strike ? h('span', { class: 'reason' }, ` ${e.strike}. Verstoß`) : null,
  ];
}

async function undo(e) {
  if (!confirm(`Timeout von ${e.name} aufheben?`)) return;
  try {
    const data = await api(`${BASE}/undo`, { id: e.id });
    setLog(data.log);
    toast(`${e.name} darf wieder schreiben`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function allow(e) {
  if (!confirm(`${e.name} auf die Erlaubt-Liste setzen? Die Person wird dann nie mehr moderiert.`)) return;
  try {
    const data = await api(`${BASE}/allow`, { login: e.login });
    // Ungespeicherte Änderungen behalten, nur die Liste übernehmen
    state.saved.allowUsers = data.settings.allowUsers;
    state.draft.allowUsers = data.settings.allowUsers;
    renderExempt();
    toast(`${e.name} steht jetzt auf der Erlaubt-Liste`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderLog() {
  const box = $('#log');
  $('#log-clear').hidden = !state.log.length;
  if (!state.log.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'Noch nichts passiert. 🎉'));
    return;
  }
  box.replaceChildren(h('table', { class: 'log' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Zeit'), h('th', {}, 'Wer'), h('th', {}, 'Regel'), h('th', {}, 'Nachricht'), h('th', {}, 'Aktion'), h('th', {}))),
    h('tbody', {}, ...state.log.map((e) =>
      h('tr', { class: e.dryRun ? 'dry' : '' },
        h('td', { class: 'time' }, fmtTime(e.time)),
        h('td', {}, h('b', { class: 'no-i18n' }, e.name)),
        h('td', {}, RULE_NAME[e.rule] ?? e.rule, h('div', { class: 'reason' }, e.reason)),
        h('td', { class: 'msg' },
          h('div', { class: 'excerpt no-i18n', title: e.excerpt }, e.excerpt),
          e.warning ? h('div', { class: 'warning', title: 'Warnung im Chat' }, `💬 ${e.warning}`) : null),
        h('td', {}, ...actionBadge(e)),
        h('td', { class: 'act' },
          e.action === 'timeout' && !e.dryRun && !e.undone && !e.error
            ? h('button', { class: 'icon-btn', title: 'Timeout aufheben', onclick: () => undo(e) }, '↩')
            : null,
          !state.saved || state.saved.allowUsers.includes(e.login.toLowerCase())
            ? null
            : h('button', { class: 'icon-btn', title: 'Auf die Erlaubt-Liste (Fehlalarm)', onclick: () => allow(e) }, '✓')))))));
}

async function pollLog() {
  try {
    const data = await api(`${BASE}/log`);
    setLog(data.log);
    if (state.saved && data.dryRun !== state.saved.dryRun) {
      state.saved.dryRun = data.dryRun;
      state.draft.dryRun = data.dryRun;
      renderDryRun();
    }
  } catch {
    // nächstes Mal
  }
}

// ============================================================ Testen

async function runTest(message) {
  const text = (message ?? $('#test-message').value).trim();
  if (!text) return;
  const user = $('#test-user').value.trim() || 'TestUser';
  try {
    const r = await api(`${BASE}/test`, { user, role: $('#test-role').value, permit: $('#test-permit').checked, message: text });
    let out;
    if (r.exempt) {
      out = h('div', { class: 'out' }, h('div', {}, `✅ Ausgenommen: ${r.exempt}`));
    } else if (!r.hit) {
      out = h('div', { class: 'out' },
        h('div', {}, '✅ Kein Treffer – die Nachricht bleibt stehen.'),
        r.usedPermit ? h('div', {}, 'Link erlaubt durch !permit (wäre damit verbraucht).') : null);
    } else {
      const d = r.decision;
      const what = d.action === 'timeout' ? `Löschen + Timeout ${fmtSec(d.seconds)}` : d.action === 'delete' ? 'Löschen' : 'Nur Warnung';
      out = h('div', { class: `out ${d.action === 'warn' ? 'warn' : 'hit'}` },
        h('div', {}, `🛡️ ${r.hit.ruleName}: ${r.hit.reason}`),
        h('div', {}, `→ ${what}${d.strike ? ` (${d.strike}. Verstoß)` : ''}`),
        r.warning ? h('div', { class: 'no-i18n' }, `💬 ${r.warning}`) : null,
        r.dryRun ? h('div', {}, '„Nur testen“ ist an: im echten Chat würde das nur ins Protokoll kommen.') : null);
    }
    $('#test-log').prepend(h('div', {}, h('div', { class: 'in no-i18n' }, h('b', {}, user), `: ${text}`), out));
    $('#test-message').value = '';
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderQuickTests() {
  const word = state.saved.rules.words.words[0];
  $('#test-quick').replaceChildren(...[
    h('button', { class: 'btn small', onclick: () => runTest('Schau mal hier: beispiel-seite.com/gratis') }, 'Link'),
    h('button', { class: 'btn small', onclick: () => runTest('HALLO LEUTE WIE GEHT ES EUCH ALLEN') }, 'CAPS'),
    word ? h('button', { class: 'btn small', onclick: () => runTest(`du bist so ein ${word.replace(/\*/g, '')}`) }, 'Wort') : null,
    h('button', { class: 'btn small', title: 'Mehrmals klicken', onclick: () => runTest('Kauf jetzt Follower!') }, 'Wiederholung'),
    h('button', { class: 'btn small', onclick: () => runTest('😂😂😂😂😂😂😂😂😂😂😂😂😂😂😂') }, 'Emojis'),
    h('button', {
      class: 'btn small', title: 'Zähler für Wiederholungen und Eskalation im Test zurücksetzen',
      onclick: async () => {
        await api(`${BASE}/test/reset`, {}).catch(() => {});
        $('#test-log').replaceChildren();
        toast('Test zurückgesetzt', 'ok');
      },
    }, '↺ Zurücksetzen')].filter(Boolean));
}

// ============================================================ Start

(async () => {
  $('#save').onclick = save;
  $('#discard').onclick = () => setSaved(state.saved);
  $('#test-run').onclick = () => runTest();
  $('#test-message').onkeydown = (e) => { if (e.key === 'Enter') runTest(); };
  $('#log-clear').onclick = async () => {
    if (!confirm('Protokoll leeren?')) return;
    try {
      setLog((await api(`${BASE}/log/clear`, {})).log);
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) e.preventDefault();
  });
  await load();
  setInterval(pollLog, 4000);
})();
