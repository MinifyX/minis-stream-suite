const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/shoutout';

const ROLES = [
  ['everyone', 'Alle'],
  ['subscriber', 'Subs'],
  ['vip', 'VIPs'],
  ['moderator', 'Mods'],
  ['broadcaster', 'Nur du'],
];
const SOURCES = { command: '💬 Command', raid: '🚀 Raid', manual: '🖱 Dashboard', twitch: '🟣 bei Twitch' };
const API_BADGE = {
  sent: ['ok', '✓ Twitch-Shoutout'],
  queued: ['warn', '⏳ wartet'],
  failed: ['err', '✕ Twitch-Shoutout'],
  skipped: ['', '– Twitch-Shoutout'],
  off: ['', 'ohne Twitch-Shoutout'],
};

const state = {
  data: null,
  clockOffset: 0,
  /** Vorschau für „Shoutout geben“ */
  preview: null,
  /** Häkchen in der Vorschau (bleiben beim Neuladen erhalten) */
  opts: null,
};

const OVERLAY_URL = `http://localhost:${location.port}/addons/shoutout/overlay.html`;

const fmtTime = (t) => new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
/** Restzeit wie „1:23“ */
const fmtLeft = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} Std.`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/** „vor 5 Min.“ */
const ago = (t) => {
  const min = Math.floor((Date.now() + state.clockOffset - t) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  if (min < 1440) return `vor ${Math.floor(min / 60)} Std.`;
  return fmtTime(t);
};
const now = () => Date.now() + state.clockOffset;

async function call(path, body) {
  try {
    const data = await api(`${BASE}${path}`, body);
    if (data && data.settings) setData(data);
    return data ?? true;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

function setData(data) {
  state.data = data;
  state.clockOffset = data.now - Date.now();
  render();
}

const load = () => call('/state');

// ============================================================ Anzeigen

function render() {
  if (!state.data) return;
  renderToggle();
  renderWarnings();
  renderQueue();
  renderHistory();
  renderOverlayNow();
  renderHelp();
}

function renderToggle() {
  const on = state.data.settings.enabled;
  const box = $('#enabled-toggle');
  if (box.dataset.on === String(on)) return;
  box.dataset.on = String(on);
  box.replaceChildren(toggle(on, (v) => call('/settings', { enabled: v }), 'Shoutouts an/aus'), on ? 'An' : 'Aus');
}

function renderWarnings() {
  const d = state.data;
  const list = [];
  if (!d.loggedIn) {
    list.push(h('div', { class: 'conflict err' }, 'Nicht bei Twitch eingeloggt – Shoutouts, Vorschau und Clips brauchen die Verbindung. Verbinde dich in der Übersicht mit Twitch.'));
  } else if (d.broadcasterType === '' && d.settings.apiShoutout) {
    list.push(h('div', { class: 'conflict' }, 'Dein Kanal ist (noch) kein Affiliate oder Partner. Den echten Twitch-Shoutout gibt es erst dann – Chat-Nachricht und Clip-Overlay funktionieren aber schon.'));
  }
  const key = JSON.stringify([d.loggedIn, d.broadcasterType, d.settings.apiShoutout, state.clash ?? []]);
  const box = $('#warnings');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (state.clash?.length) {
    list.push(h('div', { class: 'conflict' }, `⚠ Im Chat-Commands-Addon gibt es auch ${state.clash.join(', ')}. Dann antworten beide. Schalte den Command dort aus oder lösche ihn.`));
  }
  box.replaceChildren(...list);
}

function renderQueue() {
  const d = state.data;
  const box = $('#queue');
  $('#queue-clear').hidden = d.queue.length < 2;
  const info = h('div', { class: 'queue-info', 'data-global': d.globalReadyAt });
  if (!d.queue.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'Nichts wartet. Blockiert Twitch einen Shoutout, landet er hier und geht automatisch raus.'), info);
    tick();
    return;
  }
  box.replaceChildren(h('div', { class: 'list' }, ...d.queue.map((p, i) => {
    return h('div', { class: 'item' },
      h('div', { class: 'main' },
        h('div', { class: 'top' },
          h('span', { class: 'name' }, `${i + 1}. ${p.target.name}`),
          h('span', { class: 'badge' }, SOURCES[p.source] ?? p.source),
          p.by && p.source !== 'raid' ? h('span', { class: 'badge' }, `von ${p.by}`) : null),
        h('div', { class: 'detail' }, `seit ${ago(p.addedAt)} in der Warteschlange`)),
      h('span', { class: 'eta', 'data-ready': p.readyAt, title: 'Frühestens dann erlaubt Twitch den Shoutout' }),
      h('button', { class: 'icon-btn', title: 'Aus der Warteschlange nehmen', onclick: () => call('/queue/remove', { id: p.id }) }, '🗑'));
  })), info);
  tick();
}

/** Countdowns jede Sekunde aktualisieren (ohne die Liste neu zu bauen, damit Klicks nicht verloren gehen) */
function tick() {
  for (const el of document.querySelectorAll('[data-ready]')) {
    const left = Number(el.dataset.ready) - now();
    el.textContent = left > 0 ? fmtLeft(left) : 'gleich';
  }
  const info = $('[data-global]');
  if (info) {
    const left = Number(info.dataset.global) - now();
    info.textContent = left > 0 ? `Nächster Twitch-Shoutout möglich in ${fmtLeft(left)}` : 'Ein Twitch-Shoutout ist gerade möglich.';
  }
}

function renderHistory() {
  const list = state.data.history;
  const box = $('#history');
  $('#history-clear').hidden = !list.length;
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'Noch keine Shoutouts.'));
    return;
  }
  box.replaceChildren(h('div', { class: 'list' }, ...list.map((e) => {
    const [cls, label] = API_BADGE[e.api] ?? ['', e.api];
    const details = [
      e.game ? `🎮 ${e.game}` : null,
      e.viewers !== undefined ? `${e.viewers} Raider` : null,
      e.clip ? `🎬 ${e.clip}` : null,
    ].filter(Boolean).join(' · ');
    return h('div', { class: 'item' },
      h('div', { class: 'main' },
        h('div', { class: 'top' },
          h('span', { class: 'name' }, h('a', { href: `https://twitch.tv/${e.target.login}`, target: '_blank', rel: 'noopener' }, e.target.name)),
          h('span', { class: 'badge' }, SOURCES[e.source] ?? e.source),
          e.by && e.source !== 'raid' && e.source !== 'manual' ? h('span', { class: 'badge' }, `von ${e.by}`) : null,
          e.chat ? h('span', { class: 'badge accent' }, '💬 Chat') : null,
          e.source !== 'twitch' ? h('span', { class: `badge ${cls}`, title: e.apiNote }, label) : null),
        e.source !== 'twitch' && e.apiNote && e.api !== 'sent' ? h('div', { class: 'detail', title: e.apiNote }, `Twitch-Shoutout: ${e.apiNote}`) : null,
        details ? h('div', { class: 'detail', title: details }, details) : null),
      h('span', { class: 'when', title: fmtTime(e.at) }, ago(e.at)),
      h('button', {
        class: 'icon-btn', title: 'Nochmal (in „Shoutout geben“ übernehmen)',
        onclick: () => { $('#so-name').value = e.target.login; void loadPreview(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
      }, '↻'));
  })));
}

function renderOverlayNow() {
  const o = state.data.overlay;
  const box = $('#overlay-now');
  if (!o.showing) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(h('div', { class: 'now-playing' },
    `▶ Läuft gerade: ${o.showing.name}${o.showing.clip ? ` – „${o.showing.clip}“` : ' (ohne Clip)'}`,
    o.waiting ? ` · ${o.waiting} warten` : ''));
}

function renderHelp() {
  const s = state.data.settings;
  const main = s.commands[0] ?? 'so';
  $('#main-cmd').textContent = `!${main} @name`;
  const box = $('#chat-help');
  const key = JSON.stringify([s.commands, s.permission, s.raid.enabled]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const role = ROLES.find(([v]) => v === s.permission)?.[1] ?? s.permission;
  box.replaceChildren(
    h('div', {}, h('code', {}, `!${main} @name`), ` – Shoutout (${s.permission === 'broadcaster' ? 'nur du' : s.permission === 'everyone' ? 'alle' : `${role} und du`})`),
    s.commands.length > 1 ? h('div', {}, 'Geht auch mit: ', s.commands.slice(1).map((c, i) => [i ? ', ' : '', h('code', {}, `!${c}`)])) : null,
    h('div', {}, h('b', {}, 'Raids: '), s.raid.enabled ? `automatischer Shoutout${s.raid.minViewers > 1 ? ` ab ${s.raid.minViewers} Zuschauern` : ''}, ${s.raid.delaySeconds} Sek. nach dem Raid.` : 'kein automatischer Shoutout (in den Einstellungen einschaltbar).'));
  void checkConflicts();
}

/** Gibt es im Commands-Addon einen Command mit gleichem Namen? Dann würden zwei Antworten kommen. */
async function checkConflicts() {
  const names = state.data.settings.commands;
  let clash = [];
  try {
    const cmds = await api('addons/commands/state');
    clash = cmds.settings.commands
      .filter((x) => x.enabled && [x.name, ...x.aliases].some((n) => names.includes(n)))
      .map((x) => `${cmds.settings.prefix}${x.name}`);
  } catch {
    // Commands-Addon ist aus → kein Konflikt
  }
  state.clash = clash;
  renderWarnings();
}

// ============================================================ Shoutout geben (Vorschau)

async function loadPreview() {
  const name = $('#so-name').value.trim();
  if (!name) return;
  const box = $('#preview');
  box.replaceChildren(h('div', { class: 'note' }, 'Lade Kanal …'));
  try {
    state.preview = await api(`${BASE}/lookup?name=${encodeURIComponent(name)}`);
  } catch (err) {
    state.preview = null;
    box.replaceChildren(h('div', { class: 'conflict err' }, err.message));
    return;
  }
  const s = state.data.settings;
  state.opts ??= { chat: true, api: s.apiShoutout, clip: s.clip.onCommand };
  renderPreview();
}

function renderPreview() {
  const p = state.preview;
  const box = $('#preview');
  if (!p) {
    box.replaceChildren();
    return;
  }
  const t = p.target;
  const o = state.opts;
  const typeLabel = t.broadcasterType === 'partner' ? 'Partner' : t.broadcasterType === 'affiliate' ? 'Affiliate' : null;
  const apiCls = { sent: 'ok', queued: 'warn', failed: 'err' }[p.api.status] ?? '';

  const give = async (btn) => {
    btn.disabled = true;
    const r = await call('/shoutout', { name: t.login, chat: o.chat, api: o.api, clip: o.clip });
    btn.disabled = false;
    if (!r) return;
    setData(r.state);
    const apiText = r.entry.api === 'sent' ? 'Twitch-Shoutout gesendet' : `Twitch-Shoutout: ${r.entry.apiNote}`;
    toast(`Shoutout an ${t.name}! ${o.api ? apiText : ''}`, r.entry.api === 'failed' ? 'err' : 'ok');
    void loadPreview();
  };

  const opt = (key, label) => h('label', { class: 'opt-row' }, toggle(o[key], (v) => { o[key] = v; }, label), h('span', {}, label));

  box.replaceChildren(h('div', { class: 'pv' },
    h('div', { class: 'pv-head' },
      t.avatar ? h('img', { class: 'pv-avatar', src: t.avatar, alt: '' }) : h('div', { class: 'pv-avatar' }),
      h('div', { class: 'pv-who' },
        h('div', { class: 'pv-name' },
          h('a', { href: `https://twitch.tv/${t.login}`, target: '_blank', rel: 'noopener' }, t.name),
          p.live ? h('span', { class: 'badge err' }, `● LIVE · ${p.live.viewers} Zuschauer`) : h('span', { class: 'badge' }, 'offline'),
          typeLabel ? h('span', { class: 'badge accent' }, typeLabel) : null),
        h('div', { class: 'pv-meta' }, `🎮 ${t.game || 'keine Kategorie'}`),
        t.title ? h('div', { class: 'pv-meta no-i18n', title: t.title }, t.title) : null)),
    p.clip
      ? h('div', { class: 'pv-clip' },
        h('a', { href: p.clip.url, target: '_blank', rel: 'noopener' }, h('img', { src: p.clip.thumbnail, alt: '' })),
        h('div', {},
          h('div', { class: 't no-i18n' }, `🎬 ${p.clip.title}`),
          h('div', { class: 'note' }, `${p.clip.views.toLocaleString('de-DE')} Aufrufe · ${Math.round(p.clip.duration)} Sek. · ${fmtTime(new Date(p.clip.createdAt).getTime())}`),
          h('div', { class: 'note' }, state.data.settings.clip.mode === 'random' ? 'Zufällig aus den Top-Clips – beim Shoutout kann es ein anderer sein.' : 'Meistgesehener Clip nach deinen Einstellungen.')))
      : h('div', { class: 'note' }, 'Keine Clips gefunden.'),
    h('div', { class: 'pv-api' }, h('span', { class: `badge ${apiCls}` }, 'Twitch-Shoutout'), ' ', p.api.note),
    p.lastAt ? h('div', { class: 'note' }, `Letzter Shoutout an ${t.name}: ${ago(p.lastAt)}`) : null,
    p.self
      ? h('div', { class: 'conflict' }, 'Das bist du selbst – dir selbst kannst du keinen Shoutout geben 😄')
      : [
        h('div', { class: 'pv-opts' }, opt('chat', 'Chat-Nachricht'), opt('api', 'Twitch-Shoutout'), opt('clip', 'Clip im Overlay')),
        h('div', { class: 'pv-foot' },
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => { state.preview = null; renderPreview(); } }, 'Schließen'),
          h('button', { class: 'btn primary', onclick: (e) => give(e.currentTarget) }, '📣 Shoutout geben')),
      ]));
}

// ============================================================ Testen

function logTest(input, r) {
  $('#test-log').prepend(
    h('div', {},
      h('div', { class: 'in no-i18n' }, input),
      ...(r.replies.length ? r.replies.map((t) => h('div', { class: 'out no-i18n' }, t)) : [h('div', { class: 'none' }, '(keine Chat-Nachricht)')]),
      ...(r.notes ?? []).map((n) => h('div', { class: 'info' }, `ℹ ${n}`))));
}

async function runTest() {
  const text = $('#test-message').value.trim();
  if (!text) return;
  const user = $('#test-user').value.trim() || 'TestMod';
  const role = $('#test-role').value;
  try {
    const r = await api(`${BASE}/test`, { user, role, message: text });
    logTest([h('b', {}, user), ` (${ROLES.find(([v]) => v === role)?.[1]}): ${text}`], r);
    $('#test-message').value = '';
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function runRaid() {
  const name = $('#raid-name').value.trim();
  if (!name) {
    toast('Gib den Kanal ein, der raidet.', 'err');
    return;
  }
  const viewers = Number($('#raid-viewers').value) || 0;
  try {
    const r = await api(`${BASE}/test`, { kind: 'raid', name, viewers });
    logTest([h('b', {}, '🚀 Raid'), `: ${name} mit ${viewers} Zuschauern`], r);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================ Overlay

async function testOverlay() {
  const r = await call('/overlay/test', { name: $('#so-name').value.trim() });
  if (!r) return;
  toast(r.clip ? `Overlay: Clip „${r.clip.title}“ von ${r.name}` : `Overlay: Karte von ${r.name} (kein Clip gefunden)`, 'ok');
  void load();
}

// ============================================================ Einstellungen

function openSettings() {
  const s = structuredClone(state.data.settings);
  const host = $('#modal-host');
  const close = () => host.replaceChildren();
  const num = (value, min, max) => h('input', { type: 'number', min, max, value });
  const area = (value) => {
    const t = h('textarea', { rows: 2, maxlength: 500 });
    t.value = value;
    return t;
  };
  const field = (label, ...controls) => h('div', { class: 'field' }, h('label', {}, label), ...controls);
  const vars = (list) => h('div', { class: 'note' }, 'Variablen: ', list.map((v, i) => [i ? ', ' : '', h('code', {}, v)]));
  const opt = (value, onchange, label) => h('div', { class: 'opt-row' }, toggle(value, onchange, label), h('span', {}, label));
  const select = (options, value) => h('select', {}, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));

  const commands = h('input', { type: 'text', value: s.commands.join(', '), maxlength: 200 });
  const permission = select(ROLES, s.permission);
  const sameTarget = num(s.sameTargetSeconds, 0, 3600);
  const message = area(s.message);
  const raidMin = num(s.raid.minViewers, 0, 100000);
  const raidDelay = num(s.raid.delaySeconds, 0, 300);
  const raidMessage = area(s.raid.message);
  const clipMode = select([['top', 'Meistgesehener Clip'], ['random', 'Zufällig aus den Top X']], s.clip.mode);
  const clipDays = num(s.clip.days, 0, 3650);
  const clipTop = num(s.clip.topCount, 2, 50);
  const clipMax = num(s.clip.maxSeconds, 5, 60);
  const cardSeconds = num(s.clip.cardSeconds, 0, 60);
  const accent = h('input', { type: 'color', value: s.clip.accent });
  const topField = field('Top X', clipTop);
  const syncMode = () => { topField.hidden = clipMode.value !== 'random'; };
  clipMode.onchange = syncMode;
  syncMode();

  const commonVars = ['{user}', '{login}', '{game}', '{title}', '{link}', '{by}', '{channel}', '{uptime}'];

  const save = async () => {
    const r = await call('/settings', {
      commands: commands.value,
      permission: permission.value,
      sameTargetSeconds: Number(sameTarget.value),
      message: message.value,
      apiShoutout: s.apiShoutout,
      raid: { enabled: s.raid.enabled, minViewers: Number(raidMin.value), delaySeconds: Number(raidDelay.value), message: raidMessage.value },
      clip: {
        onCommand: s.clip.onCommand,
        onRaid: s.clip.onRaid,
        mode: clipMode.value,
        days: Number(clipDays.value),
        topCount: Number(clipTop.value),
        allTimeFallback: s.clip.allTimeFallback,
        maxSeconds: Number(clipMax.value),
        cardSeconds: Number(cardSeconds.value),
        accent: accent.value,
        showClipTitle: s.clip.showClipTitle,
      },
    });
    if (r) {
      toast('Gespeichert', 'ok');
      close();
    }
  };

  host.replaceChildren(h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, '⚙ Shoutout-Einstellungen'), h('button', { class: 'icon-btn', onclick: close }, '✕')),
      h('div', { class: 'modal-body' },
        h('div', { class: 'sub' }, 'COMMAND'),
        h('div', { class: 'f-row' },
          field('Command-Namen (ohne !, mit Komma getrennt)', commands),
          field('Wer darf ihn benutzen?', permission)),
        field('Spam-Schutz: denselben Kanal erst wieder nach (Sek.)', sameTarget),

        h('div', { class: 'sub' }, 'CHAT-NACHRICHT (LEER = KEINE)'),
        field('Nachricht', message), vars(commonVars),

        h('div', { class: 'sub' }, 'TWITCH-SHOUTOUT'),
        opt(s.apiShoutout, (on) => { s.apiShoutout = on; }, 'Zusätzlich den echten Twitch-Shoutout geben'),
        h('p', { class: 'note' }, 'Nur für Affiliates und Partner und nur, während du live bist. Twitch erlaubt einen Shoutout alle 2 Minuten und denselben Kanal nur einmal pro Stunde – was gesperrt ist, wartet in der Warteschlange. Beim Streamende wird die Warteschlange geleert.'),

        h('div', { class: 'sub' }, 'RAIDS'),
        opt(s.raid.enabled, (on) => { s.raid.enabled = on; }, 'Automatischer Shoutout, wenn dich jemand raidet'),
        h('div', { class: 'f-row' }, field('Ab wie vielen Zuschauern?', raidMin), field('Verzögerung (Sek.)', raidDelay)),
        field('Nachricht bei Raids (leer = normale Nachricht)', raidMessage), vars([...commonVars.slice(0, 5), '{viewers}']),

        h('div', { class: 'sub' }, 'CLIP IM OVERLAY'),
        opt(s.clip.onCommand, (on) => { s.clip.onCommand = on; }, 'Bei !so (Command) einen Clip zeigen'),
        opt(s.clip.onRaid, (on) => { s.clip.onRaid = on; }, 'Bei Raids einen Clip zeigen'),
        h('div', { class: 'f-row' }, field('Welcher Clip?', clipMode), topField),
        h('div', { class: 'f-row' }, field('Nur Clips der letzten … Tage (0 = alle)', clipDays), field('Clip höchstens (Sek.)', clipMax)),
        opt(s.clip.allTimeFallback, (on) => { s.clip.allTimeFallback = on; }, 'Kein Clip in dem Zeitraum? Dann die besten aller Zeiten nehmen'),
        h('div', { class: 'f-row' }, field('Ohne Clip nur die Karte zeigen (Sek., 0 = nichts)', cardSeconds), field('Rahmenfarbe', accent)),
        opt(s.clip.showClipTitle, (on) => { s.clip.showClipTitle = on; }, 'Titel des Clips anzeigen'),
        h('p', { class: 'note' }, 'Kommen mehrere Shoutouts kurz hintereinander, zeigt das Overlay sie nacheinander.')),
      h('div', { class: 'modal-foot' },
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: close }, 'Abbrechen'),
        h('button', { class: 'btn primary', onclick: save }, 'Speichern')))));
}

// ============================================================ Start

(async () => {
  $('#open-settings').onclick = openSettings;
  $('#so-preview').onclick = () => { state.opts = null; void loadPreview(); };
  $('#so-name').onkeydown = (e) => { if (e.key === 'Enter') { state.opts = null; void loadPreview(); } };
  $('#queue-clear').onclick = () => { if (confirm('Alle wartenden Twitch-Shoutouts verwerfen?')) call('/queue/clear', {}); };
  $('#history-clear').onclick = () => { if (confirm('Den ganzen Verlauf löschen?')) call('/history/clear', {}); };
  $('#overlay-url').value = OVERLAY_URL;
  $('#copy-url').onclick = async () => {
    await navigator.clipboard.writeText(OVERLAY_URL).catch(() => {});
    toast('Adresse kopiert', 'ok');
  };
  $('#overlay-test').onclick = testOverlay;
  $('#overlay-stop').onclick = () => call('/overlay/stop', {}).then(() => load());
  $('#test-role').replaceChildren(...ROLES.map(([v, label]) => h('option', { value: v, selected: v === 'moderator' }, label)));
  $('#test-run').onclick = runTest;
  $('#test-message').onkeydown = (e) => { if (e.key === 'Enter') runTest(); };
  $('#raid-run').onclick = runRaid;

  await load();
  if (state.data) $('#test-message').placeholder = `!${state.data.settings.commands[0] ?? 'so'} @name`;
  // Countdowns jede Sekunde, alles andere alle 5 Sekunden neu laden
  setInterval(tick, 1000);
  setInterval(() => {
    if ($('#modal-host').childElementCount) return;
    void load();
  }, 5000);
})();
