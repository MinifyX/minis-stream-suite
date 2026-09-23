const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/chat';

const EVENT_LABELS = {
  follow: '💜 Follows', sub: '⭐ Neue Abos', resub: '⭐ Abo-Verlängerungen', giftsub: '🎁 Verschenkte Abos',
  cheer: '💎 Bits', raid: '🚀 Raids', redemption: '✨ Kanalpunkte-Einlösungen', stream: '🔴 Stream-Start/-Ende',
  hypetrain: '🚂 Hype Train', prediction: '🔮 Vorhersagen', shoutout: '📣 Shoutouts', ads: '📺 Werbepausen',
};
const ROLES = [['everyone', 'Alle'], ['subscriber', 'Subs'], ['vip', 'VIPs'], ['moderator', 'Mods'], ['broadcaster', 'Nur du']];
const PREVIEW_BGS = [['checker', 'Transparent'], ['game', 'Spiel-Szene'], ['black', 'Schwarz'], ['white', 'Weiß'], ['green', 'Greenscreen']];
/** Schriften fürs Chat-Fenster: auf jedem Windows-PC vorhanden (wie WINDOW_FONTS in src/addons/chat/settings.ts) */
const WINDOW_FONTS = ['Segoe UI', 'Arial', 'Verdana', 'Tahoma', 'Consolas'];

let settings = null;
let defaults = null;
let emoteCount = 0;
let previewBg = 'game';

// ============================================================ Speichern
//
// Jede Einstellung hat einen Pfad wie "overlay.fontSize". Gespeichert wird nur, was sich geändert hat
// (z.B. { overlay: { fontSize: 24 } }). Dadurch überschreibt diese Seite nie Änderungen aus dem
// Chat-Fenster (A+/A−, Event-Filter) und umgekehrt.

/** Kennung dieser Seite, damit sie ihre eigenen Änderungen nicht nochmal lädt */
const SOURCE = `settings-${Math.random().toString(36).slice(2, 10)}`;
let pending = {};
let saving = false;
let saveTimer = null;

const get = (path) => path.split('.').reduce((obj, key) => obj[key], settings);

/** Objekt b in a einarbeiten (Listen werden ersetzt) */
function deepMerge(a, b) {
  for (const [key, value] of Object.entries(b)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && a[key] && typeof a[key] === 'object') deepMerge(a[key], value);
    else a[key] = value;
  }
  return a;
}

/** Wert setzen, für die nächste Speicherung vormerken und die Vorschau neu zeichnen */
function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((obj, key) => obj[key], settings)[last] = value;
  let p = pending;
  for (const key of keys) p = p[key] ??= {};
  p[last] = value;
  $('#save-state').textContent = 'Nicht gespeichert…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  renderPreviews();
}

async function save() {
  if (!Object.keys(pending).length) return;
  if (saving) {
    saveTimer = setTimeout(save, 200);
    return;
  }
  const patch = pending;
  pending = {};
  saving = true;
  try {
    const fresh = await api(`${BASE}/settings`, { patch, source: SOURCE });
    // Was während des Speicherns geändert wurde, bleibt erhalten und wird gleich hinterhergeschickt
    settings = deepMerge(fresh, structuredClone(pending));
    $('#save-state').textContent = Object.keys(pending).length ? 'Nicht gespeichert…' : 'Gespeichert ✓';
  } catch (err) {
    pending = deepMerge(patch, pending);
    $('#save-state').textContent = 'Fehler beim Speichern';
    toast(err.message, 'err');
  } finally {
    saving = false;
  }
}

// Seite wird verlassen, bevor der Timer abgelaufen ist → sofort noch speichern
window.addEventListener('pagehide', () => {
  if (!Object.keys(pending).length) return;
  fetch(`/api/${BASE}/settings`, {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: pending, source: SOURCE }),
  }).catch(() => {});
});

// ============================================================ Formular-Bausteine

const field = (label, ...controls) => h('div', { class: 'f' }, h('label', {}, label), ...controls);
const group = (title, ...children) => h('div', { class: 'group' }, h('h2', {}, title), ...children.filter(Boolean));
const note = (text) => h('p', { class: 'note' }, text);

function check(label, path, after) {
  return h('div', { class: 'check' }, toggle(get(path), (on) => { set(path, on); after?.(); }, label), h('span', {}, label));
}

function select(path, options, after) {
  const el = h('select', { onchange: (e) => { set(path, /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value); after?.(); } },
    ...options.map(([v, l]) => h('option', { value: v }, l)));
  el.value = String(get(path));
  return el;
}

function number(path, min, max) {
  return h('input', {
    type: 'number', min, max, step: 1, value: get(path),
    // Beim Tippen nur gültige Werte übernehmen, beim Verlassen des Felds auf den erlaubten Bereich begrenzen
    oninput: (e) => {
      const v = Number(e.target.value);
      if (e.target.value !== '' && Number.isFinite(v) && v >= min && v <= max) set(path, Math.round(v));
    },
    onchange: (e) => {
      const v = Math.max(min, Math.min(max, Math.round(Number(e.target.value) || 0)));
      e.target.value = v;
      if (v !== get(path)) set(path, v);
    },
  });
}

function color(path) {
  const picker = h('input', { type: 'color', value: get(path) });
  const text = h('input', { type: 'text', value: get(path), maxlength: 7 });
  picker.oninput = () => { text.value = picker.value.toUpperCase(); set(path, text.value); };
  text.oninput = () => {
    const v = text.value.startsWith('#') ? text.value : `#${text.value}`;
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      picker.value = v;
      set(path, v.toUpperCase());
    }
  };
  text.onchange = () => { text.value = get(path); };
  return h('div', { class: 'color' }, picker, text);
}

function listInput(path, placeholder) {
  return h('input', {
    type: 'text', value: get(path).join(', '), placeholder,
    oninput: (e) => set(path, e.target.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)),
  });
}

function eventChips(path) {
  const box = h('div', { class: 'chips' });
  const render = () => box.replaceChildren(...Object.entries(EVENT_LABELS).map(([kind, label]) =>
    h('button', { class: `chip-toggle${get(path)[kind] ? ' on' : ''}`, onclick: () => { set(`${path}.${kind}`, !get(path)[kind]); render(); } }, label)));
  render();
  return box;
}

/** Markdown, Farben und Drittanbieter-Emotes – gibt es für Overlay und Fenster getrennt */
function rulesGroup(section, title, intro) {
  return group(title,
    note(intro),
    h('div', { class: 'row2' },
      h('div', { class: 'f' }, check('Markdown erlauben', `${section}.markdown.enabled`), field('für', select(`${section}.markdown.minRole`, ROLES))),
      h('div', { class: 'f' }, check('Farben erlauben', `${section}.colors.enabled`), field('für', select(`${section}.colors.minRole`, ROLES)))),
    check('Emotes von 7TV, BTTV und FFZ anzeigen', `${section}.thirdPartyEmotes`),
    note('Wie man Markdown und Farben schreibt, steht im Tab „😀 Emotes & Hilfe“.'));
}

/** Knopf: nur diesen Bereich (Overlay oder Fenster) auf Standard zurücksetzen */
function resetButton(section, question) {
  return h('div', { class: 'btn-row' }, h('button', {
    class: 'btn small',
    onclick: () => {
      if (!confirm(question)) return;
      set(section, structuredClone(defaults[section]));
      renderForms();
      toast('Auf Standard zurückgesetzt', 'ok');
    },
  }, '↺ Auf Standard zurücksetzen'));
}

// ============================================================ Vorschau

function sampleItems() {
  const assets = ChatRender.getAssets();
  const third = Object.keys(assets.emotes || {})[0];
  const me = assets.broadcaster || 'mini';
  let n = 0;
  const msg = (name, color, level, badges, fragments, extra = {}) => ({
    kind: 'message', id: `p${n++}`, time: Date.now() - (20 - n) * 37_000, user: { id: `u${n}`, login: name.toLowerCase(), name }, color, level,
    badges, fragments, rewardId: null, hiddenReward: false, highlighted: false, replyTo: null, own: false, test: false, ...extra,
  });
  const ev = (event, icon, text, user, extra = {}) => ({ kind: 'event', id: `p${n++}`, time: Date.now(), event, icon, text, user, detail: '', hiddenReward: false, test: false, ...extra });
  return [
    msg('maxart', '#1E90FF', 1, [{ set: 'subscriber', id: '0' }], [{ type: 'text', text: 'Hallo zusammen! ' }, { type: 'emote', text: 'HeyGuys', emoteId: '30259' }]),
    msg('Nightbot', '#7C7CE1', 3, [{ set: 'moderator', id: '1' }], [{ type: 'text', text: 'Folgt gerne auf Insta!' }]),
    msg('Luna', '#FF69B4', 2, [{ set: 'vip', id: '1' }], [{ type: 'text', text: 'Das war **mega** gut, *wirklich*! [regenbogen]GG[/]' }]),
    ev('sub', '⭐', '{user} hat abonniert (Tier 1)', 'NeuerFan'),
    msg('ModMarco', '#2E8B57', 3, [{ set: 'moderator', id: '1' }], [{ type: 'text', text: 'Denkt an die [gelb]Chat-Regeln[/] ✌️ ' }, { type: 'mention', text: '@Luna' }]),
    msg('zuschauer123', '', 0, [], [{ type: 'text', text: '!discord' }]),
    ev('redemption', '✨', '{user} löst „Jumpscare“ ein (500)', 'Spoilerfan', { hiddenReward: true }),
    msg('zuschauer123', '', 0, [], [{ type: 'text', text: third ? `lol ${third} ` : 'lol ' }, { type: 'emote', text: 'Kappa', emoteId: '25' }]),
    msg('Trollo', '', 0, [], [{ type: 'text', text: 'gelöschte Nachricht' }], { deleted: true }),
    msg('Fragefix', '#FF7F50', 0, [], [{ type: 'text', text: `@${me} spielst du nachher noch was anderes?` }]),
    ev('raid', '🚀', '{user} raidet mit 42 Leuten!', 'CoolerStreamer'),
    msg('Mini', '#9146FF', 4, [{ set: 'broadcaster', id: '1' }], [{ type: 'text', text: 'Willkommen Raider! Hier ist `!discord` für euch ~~nicht~~ ' }, { type: 'emote', text: '<3', emoteId: '9' }], { own: true }),
  ];
}

function renderOverlayPreview() {
  const o = settings.overlay;
  const box = $('#preview');
  box.className = 'cr-overlay no-i18n';
  ChatRender.applyOverlayStyle(box, o);
  const items = sampleItems().filter((i) => ChatRender.overlayVisible(i, o));
  const nodes = items.slice(-o.maxMessages).map((i) => ChatRender.overlayItem(i, o, false));
  if (o.direction === 'top') nodes.reverse();
  box.replaceChildren(...nodes);
  $('#preview-stage').className = `preview-stage no-i18n bg-${previewBg}`;
}

function renderWindowPreview() {
  const w = settings.window;
  const box = $('#window-preview');
  ChatRender.applyWindowStyle(box, w);
  const login = ChatRender.getAssets().broadcaster || 'mini';
  box.replaceChildren(...sampleItems().filter((i) => ChatRender.windowVisible(i, w)).map((item) => {
    if (item.kind === 'event') {
      const node = ChatRender.event(item);
      if (item.hiddenReward) {
        node.classList.add('cr-muted');
        node.querySelector('.cr-ev-line').append(h('span', { class: 'cr-mute-note' }, settings.overlay.respectAlertFilter ? '🔕 nicht im Overlay' : '🔕 stumm'));
      }
      return node;
    }
    const node = ChatRender.windowMessage(item, w);
    if (ChatRender.windowHighlight(item, w, login)) node.classList.add('cr-hl');
    return node;
  }));
}

function renderPreviews() {
  if (!settings) return;
  renderOverlayPreview();
  renderWindowPreview();
}

function renderSwatches() {
  $('#bg-swatches').replaceChildren(...PREVIEW_BGS.map(([id, label]) =>
    h('button', { class: `swatch bg-${id}${previewBg === id ? ' selected' : ''}`, title: label, onclick: () => { previewBg = id; renderSwatches(); renderOverlayPreview(); } })));
}

// ============================================================ Tabs

function renderOverlayForm() {
  const nameColorField = h('div');
  const renderNameColor = () => nameColorField.replaceChildren(settings.overlay.nameColorMode === 'fixed'
    ? field('Feste Namensfarbe', color('overlay.nameColor'))
    : note('Jeder Name in seiner Twitch-Farbe.'));
  renderNameColor();

  $('#overlay-form').replaceChildren(
    h('p', { class: 'scope' }, '🎨 Alles hier gilt nur für das OBS-Overlay, das deine Zuschauer sehen. Das Chat-Fenster stellst du im Tab „🪟 Chat-Fenster“ ein.'),
    group('🔤 Schrift',
      h('div', { class: 'row3' },
        field('Schriftart', select('overlay.font', Object.keys(ChatRender.FONTS).map((f) => [f, f]))),
        field('Größe (px)', number('overlay.fontSize', 10, 80)),
        field('Stärke', select('overlay.fontWeight', [[400, 'Normal'], [500, 'Medium'], [600, 'Halbfett'], [700, 'Fett'], [800, 'Extrafett'], [900, 'Black']]))),
      h('div', { class: 'row2' },
        field('Textfarbe', color('overlay.textColor')),
        field('Namensfarbe', select('overlay.nameColorMode', [['twitch', 'Twitch-Farbe der Leute'], ['fixed', 'Feste Farbe']], renderNameColor))),
      nameColorField,
      check('Textschatten (besser lesbar auf hellem Hintergrund)', 'overlay.textShadow')),
    group('🔲 Aussehen',
      h('div', { class: 'row2' },
        field('Hintergrund der Nachrichten', color('overlay.background')),
        field('Deckkraft (%)', number('overlay.backgroundOpacity', 0, 100))),
      check('Abgerundete Ecken', 'overlay.rounded'),
      check('Abzeichen anzeigen (Sub, Mod, VIP …)', 'overlay.showBadges'),
      h('div', { class: 'row2' },
        field('Anordnung', select('overlay.layout', [['inline', 'Name: Nachricht (eine Zeile)'], ['stacked', 'Name über der Nachricht']])),
        field('Ausrichtung', select('overlay.align', [['left', 'Links'], ['right', 'Rechts']])))),
    group('🎬 Verhalten',
      h('div', { class: 'row3' },
        field('Neue Nachrichten', select('overlay.direction', [['bottom', 'Unten (wie Twitch)'], ['top', 'Oben']])),
        field('Animation', select('overlay.animation', [['slide', 'Reinrutschen'], ['fade', 'Einblenden'], ['pop', 'Aufploppen'], ['none', 'Keine']])),
        field('Max. Nachrichten', number('overlay.maxMessages', 1, 100))),
      field('Ausblenden nach … Sekunden (0 = nie)', number('overlay.fadeOutSeconds', 0, 3600))),
    rulesGroup('overlay', '✍️ Markdown, Farben & Emotes im Overlay',
      'Zuschauer können im Overlay fett, kursiv oder farbig schreiben. In Twitch selbst sieht man die Zeichen ganz normal.'),
    group('🙈 Ausblenden',
      check('!Commands ausblenden', 'overlay.hideCommands'),
      field('Diese Nutzer ausblenden (z.B. Bots)', listInput('overlay.hiddenUsers', 'nightbot, streamelements')),
      check('Kanalpunkte-Einlösungen verstecken, die im Alert-Filter stumm sind', 'overlay.respectAlertFilter'),
      note('Damit verrät auch der Chat keinen HudFX-Jumpscare.')),
    group('🔔 Events im Overlay',
      note('Welche Events zwischen den Chat-Nachrichten erscheinen.'),
      eventChips('overlay.events')),
    resetButton('overlay', 'Alle Overlay-Einstellungen auf Standard zurücksetzen?'),
  );
}

function renderWindowForm() {
  $('#window-form').replaceChildren(
    h('p', { class: 'scope' }, '🪟 Alles hier gilt nur für dein Chat-Fenster (wie Chatterino). Das sieht nur du, am OBS-Overlay ändert sich nichts.'),
    group('👀 Darstellung',
      h('div', { class: 'row2' },
        field('Schriftart', select('window.font', WINDOW_FONTS.map((f) => [f, f]))),
        field('Schriftgröße (px)', number('window.fontSize', 10, 30))),
      check('Uhrzeit vor jeder Nachricht', 'window.timestamps'),
      check('Uhrzeit mit Sekunden', 'window.timestampSeconds'),
      check('Abzeichen anzeigen', 'window.showBadges'),
      check('Zeilen abwechselnd leicht einfärben', 'window.alternateBackground')),
    rulesGroup('window', '✍️ Markdown, Farben & Emotes im Fenster',
      'Unabhängig vom Overlay: Du kannst z.B. im Fenster alles als reinen Text sehen, während das Overlay Farben zeigt.'),
    group('🙈 Ausblenden',
      check('!Commands ausblenden', 'window.hideCommands'),
      field('Diese Nutzer ausblenden', listInput('window.hiddenUsers', 'z.B. nightbot, streamelements')),
      h('div', { class: 'row2' },
        field('Stumme Kanalpunkte-Einlösungen (Alert-Filter)', select('window.mutedRewards', [['mark', 'Anzeigen, mit 🔕 markiert'], ['hide', 'Ausblenden']])),
        field('Gelöschte Nachrichten', select('window.deletedMessages', [['strike', 'Durchgestrichen anzeigen'], ['hide', 'Ausblenden']])))),
    group('🔴 Hervorheben',
      check('Nachrichten hervorheben, in denen du erwähnt wirst', 'window.highlightMentions'),
      field('Diese Stichwörter hervorheben', listInput('window.highlightWords', 'z.B. giveaway, frage, hilfe'))),
    group('🔔 Events im Fenster',
      note('Lässt sich auch direkt im Fenster über 🔔 umschalten.'),
      eventChips('window.events')),
    resetButton('window', 'Alle Einstellungen des Chat-Fensters auf Standard zurücksetzen?'),
  );
}

function renderHelpForm() {
  const example = (code, text) => {
    const item = { kind: 'message', id: 'x', time: Date.now(), user: { id: '0', login: 'x', name: 'x' }, color: '', level: 4, badges: [], fragments: [{ type: 'text', text }], rewardId: null };
    const rules = { markdown: { enabled: true, minRole: 'everyone' }, colors: { enabled: true, minRole: 'everyone' }, thirdPartyEmotes: true };
    const rendered = ChatRender.message(item, { rules });
    return [h('code', {}, code), h('span', { class: 'result' }, rendered.querySelector('.cr-text'))];
  };

  $('#help-form').replaceChildren(
    group('😀 Emotes von Drittanbietern',
      note('Emotes von 7TV, BTTV und FFZ werden automatisch geladen, deine eigenen Kanal-Emotes dort inklusive. Ob sie angezeigt werden, stellst du für Overlay und Fenster getrennt ein.'),
      check('7TV', 'emotes.seventv'),
      check('BTTV', 'emotes.bttv'),
      check('FFZ', 'emotes.ffz'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: reloadEmotes }, '↻ Emotes neu laden'),
        h('span', { class: 'note', id: 'emote-count' }, `${emoteCount} Emotes geladen`))),
    group('✍️ So schreibt man Markdown und Farben',
      note('Wer das darf, stellst du für Overlay und Chat-Fenster getrennt ein.'),
      h('div', { class: 'syntax' },
        ...example('**fett**', '**fett**'),
        ...example('*kursiv*', '*kursiv*'),
        ...example('~~durchgestrichen~~', '~~durchgestrichen~~'),
        ...example('`code`', '`!discord`'),
        ...example('[rot]Text[/]', '[rot]Text[/]'),
        ...example('[#ff00aa]Text[/]', '[#ff00aa]Text[/]'),
        ...example('[regenbogen]Text[/]', '[regenbogen]Regenbogen![/]')),
      note('Farbnamen: rot, grün, blau, gelb, lila, pink, orange, weiß, grau, gold, türkis, regenbogen (auch auf Englisch). Oder ein Farbcode wie #ff00aa.')),
  );
}

function renderForms() {
  renderOverlayForm();
  renderWindowForm();
  renderHelpForm();
  renderPreviews();
}

// ============================================================ Aktionen

async function openWindow() {
  try {
    await api(`${BASE}/window/open`, {});
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('URL kopiert', 'ok');
  } catch {
    toast('Kopieren nicht möglich', 'err');
  }
}

async function reloadEmotes() {
  try {
    const r = await api(`${BASE}/assets/reload`, {});
    ChatRender.setAssets(await api(`${BASE}/assets`));
    emoteCount = r.emotes;
    $('#emote-count').textContent = `${emoteCount} Emotes geladen`;
    renderPreviews();
    toast('Emotes neu geladen', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
}

/** Änderungen aus dem Chat-Fenster (A+/A−, 🔔) übernehmen, damit das Formular aktuell bleibt */
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws?channel=chat`);
  ws.onmessage = async (msg) => {
    const data = JSON.parse(msg.data);
    if (!settings) return;
    if (data.kind === 'settings' && data.source !== SOURCE) {
      const fresh = await api(`${BASE}/settings`).catch(() => null);
      if (!fresh) return;
      settings = deepMerge(fresh, structuredClone(pending));
      // Nicht neu zeichnen, während jemand gerade in ein Feld tippt
      if (!document.activeElement?.matches('input[type="text"], input[type="number"]')) renderForms();
    } else if (data.kind === 'assets') {
      ChatRender.setAssets(await api(`${BASE}/assets`).catch(() => null));
      renderPreviews();
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

// ============================================================ Start

(async () => {
  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  $('#open-window').onclick = openWindow;
  $('#open-window-2').onclick = openWindow;
  const overlayUrl = `${location.origin}/addons/chat/overlay.html`;
  const dockUrl = `${location.origin}/addons/chat/window.html`;
  $('#overlay-url').value = overlayUrl;
  $('#dock-url').value = dockUrl;
  $('#copy-overlay').onclick = () => copyText(overlayUrl);
  $('#copy-dock').onclick = () => copyText(dockUrl);
  $('#test-message').onclick = () => api(`${BASE}/test`, { type: 'message' }).then(() => toast('Test-Nachricht geschickt', 'ok')).catch((e) => toast(e.message, 'err'));
  $('#test-event').onclick = () => api(`${BASE}/test`, { type: 'event' }).then(() => toast('Test-Event geschickt', 'ok')).catch((e) => toast(e.message, 'err'));

  try {
    const [s, d, assets] = await Promise.all([api(`${BASE}/settings`), api(`${BASE}/defaults`), api(`${BASE}/assets`).catch(() => null)]);
    settings = s;
    defaults = d;
    ChatRender.setAssets(assets);
    emoteCount = Object.keys(assets?.emotes ?? {}).length;
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  renderSwatches();
  renderForms();
  connect();
})();
