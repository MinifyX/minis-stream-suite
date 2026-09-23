const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/ads';

const WARNING_VARS = [
  ['{seconds}', 'Sekunden bis zur Werbung, z.B. 60'],
  ['{minutes}', 'Minuten bis zur Werbung, z.B. 5'],
  ['{time}', 'Lesbar, z.B. „5 Minuten“ oder „60 Sekunden“'],
  ['{duration}', 'Länge der Werbung in Sekunden'],
  ['{channel}', 'Dein Kanalname'],
];
const START_VARS = [['{duration}', 'Länge der Werbung in Sekunden'], ['{time}', 'Lesbar, z.B. „90 Sekunden“'], ['{channel}', 'Dein Kanalname']];
const END_VARS = [['{duration}', 'Wie lange die Werbung lief (Sekunden)'], ['{channel}', 'Dein Kanalname']];

const POSITIONS = [
  ['top-left', 'oben links'], ['top', 'oben'], ['top-right', 'oben rechts'],
  [null, ''], ['center', 'Mitte'], [null, ''],
  ['bottom-left', 'unten links'], ['bottom', 'unten'], ['bottom-right', 'unten rechts'],
];

const state = {
  data: null,
  /** Unterschied zwischen Uhr der Suite und diesem Fenster */
  clockOffset: 0,
  /** Bearbeitete Einstellungen (bleiben erhalten, auch wenn der Status neu geladen wird) */
  form: null,
};

const now = () => Date.now() + state.clockOffset;
const fmtTime = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(hours ? 2 : 1, '0');
  return `${hours ? `${hours}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSeconds = (s) => (s < 60 ? `${s} s` : s % 60 ? `${Math.floor(s / 60)} Min. ${s % 60} s` : `${s / 60} Min.`);
const clock = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const ago = (ms) => {
  const min = Math.floor((now() - ms) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  return `vor ${Math.floor(min / 60)} Std. ${min % 60} Min.`;
};

// ============================================================ Laden

async function load(first = false) {
  try {
    const data = await api(`${BASE}/state`);
    state.clockOffset = data.now - Date.now();
    state.data = data;
  } catch (err) {
    if (first) toast(err.message, 'err');
    return;
  }
  if (first || !state.form) {
    state.form = structuredClone(state.data.settings);
    renderSettings();
    renderLengths();
  }
  renderStatus();
}

// ============================================================ Live-Status

function show(el, visible) {
  el.hidden = !visible;
  return el;
}

function renderStatus() {
  const d = state.data;
  if (!d) return;
  const s = d.schedule;
  const t = now();
  const running = d.running && d.running.endsAt > t ? d.running : null;

  // Kopf: live / offline / nicht eingeloggt
  const badge = $('#live-badge');
  if (!d.loggedIn) {
    badge.className = 'badge warn';
    badge.textContent = '🔒 Nicht eingeloggt';
  } else if (d.live === null) {
    badge.className = 'badge';
    badge.textContent = '⏳ Live-Status wird geladen…';
  } else if (d.live) {
    badge.className = 'badge live';
    badge.textContent = '🔴 Live';
  } else {
    badge.className = 'badge';
    badge.textContent = '⚫ Offline';
  }
  const typeBadge = $('#type-badge');
  show(typeBadge, d.broadcasterType === 'affiliate' || d.broadcasterType === 'partner');
  typeBadge.className = 'badge accent';
  typeBadge.textContent = d.broadcasterType === 'partner' ? '✔ Partner' : '✔ Affiliate';

  // Hinweise
  let note = '';
  if (!d.loggedIn) note = 'Verbinde dich zuerst in der Übersicht mit Twitch.';
  else if (d.broadcasterType === '') note = 'Werbepausen gibt es nur für Twitch-Affiliates und -Partner. Dein Kanal ist (noch) keins von beiden.';
  else if (d.live === false) note = 'Der Werbe-Zeitplan wird nur abgefragt, während du live bist. Sobald du live gehst, geht es automatisch los.';
  $('#status-note').textContent = note;
  show($('#status-note'), !!note);
  $('#status-error').textContent = d.scheduleError ?? '';
  show($('#status-error'), !!d.scheduleError);

  // Große Anzeige
  const box = $('#next-box');
  box.classList.remove('soon', 'running', 'off');
  if (running) {
    box.classList.add('running');
    $('#next-label').textContent = '📺 Werbung läuft – noch';
    $('#next-time').textContent = fmtTime(running.endsAt - t);
    $('#next-at').textContent = `${running.durationSeconds} Sekunden, ${running.automatic ? 'automatisch' : 'von Hand gestartet'}${running.test ? ' (Test)' : ''}`;
  } else if (d.live && s?.nextAdAt) {
    const left = s.nextAdAt - t;
    if (left < 2 * 60_000) box.classList.add('soon');
    $('#next-label').textContent = 'Nächste Werbung in';
    $('#next-time').textContent = left > 0 ? fmtTime(left) : 'jetzt';
    $('#next-at').textContent = `um ${clock(s.nextAdAt)} Uhr`;
  } else {
    box.classList.add('off');
    $('#next-label').textContent = 'Nächste Werbung';
    $('#next-time').textContent = '–:––';
    $('#next-at').textContent = d.live && s ? 'Gerade ist keine Werbung geplant.' : '';
  }

  // Zahlen
  $('#st-duration').textContent = s?.duration ? fmtSeconds(s.duration) : '–';
  $('#st-preroll').textContent = s ? (s.prerollFreeTime ? fmtSeconds(s.prerollFreeTime) : 'keine') : '–';
  $('#st-snoozes').textContent = s ? String(s.snoozeCount) : '–';
  $('#st-snooze-refresh').textContent = s?.snoozeRefreshAt && s.snoozeRefreshAt > t ? `+1 in ${fmtTime(s.snoozeRefreshAt - t)}` : '';
  $('#st-last').textContent = s?.lastAdAt ? ago(s.lastAdAt) : '–';

  // Knöpfe
  const canAct = d.loggedIn && d.live !== false;
  $('#snooze').disabled = !canAct || !s?.nextAdAt || s.snoozeCount < 1;
  $('#snooze').title = s && s.snoozeCount < 1
    ? 'Keine Verschiebungen mehr übrig – Twitch gibt dir nach und nach neue.'
    : 'Die nächste geplante Werbung um 5 Minuten nach hinten schieben';
  $('#commercial').disabled = !canAct || !!running;
}

function renderLengths() {
  const select = $('#commercial-length');
  const lengths = state.data.commercialLengths ?? [30, 60, 90, 120, 150, 180];
  const current = Number(select.value) || 60;
  select.replaceChildren(...lengths.map((l) => h('option', { value: l, selected: l === current }, fmtSeconds(l))));
}

async function snooze() {
  $('#snooze').disabled = true;
  try {
    state.data = await api(`${BASE}/snooze`, {});
    toast('Werbung um 5 Minuten verschoben', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  renderStatus();
}

async function startCommercial() {
  const length = Number($('#commercial-length').value);
  if (!confirm(`Jetzt ${fmtSeconds(length)} Werbung starten? Deine Zuschauer sehen dann sofort Werbung.`)) return;
  $('#commercial').disabled = true;
  try {
    const res = await api(`${BASE}/commercial`, { length });
    toast(`Werbung gestartet (${fmtSeconds(res.length)})`, 'ok');
    setTimeout(() => load(), 3000);
  } catch (err) {
    toast(err.message, 'err');
  }
  renderStatus();
}

async function refresh() {
  try {
    state.data = await api(`${BASE}/refresh`, {});
    state.clockOffset = state.data.now - Date.now();
    toast('Aktualisiert', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  renderStatus();
}

// ============================================================ Einstellungen

const field = (label, ...control) => h('div', { class: 'field' }, h('label', {}, label), ...control);
const opt = (checked, onchange, text) => h('div', { class: 'opt-row' }, toggle(checked, onchange, text), h('span', {}, text));

/** Textfeld für eine Chat-Nachricht mit Variablen-Chips und Vorschau */
function templateEditor(value, vars, onchange) {
  const textarea = h('textarea', { rows: 2, maxlength: 500, oninput: (e) => onchange(e.target.value) }, value);
  textarea.value = value;
  const chips = h('div', { class: 'chips' },
    ...vars.map(([token, desc]) => h('button', {
      class: 'chip', title: desc, type: 'button',
      onclick: () => {
        const pos = textarea.selectionStart ?? textarea.value.length;
        textarea.value = textarea.value.slice(0, pos) + token + textarea.value.slice(textarea.selectionEnd ?? pos);
        onchange(textarea.value);
        textarea.focus();
      },
    }, token)),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn small', type: 'button', title: 'Zeigt, wie die Nachricht aussehen würde (mit Beispielwerten, sendet nichts)',
      onclick: async () => {
        try {
          const res = await api(`${BASE}/preview`, { message: textarea.value });
          toast(res.text || '(leer)');
        } catch (err) {
          toast(err.message, 'err');
        }
      },
    }, '👁 Vorschau'));
  return [textarea, chips];
}

function renderWarnings() {
  const list = $('#warnings');
  const warnings = state.form.warnings;
  $('#add-warning').disabled = warnings.length >= 5;
  if (!warnings.length) {
    list.replaceChildren(h('div', { class: 'w-empty' }, 'Keine Vorwarnungen – die Werbung kommt ohne Ankündigung.'));
    return;
  }
  list.replaceChildren(...warnings.map((w) => {
    // Vorlaufzeit als Zahl + Einheit (Minuten ab 2 Minuten, wenn es glatt aufgeht)
    const inMinutes = w.seconds >= 120 && w.seconds % 60 === 0;
    const amount = h('input', { type: 'number', min: 1, max: inMinutes ? 30 : 1800, value: inMinutes ? w.seconds / 60 : w.seconds });
    const unit = h('select', {},
      h('option', { value: 1, selected: !inMinutes }, 'Sekunden'),
      h('option', { value: 60, selected: inMinutes }, 'Minuten'));
    const update = () => { w.seconds = Math.round(Number(amount.value) * Number(unit.value)) || 0; };
    amount.oninput = update;
    unit.onchange = update;

    return h('div', { class: 'w-item' },
      h('div', { class: 'w-head' },
        amount, unit, h('b', {}, 'vor der Werbung'),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'icon-btn', title: 'Vorwarnung entfernen', type: 'button',
          onclick: () => {
            state.form.warnings = state.form.warnings.filter((x) => x !== w);
            renderWarnings();
          },
        }, '🗑')),
      h('div', { class: 'w-opts' },
        opt(w.chat, (on) => { w.chat = on; }, 'Nachricht im Chat'),
        opt(w.overlay, (on) => { w.overlay = on; }, 'Banner im Overlay')),
      ...templateEditor(w.message, WARNING_VARS, (v) => { w.message = v; }));
  }));
}

function renderAnnouncements() {
  const { start, end } = state.form;
  $('#announcements').replaceChildren(
    h('div', { class: 'a-item' },
      h('b', {}, '📺 Wenn die Werbung startet'),
      h('div', { class: 'w-opts' },
        opt(start.chat, (on) => { start.chat = on; }, 'Nachricht im Chat'),
        opt(start.overlay, (on) => { start.overlay = on; }, 'Countdown im Overlay')),
      ...templateEditor(start.message, START_VARS, (v) => { start.message = v; })),
    h('div', { class: 'a-item' },
      h('b', {}, '👋 Wenn die Werbung vorbei ist'),
      h('div', { class: 'w-opts' },
        opt(end.chat, (on) => { end.chat = on; }, 'Nachricht im Chat'),
        opt(end.overlay, (on) => { end.overlay = on; }, '„Zurück“ im Overlay')),
      ...templateEditor(end.message, END_VARS, (v) => { end.message = v; })));
}

function renderOverlaySettings() {
  const o = state.form.overlay;
  const input = (key, attrs) => h('input', { ...attrs, value: o[key], oninput: (e) => { o[key] = attrs.type === 'number' ? Number(e.target.value) : e.target.value; } });

  const grid = h('div', { class: 'pos-grid' });
  const drawGrid = () => grid.replaceChildren(...POSITIONS.map(([value, label]) => (value
    ? h('button', { type: 'button', class: o.position === value ? 'on' : '', title: label, onclick: () => { o.position = value; drawGrid(); } }, label)
    : h('span', { class: 'none' }))));
  drawGrid();

  $('#overlay-settings').replaceChildren(
    field('Position', grid),
    h('div', { class: 'f-row3' },
      field('Akzent', input('accent', { type: 'color' })),
      field('Text', input('textColor', { type: 'color' })),
      field('Hintergrund', input('background', { type: 'color' }))),
    h('div', { class: 'f-row3' },
      field('Deckkraft (%)', input('backgroundOpacity', { type: 'number', min: 0, max: 100 })),
      field('Schrift (px)', input('fontSize', { type: 'number', min: 12, max: 80 })),
      field('Breite (px)', input('width', { type: 'number', min: 200, max: 1920 }))),
    field('Text vor der Werbung', input('warningTitle', { type: 'text', maxlength: 60 })),
    field('Text während der Werbung', input('runningTitle', { type: 'text', maxlength: 60 })),
    field('Text danach', input('backTitle', { type: 'text', maxlength: 60 })),
    h('div', { class: 'f-row' },
      field('Vorwarnung zeigen (s, 0 = bis zur Werbung)', input('warningDisplaySeconds', { type: 'number', min: 0, max: 1800 })),
      field('„Zurück“ zeigen (s)', input('backSeconds', { type: 'number', min: 1, max: 60 }))));
}

function renderSettings() {
  renderWarnings();
  renderAnnouncements();
  renderOverlaySettings();
}

/** Einen Teil der Einstellungen speichern, z.B. { warnings } */
async function save(part, andTest = false) {
  try {
    const settings = await api(`${BASE}/settings`, part);
    // Nur den gespeicherten Teil übernehmen, andere (noch nicht gespeicherte) Eingaben bleiben
    for (const key of Object.keys(part)) state.form[key] = structuredClone(settings[key]);
    state.data.settings = settings;
    if (andTest) {
      await api(`${BASE}/overlay/test`, {});
      toast('Gespeichert – Test läuft im Overlay (nicht im Chat)', 'ok');
    } else {
      toast('Gespeichert', 'ok');
    }
    renderSettings();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================ Start

(async () => {
  const url = `${location.origin}/addons/ads/overlay.html`;
  $('#overlay-url').value = url;
  $('#copy-url').onclick = async () => {
    await navigator.clipboard.writeText(url).catch(() => {});
    toast('Link kopiert', 'ok');
  };
  $('#overlay-test').onclick = async () => {
    try {
      await api(`${BASE}/overlay/test`, {});
      toast('Test läuft im Overlay (nur dort, nicht im Chat)', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#refresh').onclick = refresh;
  $('#snooze').onclick = snooze;
  $('#commercial').onclick = startCommercial;
  $('#add-warning').onclick = () => {
    if (state.form.warnings.length >= 5) return;
    const used = new Set(state.form.warnings.map((w) => w.seconds));
    const seconds = [300, 120, 60, 30].find((s) => !used.has(s)) ?? 90;
    state.form.warnings.push({
      seconds, chat: true, overlay: false,
      message: 'Achtung: In {time} kommt Werbung. Kurz Wasser holen! 💧',
    });
    state.form.warnings.sort((a, b) => b.seconds - a.seconds);
    renderWarnings();
  };
  $('#save-warnings').onclick = () => save({ warnings: state.form.warnings });
  $('#save-announcements').onclick = () => save({ start: state.form.start, end: state.form.end });
  $('#save-overlay').onclick = () => save({ overlay: state.form.overlay });
  $('#save-overlay-test').onclick = () => save({ overlay: state.form.overlay }, true);

  await load(true);
  // Countdown jede Sekunde, Daten von der Suite alle 5 Sekunden
  let ticks = 0;
  setInterval(() => {
    ticks++;
    if (ticks % 5 === 0) void load();
    else renderStatus();
  }, 1000);
})();
