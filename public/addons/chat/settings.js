const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/chat';

const EVENT_LABELS = {
  follow: '💜 Follows', sub: '⭐ Neue Abos', resub: '⭐ Abo-Verlängerungen', giftsub: '🎁 Verschenkte Abos',
  cheer: '💎 Bits', raid: '🚀 Raids', redemption: '✨ Kanalpunkte-Einlösungen', stream: '🔴 Stream-Start/-Ende',
  hypetrain: '🚂 Hype Train', prediction: '🔮 Vorhersagen', shoutout: '📣 Shoutouts', ads: '📺 Werbepausen',
};
const ROLES = [['everyone', 'Alle'], ['subscriber', 'Subs'], ['vip', 'VIPs'], ['moderator', 'Mods'], ['broadcaster', 'Nur du']];
const PREVIEW_BGS = [['checker', 'Transparent'], ['game', 'Spiel-Szene'], ['black', 'Schwarz'], ['white', 'Weiß'], ['green', 'Greenscreen']];

let settings = null;
let emoteCount = 0;
let previewBg = 'game';

// ============================================================ Speichern

let saveTimer = null;
function changed(rerender = true) {
  $('#save-state').textContent = 'Nicht gespeichert…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  if (rerender) renderPreview();
}

async function save() {
  try {
    settings = await api(`${BASE}/settings`, { settings });
    $('#save-state').textContent = 'Gespeichert ✓';
  } catch (err) {
    $('#save-state').textContent = 'Fehler beim Speichern';
    toast(err.message, 'err');
  }
}

// ============================================================ Formular-Bausteine

const field = (label, ...controls) => h('div', { class: 'f' }, h('label', {}, label), ...controls);
const group = (title, ...children) => h('div', { class: 'group' }, h('h2', {}, title), ...children.filter(Boolean));
const note = (text) => h('p', { class: 'note' }, text);

function check(label, obj, key, after) {
  return h('div', { class: 'check' }, toggle(obj[key], (on) => { obj[key] = on; changed(); after?.(); }, label), h('span', {}, label));
}

function select(obj, key, options, after) {
  const el = h('select', { onchange: (e) => { obj[key] = /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value; changed(); after?.(); } },
    ...options.map(([v, l]) => h('option', { value: v }, l)));
  el.value = String(obj[key]);
  return el;
}

function number(obj, key, min, max, step = 1) {
  return h('input', {
    type: 'number', min, max, step, value: obj[key],
    onchange: (e) => {
      const v = Math.max(min, Math.min(max, Number(e.target.value) || 0));
      e.target.value = v;
      obj[key] = v;
      changed();
    },
  });
}

function color(obj, key) {
  const picker = h('input', { type: 'color', value: obj[key] });
  const text = h('input', { type: 'text', value: obj[key], maxlength: 7 });
  picker.oninput = () => { text.value = picker.value.toUpperCase(); obj[key] = text.value; changed(); };
  text.onchange = () => {
    const v = text.value.startsWith('#') ? text.value : `#${text.value}`;
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      obj[key] = v.toUpperCase();
      picker.value = v;
      changed();
    } else text.value = obj[key];
  };
  return h('div', { class: 'color' }, picker, text);
}

function listInput(obj, key, placeholder) {
  return h('input', {
    type: 'text', value: obj[key].join(', '), placeholder,
    onchange: (e) => { obj[key] = e.target.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean); changed(); },
  });
}

function eventChips(events) {
  const box = h('div', { class: 'chips' });
  const render = () => box.replaceChildren(...Object.entries(EVENT_LABELS).map(([kind, label]) =>
    h('button', { class: `chip-toggle${events[kind] ? ' on' : ''}`, onclick: () => { events[kind] = !events[kind]; render(); changed(); } }, label)));
  render();
  return box;
}

// ============================================================ Vorschau

function sampleItems() {
  const assets = ChatRender.getAssets();
  const third = Object.keys(assets.emotes || {})[0];
  let n = 0;
  const msg = (name, color, level, badges, fragments, extra = {}) => ({
    kind: 'message', id: `p${n++}`, time: Date.now(), user: { id: `u${n}`, login: name.toLowerCase(), name }, color, level,
    badges, fragments, rewardId: null, hiddenReward: false, highlighted: false, replyTo: null, own: false, test: false, ...extra,
  });
  const ev = (event, icon, text, user, detail = '') => ({ kind: 'event', id: `p${n++}`, time: Date.now(), event, icon, text, user, detail, hiddenReward: false, test: false });
  return [
    msg('maxart', '#1E90FF', 1, [{ set: 'subscriber', id: '0' }], [{ type: 'text', text: 'Hallo zusammen! ' }, { type: 'emote', text: 'HeyGuys', emoteId: '30259' }]),
    msg('Luna', '#FF69B4', 2, [{ set: 'vip', id: '1' }], [{ type: 'text', text: 'Das war **mega** gut, *wirklich*! [regenbogen]GG[/]' }]),
    ev('sub', '⭐', '{user} hat abonniert (Tier 1)', 'NeuerFan'),
    msg('ModMarco', '#2E8B57', 3, [{ set: 'moderator', id: '1' }], [{ type: 'text', text: 'Denkt an die [gelb]Chat-Regeln[/] ✌️ ' }, { type: 'mention', text: '@Luna' }]),
    msg('zuschauer123', '', 0, [], [{ type: 'text', text: third ? `lol ${third} ` : 'lol ' }, { type: 'emote', text: 'Kappa', emoteId: '25' }]),
    ev('raid', '🚀', '{user} raidet mit 42 Leuten!', 'CoolerStreamer'),
    msg('Mini', '#9146FF', 4, [{ set: 'broadcaster', id: '1' }], [{ type: 'text', text: 'Willkommen Raider! Hier ist `!discord` für euch ~~nicht~~ ' }, { type: 'emote', text: '<3', emoteId: '9' }]),
  ];
}

function renderPreview() {
  if (!settings) return;
  const box = $('#preview');
  box.className = 'cr-overlay no-i18n';
  ChatRender.applyOverlayStyle(box, settings.overlay);
  const items = sampleItems().filter((i) => ChatRender.overlayVisible(i, settings.overlay));
  const nodes = items.slice(-settings.overlay.maxMessages).map((i) => ChatRender.overlayItem(i, settings, false));
  if (settings.overlay.direction === 'top') nodes.reverse();
  box.replaceChildren(...nodes);
  $('#preview-stage').className = `preview-stage no-i18n bg-${previewBg}`;
}

function renderSwatches() {
  $('#bg-swatches').replaceChildren(...PREVIEW_BGS.map(([id, label]) =>
    h('button', { class: `swatch bg-${id}${previewBg === id ? ' selected' : ''}`, title: label, onclick: () => { previewBg = id; renderSwatches(); renderPreview(); } })));
}

// ============================================================ Tabs

function renderOverlayForm() {
  const o = settings.overlay;
  const nameColorField = h('div');
  const renderNameColor = () => nameColorField.replaceChildren(o.nameColorMode === 'fixed' ? field('Feste Namensfarbe', color(o, 'nameColor')) : note('Jeder Name in seiner Twitch-Farbe.'));
  renderNameColor();

  $('#overlay-form').replaceChildren(
    group('🔤 Schrift',
      h('div', { class: 'row3' },
        field('Schriftart', select(o, 'font', Object.keys(ChatRender.FONTS).map((f) => [f, f]))),
        field('Größe (px)', number(o, 'fontSize', 10, 80)),
        field('Stärke', select(o, 'fontWeight', [[400, 'Normal'], [500, 'Medium'], [600, 'Halbfett'], [700, 'Fett'], [800, 'Extrafett'], [900, 'Black']]))),
      h('div', { class: 'row2' },
        field('Textfarbe', color(o, 'textColor')),
        field('Namensfarbe', select(o, 'nameColorMode', [['twitch', 'Twitch-Farbe der Leute'], ['fixed', 'Feste Farbe']], renderNameColor))),
      nameColorField,
      check('Textschatten (besser lesbar auf hellem Hintergrund)', o, 'textShadow')),
    group('🔲 Aussehen',
      h('div', { class: 'row2' },
        field('Hintergrund der Nachrichten', color(o, 'background')),
        field('Deckkraft (%)', number(o, 'backgroundOpacity', 0, 100))),
      check('Abgerundete Ecken', o, 'rounded'),
      check('Abzeichen anzeigen (Sub, Mod, VIP …)', o, 'showBadges'),
      h('div', { class: 'row2' },
        field('Anordnung', select(o, 'layout', [['inline', 'Name: Nachricht (eine Zeile)'], ['stacked', 'Name über der Nachricht']])),
        field('Ausrichtung', select(o, 'align', [['left', 'Links'], ['right', 'Rechts']])))),
    group('🎬 Verhalten',
      h('div', { class: 'row3' },
        field('Neue Nachrichten', select(o, 'direction', [['bottom', 'Unten (wie Twitch)'], ['top', 'Oben']])),
        field('Animation', select(o, 'animation', [['slide', 'Reinrutschen'], ['fade', 'Einblenden'], ['pop', 'Aufploppen'], ['none', 'Keine']])),
        field('Max. Nachrichten', number(o, 'maxMessages', 1, 100))),
      field('Ausblenden nach … Sekunden (0 = nie)', number(o, 'fadeOutSeconds', 0, 3600)),
      check('!Commands ausblenden', o, 'hideCommands'),
      field('Diese Nutzer ausblenden (z.B. Bots)', listInput(o, 'hiddenUsers', 'nightbot, streamelements'))),
    group('🔔 Events im Overlay',
      note('Welche Events zwischen den Chat-Nachrichten erscheinen.'),
      eventChips(o.events)),
  );
}

function renderWindowForm() {
  const w = settings.window;
  $('#window-form').replaceChildren(
    group('🪟 Chat-Fenster',
      note('Ein eigenes Fenster wie Chatterino: Chat lesen und schreiben, dazu Events wie Follows, Subs und Einlösungen. Kann immer im Vordergrund bleiben (📌 im Fenster).'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: openWindow }, '🪟 Chat-Fenster öffnen')),
      note('Tipp: Auch als OBS-Dock nutzbar. In OBS: Docks → Benutzerdefinierte Browser-Docks → diese URL:'),
      h('div', { class: 'url-row' },
        h('input', { type: 'text', readonly: true, value: `${location.origin}/addons/chat/window.html` }),
        h('button', { class: 'btn small', onclick: () => copyText(`${location.origin}/addons/chat/window.html`) }, 'Kopieren'))),
    group('👀 Darstellung',
      h('div', { class: 'row2' }, field('Schriftgröße (px)', number(w, 'fontSize', 10, 30)), h('div')),
      check('Uhrzeit vor jeder Nachricht', w, 'timestamps'),
      check('Abzeichen anzeigen', w, 'showBadges'),
      check('Zeilen abwechselnd leicht einfärben', w, 'alternateBackground'),
      check('!Commands ausblenden', w, 'hideCommands')),
    group('🔴 Hervorheben',
      check('Nachrichten hervorheben, in denen du erwähnt wirst', w, 'highlightMentions'),
      field('Diese Stichwörter hervorheben', listInput(w, 'highlightWords', 'z.B. giveaway, frage, hilfe'))),
    group('🔔 Events im Fenster', eventChips(w.events)),
  );
}

function renderGeneralForm() {
  const md = settings.markdown;
  const col = settings.colors;
  const example = (code, text, level = 4) => {
    const item = { kind: 'message', id: 'x', time: Date.now(), user: { id: '0', login: 'x', name: 'x' }, color: '', level, badges: [], fragments: [{ type: 'text', text }], rewardId: null };
    const rendered = ChatRender.message(item, { settings: { markdown: { enabled: true, minRole: 'everyone' }, colors: { enabled: true, minRole: 'everyone' } } });
    return [h('code', {}, code), h('span', { class: 'result' }, rendered.querySelector('.cr-text'))];
  };

  $('#general-form').replaceChildren(
    group('✍️ Markdown & Farben im Chat',
      note('Zuschauer können damit im Overlay und im Chat-Fenster fett, kursiv oder farbig schreiben. In Twitch selbst sieht man die Zeichen ganz normal.'),
      h('div', { class: 'row2' },
        h('div', { class: 'f' }, check('Markdown erlauben', md, 'enabled'), field('für', select(md, 'minRole', ROLES))),
        h('div', { class: 'f' }, check('Farben erlauben', col, 'enabled'), field('für', select(col, 'minRole', ROLES)))),
      h('div', { class: 'syntax' },
        ...example('**fett**', '**fett**'),
        ...example('*kursiv*', '*kursiv*'),
        ...example('~~durchgestrichen~~', '~~durchgestrichen~~'),
        ...example('`code`', '`!discord`'),
        ...example('[rot]Text[/]', '[rot]Text[/]'),
        ...example('[#ff00aa]Text[/]', '[#ff00aa]Text[/]'),
        ...example('[regenbogen]Text[/]', '[regenbogen]Regenbogen![/]')),
      note('Farbnamen: rot, grün, blau, gelb, lila, pink, orange, weiß, grau, gold, türkis, regenbogen (auch auf Englisch). Oder ein Farbcode wie #ff00aa.')),
    group('😀 Emotes von Drittanbietern',
      note('Emotes von 7TV, BTTV und FFZ werden automatisch geladen, deine eigenen Kanal-Emotes dort inklusive.'),
      check('7TV', settings.emotes, 'seventv'),
      check('BTTV', settings.emotes, 'bttv'),
      check('FFZ', settings.emotes, 'ffz'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: reloadEmotes }, '↻ Emotes neu laden'),
        h('span', { class: 'note', id: 'emote-count' }, `${emoteCount} Emotes geladen`))),
    group('🔕 Kanalpunkte & Spoiler',
      check('Einlösungen, die im Alert-Filter stumm sind, auch im Overlay verstecken', settings, 'respectAlertFilter'),
      note('Damit verrät auch der Chat keinen HudFX-Jumpscare. Im Chat-Fenster siehst du sie trotzdem (mit 🔕 markiert), das sieht ja nur du.')),
  );
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
    renderPreview();
    toast('Emotes neu geladen', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
}

// ============================================================ Start

(async () => {
  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  $('#open-window').onclick = openWindow;
  const overlayUrl = `${location.origin}/addons/chat/overlay.html`;
  $('#overlay-url').value = overlayUrl;
  $('#copy-overlay').onclick = () => copyText(overlayUrl);
  $('#test-message').onclick = () => api(`${BASE}/test`, { type: 'message' }).then(() => toast('Test-Nachricht geschickt', 'ok')).catch((e) => toast(e.message, 'err'));
  $('#test-event').onclick = () => api(`${BASE}/test`, { type: 'event' }).then(() => toast('Test-Event geschickt', 'ok')).catch((e) => toast(e.message, 'err'));

  try {
    const [s, assets] = await Promise.all([api(`${BASE}/settings`), api(`${BASE}/assets`).catch(() => null)]);
    settings = s;
    ChatRender.setAssets(assets);
    emoteCount = Object.keys(assets?.emotes ?? {}).length;
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  renderOverlayForm();
  renderWindowForm();
  renderGeneralForm();
  renderSwatches();
  renderPreview();
})();
