const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/predictions';

const ROLES = [
  ['everyone', 'Alle'],
  ['subscriber', 'Subs'],
  ['vip', 'VIPs'],
  ['moderator', 'Mods'],
  ['broadcaster', 'Nur du'],
];
const DURATIONS = [[30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min'], [1800, '30 min']];
/** Schnell-Antworten fürs Formular */
const QUICK = [['Ja', 'Nein'], ['Schaff ich', 'Schaff ich nicht'], ['Sieg', 'Niederlage']];

const state = {
  data: null,
  /** Was gerade angezeigt wird: 'form' oder die ID der laufenden Vorhersage */
  shown: null,
  /** Eingaben im Formular (bleiben erhalten, auch wenn neu geladen wird) */
  form: null,
  /** Unterschied zwischen Uhr der Suite und diesem Fenster */
  clockOffset: 0,
  /** Gerade läuft eine Aktion (Doppelklicks vermeiden) */
  busy: false,
};

const now = () => Date.now() + state.clockOffset;
const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);
const num = (n) => Number(n || 0).toLocaleString('de-DE');
const fmtTime = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const roleLabel = (r) => ROLES.find(([v]) => v === r)?.[1] ?? r;
/** Auszahlung wie bei Twitch: 1:2,5 = für 1 Punkt gibt es 2,5 zurück */
const ratio = (points, total) => (points ? `1:${(total / points).toLocaleString('de-DE', { maximumFractionDigits: 2 })}` : '–');
/** Twitch: bei 2 Antworten blau/pink, bei mehr alle blau */
const colorClass = (o) => (String(o.color).toLowerCase() === 'pink' ? 'pink' : '');

// ============================================================ Laden

async function load() {
  try {
    const data = await api(`${BASE}/state`);
    state.clockOffset = data.now - Date.now();
    state.data = data;
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  if (!state.form) resetForm();
  applyColors();
  render();
}

function resetForm(from) {
  state.form = {
    title: from?.title ?? '',
    outcomes: from ? from.outcomes.map((o) => o.title) : ['', ''],
    windowSeconds: from?.windowSeconds ?? state.data.settings.defaults.windowSeconds,
  };
}

/** Farben aus den Overlay-Einstellungen auch hier benutzen */
function applyColors() {
  const o = state.data.settings.overlay;
  document.documentElement.style.setProperty('--blue', o.blue);
  document.documentElement.style.setProperty('--pink', o.pink);
}

/** Darf dieser Kanal Vorhersagen starten? (null = unbekannt → ausprobieren lassen) */
const canPredict = () => state.data.broadcasterType !== '';

// ============================================================ Aktuelle Vorhersage / Formular

function render() {
  if (!state.data) return;
  const active = state.data.active;
  const key = active ? active.id : 'form';
  if (key !== state.shown) {
    state.shown = key;
    if (active) renderLive(); else renderForm();
  } else if (active) {
    renderLive();
  }
  renderHistory();
  renderHelp();
}

function renderForm() {
  const f = state.form;
  const limits = state.data.limits;
  const box = $('#current');

  const counter = (value, max) => h('div', { class: `counter${value.length > max ? ' over' : ''}` }, `${value.length}/${max}`);
  const updateCounter = (el, value, max) => {
    el.textContent = `${value.length}/${max}`;
    el.className = `counter${value.length > max ? ' over' : ''}`;
  };

  const title = h('input', { type: 'text', value: f.title, placeholder: 'z.B. Schaffe ich den Boss beim ersten Versuch?' });
  const titleCounter = counter(f.title, limits.title);
  title.oninput = () => {
    f.title = title.value;
    updateCounter(titleCounter, f.title, limits.title);
  };

  // Twitch: bei genau 2 Antworten blau + pink, sonst alle blau
  const outcomeRows = f.outcomes.map((value, i) => {
    const input = h('input', { type: 'text', value, placeholder: `Antwort ${i + 1}` });
    const c = counter(value, limits.outcome);
    input.oninput = () => {
      f.outcomes[i] = input.value;
      updateCounter(c, input.value, limits.outcome);
    };
    input.onkeydown = (e) => {
      // Enter in der letzten Zeile = neue Antwort
      if (e.key === 'Enter' && i === f.outcomes.length - 1 && f.outcomes.length < limits.outcomes) {
        f.outcomes.push('');
        renderForm();
        [...document.querySelectorAll('.outcome-row input')].at(-1)?.focus();
      }
    };
    return h('div', { class: 'outcome-row' },
      h('span', { class: `outcome-num${f.outcomes.length === 2 && i === 1 ? ' pink' : ''}` }, `${i + 1}`),
      input,
      c,
      h('button', {
        class: 'icon-btn', title: 'Entfernen', disabled: f.outcomes.length <= 2,
        onclick: () => { f.outcomes.splice(i, 1); renderForm(); },
      }, '✕'));
  });

  const custom = h('input', { type: 'number', min: limits.minSeconds, max: limits.maxSeconds, value: f.windowSeconds, title: 'Sekunden' });
  custom.onchange = () => { f.windowSeconds = Number(custom.value); renderForm(); };

  box.replaceChildren(...[
    h('h2', {}, '＋ Neue Vorhersage'),
    h('p', { class: 'note' }, `Zuschauer setzen Kanalpunkte auf eine Antwort. Max. ${limits.title} Zeichen für die Frage, ${limits.outcomes} Antworten mit je ${limits.outcome} Zeichen, Tipp-Zeit 30 s bis 30 min.`),
    !canPredict() ? h('p', { class: 'warn-note' }, 'Vorhersagen gibt es bei Twitch erst ab Affiliate. Sobald du Affiliate bist, geht es hier los.') : null,
    h('div', { class: 'field' }, h('label', {}, 'Frage'), title, titleCounter),
    h('div', { class: 'field' },
      h('label', {}, 'Antworten'),
      h('div', { class: 'outcomes' }, ...outcomeRows),
      h('div', { class: 'presets' },
        f.outcomes.length < limits.outcomes
          ? h('button', { class: 'btn small', onclick: () => { f.outcomes.push(''); renderForm(); } }, '＋ Antwort')
          : null,
        h('span', { class: 'note' }, 'Schnell:'),
        ...QUICK.map((pair) => h('button', {
          class: 'btn small',
          onclick: () => { f.outcomes = [...pair]; renderForm(); },
        }, pair.join(' / ')))),
      f.outcomes.length > 2 ? h('p', { class: 'note' }, 'Bei mehr als zwei Antworten färbt Twitch alle blau.') : null),
    h('div', { class: 'field' },
      h('label', {}, 'Tipp-Zeit (danach wird automatisch gesperrt)'),
      h('div', { class: 'presets' },
        ...DURATIONS.map(([s, l]) =>
          h('button', { class: `btn small${f.windowSeconds === s ? ' on' : ''}`, onclick: () => { f.windowSeconds = s; renderForm(); } }, l)),
        custom, h('span', { class: 'note' }, 'Sekunden'))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', disabled: !canPredict(), onclick: startPrediction }, '🔮 Vorhersage starten'),
      h('button', { class: 'btn', onclick: () => { resetForm(); renderForm(); } }, 'Leeren')),
  ].filter(Boolean));
}

async function startPrediction() {
  if (state.busy) return;
  const f = state.form;
  const payload = { title: f.title.trim(), outcomes: f.outcomes.map((o) => o.trim()).filter(Boolean), windowSeconds: f.windowSeconds };
  state.busy = true;
  try {
    await api(`${BASE}/start`, payload);
    // Zuletzt benutzte Tipp-Zeit als Standard merken
    await api(`${BASE}/settings`, { defaults: { windowSeconds: f.windowSeconds } }).catch(() => {});
    toast('Vorhersage läuft!', 'ok');
    state.form = null;
    await load();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    state.busy = false;
  }
}

function renderLive() {
  const p = state.data.active;
  const locked = p.status === 'locked';
  const left = p.locksAt - now();
  const span = Math.max(1, p.locksAt - p.startedAt);
  const maxPoints = Math.max(0, ...p.outcomes.map((o) => o.channelPoints));
  const box = $('#current');

  box.replaceChildren(...[
    h('div', { class: 'live-head' },
      locked ? h('span', { class: 'badge warn' }, '🔒 GESPERRT') : h('span', { class: 'badge ok' }, '● LÄUFT'),
      p.test ? h('span', { class: 'badge accent', title: 'Nur in der Suite und im Overlay – nicht bei Twitch' }, 'Test') : null,
      p.external ? h('span', { class: 'badge accent', title: 'Direkt bei Twitch gestartet' }, 'von Twitch') : null,
      p.startedBy && !p.external && !p.test && p.startedBy !== 'Dashboard' ? h('span', { class: 'badge' }, `gestartet von ${p.startedBy}`) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'time-left', title: locked ? '' : 'Zeit bis zur Sperre' }, locked ? 'wartet auf Gewinner' : left > 0 ? fmtTime(left) : 'sperrt…')),
    h('div', { class: 'live-title no-i18n' }, p.title),
    locked ? null : h('div', { class: 'progress' }, h('div', { style: { width: `${Math.max(0, Math.min(100, (left / span) * 100))}%` } })),
    h('div', { class: 'bars' }, ...p.outcomes.map((o, i) =>
      h('div', { class: `bar ${colorClass(o)}${o.channelPoints === maxPoints && maxPoints > 0 ? ' lead' : ''}` },
        h('div', { class: 'bar-fill', style: { width: `${pct(o.channelPoints, p.totalPoints)}%` } }),
        h('div', { class: 'bar-content' },
          h('span', { class: 'outcome-num' }, `${i + 1}`),
          h('span', { class: 'bar-label no-i18n' }, o.title),
          h('span', { class: 'bar-stats' },
            h('span', { title: 'Tipper' }, `👥 ${num(o.users)}`),
            h('span', { title: 'Gesetzte Kanalpunkte' }, `🪙 ${num(o.channelPoints)}`),
            h('span', { title: 'Auszahlung' }, ratio(o.channelPoints, p.totalPoints))),
          h('span', { class: 'bar-pct' }, `${pct(o.channelPoints, p.totalPoints)}%`),
          h('button', { class: 'btn small', title: 'Diese Antwort gewinnt – Punkte werden verteilt', onclick: () => resolvePrediction(i) }, '🏆 Gewinner'))))),
    h('div', { class: 'totals' },
      h('span', {}, h('b', {}, num(p.totalUsers)), ' Tipper'),
      h('span', {}, h('b', {}, num(p.totalPoints)), ' Kanalpunkte gesetzt')),
    locked
      ? h('p', { class: 'note' }, 'Keine Tipps mehr möglich. Sobald das Ergebnis feststeht: bei der richtigen Antwort auf „🏆 Gewinner“ klicken.')
      : h('p', { class: 'note' }, 'Nach Ablauf der Zeit sperrt Twitch automatisch. Du kannst auch früher sperren oder direkt den Gewinner wählen.'),
    h('div', { class: 'btn-row' },
      locked ? null : h('button', { class: 'btn primary', onclick: lockPrediction }, '🔒 Jetzt sperren'),
      h('button', { class: 'btn', onclick: cancelPrediction }, '✕ Abbrechen (Punkte zurück)')),
  ].filter(Boolean));
}

/** Aktion ausführen, Fehler als Toast, danach neu laden */
async function action(path, body, okText) {
  if (state.busy) return;
  state.busy = true;
  try {
    await api(`${BASE}/${path}`, body);
    toast(okText, 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    state.busy = false;
  }
}

const lockPrediction = () => action('lock', {}, 'Gesperrt – jetzt kann niemand mehr tippen');

function resolvePrediction(index) {
  const o = state.data.active.outcomes[index];
  if (!confirm(`„${o.title}“ gewinnt?\n\nDie Kanalpunkte werden an alle verteilt, die darauf getippt haben. Das lässt sich nicht rückgängig machen.`)) return;
  return action('resolve', { index }, `🏆 „${o.title}“ gewinnt!`);
}

function cancelPrediction() {
  if (!confirm('Vorhersage abbrechen?\n\nAlle bekommen ihre Kanalpunkte zurück, es gibt keinen Gewinner.')) return;
  return action('cancel', {}, 'Vorhersage abgebrochen – Punkte gehen zurück');
}

// ============================================================ Verlauf

function renderHistory() {
  const list = state.data.history;
  const box = $('#history');
  const key = JSON.stringify(list.map((r) => r.id));
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'Noch keine Vorhersagen.'));
    return;
  }
  box.replaceChildren(
    h('div', { class: 'hist' }, ...list.map((r) =>
      h('div', { class: 'h-item' },
        h('div', { class: 'h-main' },
          h('div', { class: 'h-title no-i18n' }, r.title),
          h('div', { class: 'h-meta' },
            h('span', {}, new Date(r.startedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })),
            r.status === 'canceled'
              ? h('span', { class: 'badge warn' }, 'abgebrochen')
              : h('span', { class: 'badge ok no-i18n' }, `🏆 ${r.outcomes[r.winner]?.title ?? '?'}`),
            h('span', {}, `${num(r.totalUsers)} Tipper · ${num(r.totalPoints)} Kanalpunkte`)),
          h('div', { class: 'mini-bars' }, ...r.outcomes.map((o, i) =>
            h('div', { class: `mini ${colorClass(o)}${r.winner === i ? ' win' : ''}` },
              h('span', { class: 'no-i18n' }, `${r.winner === i ? '🏆 ' : ''}${o.title}`),
              h('div', { class: 'track' }, h('div', { style: { width: `${pct(o.channelPoints, r.totalPoints)}%` } })),
              h('span', {}, `${pct(o.channelPoints, r.totalPoints)}%`))))),
        h('div', { class: 'h-actions' },
          h('button', {
            class: 'icon-btn', title: 'Nochmal (ins Formular übernehmen)',
            onclick: () => {
              if (state.data.active && !state.data.active.test) return toast('Es läuft gerade eine Vorhersage.', 'err');
              resetForm(r);
              state.shown = null;
              render();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            },
          }, '↻'),
          h('button', {
            class: 'icon-btn', title: 'Löschen',
            onclick: async () => {
              await api(`${BASE}/history/delete`, { id: r.id }).catch((err) => toast(err.message, 'err'));
              await load();
            },
          }, '🗑')))),
    ),
    h('button', {
      class: 'btn small', style: { alignSelf: 'flex-start' },
      onclick: async () => {
        if (!confirm('Alle gespeicherten Vorhersagen aus dem Verlauf löschen?')) return;
        await api(`${BASE}/history/clear`, {}).catch((err) => toast(err.message, 'err'));
        await load();
      },
    }, 'Verlauf leeren'),
  );
}

// ============================================================ Hilfe

function renderHelp() {
  const m = state.data.settings.modCommands;
  const box = $('#chat-help');
  const key = JSON.stringify(m);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (!m.enabled) {
    box.replaceChildren(h('div', { class: 'note' }, 'Vorhersagen per Chat steuern ist aus (Einstellungen → Mod-Commands).'));
    return;
  }
  box.replaceChildren(
    h('div', {}, h('b', {}, `${roleLabel(m.permission)}: `), h('code', {}, `!${m.startCommand} 120 Frage | Antwort 1 | Antwort 2`)),
    h('div', { class: 'note' }, 'Die Zahl vorne (Tipp-Zeit in Sekunden, oder z.B. 5m) ist optional.'),
    h('div', {}, h('code', {}, `!${m.lockCommand}`), ' sperrt die Tipps.'),
    h('div', {}, h('code', {}, `!${m.resolveCommand} 1`), ' – Antwort 1 gewinnt (der Text der Antwort geht auch).'),
    h('div', {}, h('code', {}, `!${m.cancelCommand}`), ' bricht ab, alle bekommen ihre Punkte zurück.'),
  );
}

// ============================================================ Einstellungen

function modal(title, tabs, footer) {
  const host = $('#modal-host');
  const close = () => host.replaceChildren();
  let current = 0;
  const body = h('div', { class: 'modal-body' });
  const tabBar = h('div', { class: 'tabs' });
  const show = (i) => {
    current = i;
    tabBar.replaceChildren(...tabs.map((t, j) => h('button', { class: j === current ? 'on' : '', onclick: () => show(j) }, t.title)));
    body.replaceChildren(...tabs[current].content.filter(Boolean));
  };
  show(0);
  host.replaceChildren(h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Schließen', onclick: close }, '✕')),
      tabBar,
      body,
      h('div', { class: 'modal-foot' }, ...footer(close)))));
  return close;
}

const field = (label, ...controls) => h('div', { class: 'field' }, h('label', {}, label), ...controls);
const textArea = (value) => {
  const t = h('textarea', { rows: 2, maxlength: 500 });
  t.value = value;
  return t;
};
const withChips = (textarea, vars) => [textarea, h('div', { class: 'chips' }, ...vars.map(([token, desc]) =>
  h('button', {
    class: 'chip', title: desc,
    onclick: () => {
      const pos = textarea.selectionStart ?? textarea.value.length;
      textarea.value = textarea.value.slice(0, pos) + token + textarea.value.slice(textarea.selectionEnd ?? pos);
      textarea.focus();
    },
  }, token)))];

const BASE_VARS = [['{title}', 'Die Frage'], ['{outcomes}', '1) A · 2) B …'], ['{users}', 'Tipper insgesamt'], ['{points}', 'Kanalpunkte insgesamt']];
const MESSAGE_KINDS = [
  ['start', 'Beim Start', [...BASE_VARS.slice(0, 2), ['{duration}', 'Tipp-Zeit']]],
  ['lock', 'Beim Sperren', BASE_VARS],
  ['result', 'Beim Ergebnis', [...BASE_VARS, ['{winner}', 'Gewinner-Antwort'], ['{winnerusers}', 'Tipper auf den Gewinner'], ['{winnerpoints}', 'Punkte auf den Gewinner'], ['{percent}', 'Anteil der Punkte auf den Gewinner'], ['{results}', 'Alle: A 60% · B 40%']]],
  ['cancel', 'Beim Abbrechen', BASE_VARS.slice(0, 2)],
];

function openSettings() {
  const s = structuredClone(state.data.settings);
  const m = s.modCommands;
  const o = s.overlay;

  const texts = {};
  const messageBlocks = MESSAGE_KINDS.map(([kind, label, vars]) => {
    const msg = s.messages[kind];
    texts[kind] = textArea(msg.text);
    return h('div', { class: 'msg-block' },
      h('div', { class: 'opt-row' }, toggle(msg.enabled, (on) => { msg.enabled = on; }, label), h('span', {}, h('b', {}, label))),
      ...withChips(texts[kind], vars));
  });

  const cmdInput = (value) => h('input', { type: 'text', value, maxlength: 30 });
  const startCmd = cmdInput(m.startCommand);
  const lockCmd = cmdInput(m.lockCommand);
  const resolveCmd = cmdInput(m.resolveCommand);
  const cancelCmd = cmdInput(m.cancelCommand);
  const modRole = h('select', {}, ...ROLES.map(([v, l]) => h('option', { value: v, selected: v === m.permission }, l)));

  const color = (value) => h('input', { type: 'color', value });
  const numInput = (value, min, max) => h('input', { type: 'number', min, max, value });
  const blue = color(o.blue);
  const pink = color(o.pink);
  const textColor = color(o.textColor);
  const bg = color(o.background);
  const bgOpacity = numInput(o.backgroundOpacity, 0, 100);
  const fontSize = numInput(o.fontSize, 12, 60);
  const width = numInput(o.width, 250, 1920);
  const resultSec = numInput(o.showResultSeconds, 0, 300);

  const collect = () => ({
    messages: Object.fromEntries(MESSAGE_KINDS.map(([kind]) => [kind, { enabled: s.messages[kind].enabled, text: texts[kind].value }])),
    modCommands: {
      enabled: m.enabled, startCommand: startCmd.value, lockCommand: lockCmd.value,
      resolveCommand: resolveCmd.value, cancelCommand: cancelCmd.value, permission: modRole.value,
    },
    overlay: {
      blue: blue.value, pink: pink.value, textColor: textColor.value, background: bg.value,
      backgroundOpacity: Number(bgOpacity.value), fontSize: Number(fontSize.value), width: Number(width.value),
      showResultSeconds: Number(resultSec.value), showStats: o.showStats, showTimer: o.showTimer,
    },
  });

  const save = async (close, andTest) => {
    try {
      const settings = await api(`${BASE}/settings`, collect());
      state.data.settings = settings;
      applyColors();
      if (andTest) await api(`${BASE}/overlay/test`, {});
      else {
        toast('Gespeichert', 'ok');
        close();
      }
      state.shown = null;
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const opt = (checked, onchange, text) => h('div', { class: 'opt-row' }, toggle(checked, onchange, text), h('span', {}, text));

  modal('⚙ Vorhersagen-Einstellungen', [
    {
      title: '💬 Nachrichten',
      content: [
        h('p', { class: 'note' }, 'Die Nachrichten schreibt dein Bot (falls verknüpft). Jede lässt sich einzeln ausschalten. Test-Vorhersagen schreiben nie in den Chat.'),
        ...messageBlocks,
      ],
    },
    {
      title: '🛡 Mod-Commands',
      content: [
        opt(m.enabled, (on) => { m.enabled = on; }, 'Vorhersagen per Chat steuern'),
        h('div', { class: 'f-row' }, field('Starten', startCmd), field('Sperren', lockCmd)),
        h('div', { class: 'f-row' }, field('Gewinner wählen', resolveCmd), field('Abbrechen', cancelCmd)),
        field('Wer darf das?', modRole),
        h('p', { class: 'note' }, 'Beispiel: !predict 2m Schaffe ich den Boss? | Ja | Nein – danach !resolve 1 oder !resolve Ja'),
      ],
    },
    {
      title: '🎥 Overlay',
      content: [
        h('div', { class: 'f-row' }, field('Farbe Antwort 1 (Twitch: blau)', blue), field('Farbe Antwort 2 (Twitch: pink)', pink)),
        h('p', { class: 'note' }, 'Bei mehr als zwei Antworten nimmt Twitch für alle die erste Farbe.'),
        h('div', { class: 'f-row' }, field('Textfarbe', textColor), field('Hintergrund', bg)),
        h('div', { class: 'f-row3' }, field('Deckkraft Hintergrund (%)', bgOpacity), field('Schriftgröße (px)', fontSize), field('Breite (px)', width)),
        field('Ergebnis so lange zeigen (Sekunden)', resultSec),
        opt(o.showStats, (on) => { o.showStats = on; }, 'Tipper und Kanalpunkte pro Antwort zeigen'),
        opt(o.showTimer, (on) => { o.showTimer = on; }, 'Restzeit bis zur Sperre zeigen'),
      ],
    },
  ], (close) => [
    h('button', { class: 'btn', onclick: () => save(close, true) }, '▶ Speichern & Overlay testen'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: close }, 'Abbrechen'),
    h('button', { class: 'btn primary', onclick: () => save(close, false) }, 'Speichern'),
  ]);
}

// ============================================================ Start

(async () => {
  const url = `${location.origin}/addons/predictions/overlay.html`;
  $('#overlay-url').value = url;
  $('#copy-url').onclick = async () => {
    await navigator.clipboard.writeText(url).catch(() => {});
    toast('Link kopiert', 'ok');
  };
  $('#overlay-test').onclick = async () => {
    try {
      await api(`${BASE}/overlay/test`, {});
      toast('Beispiel-Vorhersage im Overlay (nur dort, nicht bei Twitch)', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#open-settings').onclick = openSettings;
  await load();
  // Läuft eine Vorhersage: jede Sekunde aktualisieren, sonst alle 5 Sekunden
  let ticks = 0;
  setInterval(() => {
    ticks++;
    if ($('#modal-host').childElementCount || state.busy) return;
    if (state.data?.active || ticks % 5 === 0) void load();
  }, 1000);
})();
