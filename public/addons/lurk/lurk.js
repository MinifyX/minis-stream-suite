const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/lurk';

const state = { data: null, search: '', sort: 'totalMs', clockOffset: 0 };

/** Dauer wie im Chat: „1 Std. 5 Min.“ */
function fmt(ms) {
  const min = Math.floor(ms / 60_000);
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const mins = min % 60;
  const parts = [];
  if (days) parts.push(`${days} ${days === 1 ? 'Tag' : 'Tage'}`);
  if (hours) parts.push(`${hours} Std.`);
  if (mins || !parts.length) parts.push(`${mins} Min.`);
  return parts.join(' ');
}
const fmtDate = (t) => new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

async function call(path, body) {
  try {
    state.data = await api(`${BASE}${path}`, body);
    state.clockOffset = state.data.now - Date.now();
    render();
    return true;
  } catch (err) {
    toast(err.message, 'err');
    return false;
  }
}

const load = () => call('/state');

// ============================================================ Anzeigen

function render() {
  if (!state.data) return;
  renderToggle();
  renderActive();
  renderStats();
  renderHelp();
}

function renderToggle() {
  const on = state.data.settings.enabled;
  const box = $('#enabled-toggle');
  if (box.dataset.on === String(on)) return;
  box.dataset.on = String(on);
  box.replaceChildren(toggle(on, (v) => call('/settings', { enabled: v }), 'Lurk-System an/aus'), on ? 'An' : 'Aus');
}

function renderActive() {
  const list = state.data.active;
  const now = Date.now() + state.clockOffset;
  $('#end-all').hidden = list.length < 2;
  if (!list.length) {
    $('#active').replaceChildren(h('div', { class: 'empty' }, 'Gerade lurkt niemand.'));
    return;
  }
  $('#active').replaceChildren(h('div', { class: 'lurkers' }, ...list.map((l) =>
    h('div', { class: 'lurker' },
      h('div', { class: 'who' },
        h('div', { class: 'name' }, l.name),
        l.message ? h('div', { class: 'msg', title: l.message }, `„${l.message}“`) : h('div', { class: 'msg' }, `seit ${fmtDate(l.since)}`)),
      h('span', { class: 'since', title: `seit ${fmtDate(l.since)}` }, fmt(now - l.since)),
      h('button', { class: 'icon-btn', title: 'Beenden (zählt in die Statistik, ohne Chat-Nachricht)', onclick: () => call('/end', { id: l.id }) }, '⏹'),
      h('button', {
        class: 'icon-btn', title: 'Verwerfen (zählt nicht)',
        onclick: () => { if (confirm(`Lurk von ${l.name} verwerfen? Er zählt dann nicht in die Statistik.`)) call('/discard', { id: l.id }); },
      }, '🗑')))));
}

function renderStats() {
  const q = state.search.toLowerCase();
  const key = state.sort;
  const list = state.data.stats
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.login.includes(q))
    .sort((a, b) => b[key] - a[key]);
  const box = $('#stats');
  if (!state.data.stats.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'Noch keine Lurks gezählt.'));
    return;
  }
  box.replaceChildren(
    h('table', { class: 'stats' },
      h('thead', {}, h('tr', {},
        h('th', {}, '#'), h('th', {}, 'Name'), h('th', {}, 'Lurks'), h('th', {}, 'Gesamt'), h('th', {}, 'Längster'), h('th', {}, 'Zuletzt'), h('th', {}))),
      h('tbody', {}, ...list.slice(0, 200).map((s, i) =>
        h('tr', {},
          h('td', { class: 'rank' }, `${i + 1}.`),
          h('td', {}, h('b', {}, s.name)),
          h('td', { class: 'num' }, `${s.count}×`),
          h('td', { class: 'num' }, fmt(s.totalMs)),
          h('td', { class: 'num' }, fmt(s.longestMs)),
          h('td', { class: 'num' }, fmtDate(s.lastLurkAt)),
          h('td', { class: 'act' }, h('button', {
            class: 'icon-btn', title: 'Statistik dieses Zuschauers löschen',
            onclick: () => { if (confirm(`Lurk-Statistik von ${s.name} löschen?`)) call('/stats/delete', { id: s.id }); },
          }, '🗑')))))),
    h('div', { class: 'stats-foot' },
      h('span', { class: 'note' }, `${state.data.stats.length} Zuschauer · zusammen ${fmt(state.data.stats.reduce((sum, s) => sum + s.totalMs, 0))} gelurkt`),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn small',
        onclick: () => { if (confirm('Wirklich die GANZE Lurk-Statistik löschen?')) call('/stats/reset', {}); },
      }, 'Statistik zurücksetzen')));
}

function renderHelp() {
  const c = state.data.settings.commands;
  const box = $('#chat-help');
  const key = JSON.stringify(c);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...[
    h('div', {}, h('code', {}, `!${c.lurk} [Grund]`), ' – geht in den Lurk-Modus, z.B. ', h('code', {}, `!${c.lurk} bin kochen`)),
    h('div', {}, h('b', {}, 'Wieder da: '), 'passiert automatisch mit der nächsten Nachricht im Chat.',
      c.unlurk ? [' Oder ausdrücklich mit ', h('code', {}, `!${c.unlurk}`), '.'] : null),
    c.stats ? h('div', {}, h('code', {}, `!${c.stats}`), ' – eigene Lurk-Statistik, ', h('code', {}, `!${c.stats} @name`), ' – die von jemand anderem') : null,
    c.top ? h('div', {}, h('code', {}, `!${c.top}`), ' – die 5 fleißigsten Lurker') : null].filter(Boolean));
  void checkConflicts();
}

/** Gibt es im Commands-Addon einen Command mit gleichem Namen? Dann würden zwei Antworten kommen. */
async function checkConflicts() {
  const c = state.data.settings.commands;
  const names = [c.lurk, c.unlurk, c.stats, c.top].filter(Boolean);
  let clash = [];
  try {
    const cmds = await api('addons/commands/state');
    clash = cmds.settings.commands
      .filter((x) => x.enabled && [x.name, ...x.aliases].some((n) => names.includes(n)))
      .map((x) => `${cmds.settings.prefix}${x.name}`);
  } catch {
    // Commands-Addon ist aus → kein Konflikt
  }
  $('#conflict').replaceChildren(...(clash.length
    ? [h('div', { class: 'conflict' }, `⚠ Im Chat-Commands-Addon gibt es auch ${clash.join(', ')}. Dann antworten beide. Schalte den Command dort aus oder lösche ihn.`)]
    : []));
}

// ============================================================ Testen

async function runTest(message) {
  const text = (message ?? $('#test-message').value).trim();
  if (!text) return;
  const user = $('#test-user').value.trim() || 'TestUser';
  try {
    const r = await api(`${BASE}/test`, { user, message: text, minutesAgo: Number($('#test-minutes').value) });
    const log = $('#test-log');
    log.prepend(
      h('div', {},
        h('div', { class: 'in' }, h('b', {}, user), `: ${text}`),
        ...(r.replies.length ? r.replies.map((t) => h('div', { class: 'out' }, t)) : [h('div', { class: 'none' }, r.lurking ? '(lurkt weiter, keine Antwort)' : '(keine Antwort)')])));
    $('#test-message').value = '';
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderQuickTests() {
  const c = state.data.settings.commands;
  $('#test-quick').replaceChildren(...[
    h('button', { class: 'btn small', onclick: () => runTest(`!${c.lurk} bin kurz kochen`) }, `!${c.lurk}`),
    h('button', { class: 'btn small', onclick: () => runTest('Bin wieder da, was hab ich verpasst?') }, 'Wieder schreiben'),
    c.stats ? h('button', { class: 'btn small', onclick: () => runTest(`!${c.stats}`) }, `!${c.stats}`) : null,
    c.top ? h('button', { class: 'btn small', onclick: () => runTest(`!${c.top}`) }, `!${c.top}`) : null].filter(Boolean));
}

// ============================================================ Einstellungen

function openSettings() {
  const s = structuredClone(state.data.settings);
  const host = $('#modal-host');
  const close = () => host.replaceChildren();
  const input = (value, attrs = {}) => h('input', { type: 'text', value, ...attrs });
  const area = (value) => {
    const t = h('textarea', { rows: 2, maxlength: 500 });
    t.value = value;
    return t;
  };
  const field = (label, ...controls) => h('div', { class: 'field' }, h('label', {}, label), ...controls);
  const vars = (list) => h('div', { class: 'note' }, 'Variablen: ', list.map((v, i) => [i ? ', ' : '', h('code', {}, v)]));

  const cmd = {
    lurk: input(s.commands.lurk, { maxlength: 30 }),
    unlurk: input(s.commands.unlurk, { maxlength: 30, placeholder: '(aus)' }),
    stats: input(s.commands.stats, { maxlength: 30, placeholder: '(aus)' }),
    top: input(s.commands.top, { maxlength: 30, placeholder: '(aus)' }),
  };
  const msg = Object.fromEntries(Object.entries(s.messages).map(([k, v]) => [k, area(v)]));
  const backMin = h('input', { type: 'number', min: 0, max: 600, value: s.backMinMinutes });
  const maxHours = h('input', { type: 'number', min: 1, max: 48, value: s.maxLurkHours });
  const cooldown = h('input', { type: 'number', min: 0, max: 3600, value: s.statsCooldown });

  const save = async () => {
    const ok = await call('/settings', {
      commands: Object.fromEntries(Object.entries(cmd).map(([k, el]) => [k, el.value])),
      messages: Object.fromEntries(Object.entries(msg).map(([k, el]) => [k, el.value])),
      backMinMinutes: Number(backMin.value),
      endOnStreamEnd: s.endOnStreamEnd,
      maxLurkHours: Number(maxHours.value),
      statsCooldown: Number(cooldown.value),
    });
    if (ok) {
      toast('Gespeichert', 'ok');
      renderQuickTests();
      close();
    }
  };

  host.replaceChildren(h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, '⚙ Lurk-Einstellungen'), h('button', { class: 'icon-btn', onclick: close }, '✕')),
      h('div', { class: 'modal-body' },
        h('div', { class: 'sub' }, 'COMMANDS (OHNE !, LEER = AUS)'),
        h('div', { class: 'f-row' }, field('Lurk starten', cmd.lurk), field('Ausdrücklich zurück', cmd.unlurk)),
        h('div', { class: 'f-row' }, field('Eigene Statistik', cmd.stats), field('Bestenliste', cmd.top)),
        h('div', { class: 'sub' }, 'NACHRICHTEN (LEER = KEINE NACHRICHT)'),
        field('Lurk gestartet', msg.lurk), vars(['{user}', '{message}']),
        field('Lurkt schon (erneut !lurk)', msg.lurkAgain), vars(['{user}', '{duration}', '{message}']),
        field('Willkommen zurück', msg.back), vars(['{user}', '{duration}', '{message}']),
        field('Statistik', msg.stats), vars(['{user}', '{count}', '{total}', '{longest}', '{lurking}']),
        field('Statistik (noch nie gelurkt)', msg.statsNone), vars(['{user}']),
        field('Bestenliste', msg.top), vars(['{top}']),
        h('div', { class: 'sub' }, 'REGELN'),
        h('div', { class: 'f-row3' },
          field('„Willkommen zurück“ erst ab (Min.)', backMin),
          field('Lurk zählt höchstens (Std.)', maxHours),
          field('Abklingzeit Statistik (Sek.)', cooldown)),
        h('p', { class: 'note' }, 'Kürzere Lurks enden still (keine Nachricht), zählen aber trotzdem. Die Höchstdauer schützt die Statistik, falls die Suite beim Streamende aus war.'),
        h('div', { class: 'opt-row' },
          toggle(s.endOnStreamEnd, (on) => { s.endOnStreamEnd = on; }, 'Beim Streamende beenden'),
          h('span', {}, 'Beim Streamende alle Lurks still beenden'))),
      h('div', { class: 'modal-foot' },
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: close }, 'Abbrechen'),
        h('button', { class: 'btn primary', onclick: save }, 'Speichern')))));
}

// ============================================================ Start

(async () => {
  $('#open-settings').onclick = openSettings;
  $('#end-all').onclick = () => { if (confirm('Alle Lurks beenden? (zählt in die Statistik, ohne Chat-Nachricht)')) call('/end', { all: true }); };
  $('#search').oninput = (e) => { state.search = e.target.value; renderStats(); };
  $('#sort').onchange = (e) => { state.sort = e.target.value; renderStats(); };
  $('#test-run').onclick = () => runTest();
  $('#test-message').onkeydown = (e) => { if (e.key === 'Enter') runTest(); };
  await load();
  if (state.data) renderQuickTests();
  setInterval(() => {
    if ($('#modal-host').childElementCount) return;
    if (document.activeElement === $('#search')) return;
    void load();
  }, 5000);
})();
