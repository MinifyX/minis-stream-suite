const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/polls';

const ROLES = [
  ['everyone', 'Alle'],
  ['subscriber', 'Subs'],
  ['vip', 'VIPs'],
  ['moderator', 'Mods'],
  ['broadcaster', 'Nur du'],
];
const DURATIONS = [[30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min']];

const state = {
  data: null,
  /** Was gerade angezeigt wird: 'form' oder die ID der laufenden Umfrage */
  shown: null,
  /** Eingaben im Formular (bleiben erhalten, auch wenn neu geladen wird) */
  form: null,
  /** Unterschied zwischen Uhr der Suite und diesem Fenster */
  clockOffset: 0,
};

const now = () => Date.now() + state.clockOffset;
const pct = (votes, total) => (total ? Math.round((votes / total) * 100) : 0);
const fmtTime = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDuration = (s) => (s < 60 ? `${s} s` : s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`);
const roleLabel = (r) => ROLES.find(([v]) => v === r)?.[1] ?? r;

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
  render();
}

function resetForm(from) {
  const d = state.data.settings.defaults;
  state.form = {
    mode: from?.mode ?? d.mode,
    title: from?.title ?? '',
    choices: from ? from.choices.map((c) => c.title) : ['', ''],
    durationSeconds: from?.durationSeconds ?? d.durationSeconds,
    allowChange: from?.allowChange ?? d.allowChange,
    permission: from?.permission ?? d.permission,
    channelPoints: d.channelPoints,
    channelPointsPerVote: d.channelPointsPerVote,
  };
  if (state.form.mode === 'twitch' && !canTwitch()) state.form.mode = 'chat';
}

/** Darf dieser Kanal echte Twitch-Umfragen starten? (null = unbekannt → ausprobieren lassen) */
const canTwitch = () => state.data.broadcasterType !== '';

// ============================================================ Aktuelle Umfrage / Formular

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
  const limits = state.data.limits[f.mode];
  const box = $('#current');

  const modeBtn = (mode, label) => h('button', {
    class: f.mode === mode ? 'on' : '',
    disabled: mode === 'twitch' && !canTwitch(),
    title: mode === 'twitch' && !canTwitch() ? 'Twitch-Umfragen gibt es erst ab Affiliate' : '',
    onclick: () => { f.mode = mode; renderForm(); },
  }, label);

  const counter = (value, max) => h('div', { class: `counter${value.length > max ? ' over' : ''}` }, `${value.length}/${max}`);

  const title = h('input', { type: 'text', value: f.title, placeholder: 'z.B. Welches Spiel als Nächstes?' });
  const titleCounter = counter(f.title, limits.title);
  title.oninput = () => {
    f.title = title.value;
    titleCounter.textContent = `${f.title.length}/${limits.title}`;
    titleCounter.className = `counter${f.title.length > limits.title ? ' over' : ''}`;
  };

  const choiceRows = f.choices.map((value, i) => {
    const input = h('input', { type: 'text', value, placeholder: `Antwort ${i + 1}` });
    const c = counter(value, limits.choice);
    input.oninput = () => {
      f.choices[i] = input.value;
      c.textContent = `${input.value.length}/${limits.choice}`;
      c.className = `counter${input.value.length > limits.choice ? ' over' : ''}`;
    };
    input.onkeydown = (e) => {
      // Enter in der letzten Zeile = neue Antwort
      if (e.key === 'Enter' && i === f.choices.length - 1 && f.choices.length < limits.choices) {
        f.choices.push('');
        renderForm();
        [...document.querySelectorAll('.choice-row input')].at(-1)?.focus();
      }
    };
    return h('div', { class: 'choice-row' },
      h('span', { class: 'choice-num' }, `${i + 1}`),
      input,
      c,
      h('button', {
        class: 'icon-btn', title: 'Entfernen', disabled: f.choices.length <= 2,
        onclick: () => { f.choices.splice(i, 1); renderForm(); },
      }, '✕'));
  });

  const custom = h('input', { type: 'number', min: limits.minSeconds, max: limits.maxSeconds, value: f.durationSeconds, title: 'Sekunden' });
  custom.onchange = () => { f.durationSeconds = Number(custom.value); renderForm(); };

  const permission = h('select', {}, ...ROLES.map(([v, l]) => h('option', { value: v, selected: v === f.permission }, l)));
  permission.onchange = () => { f.permission = permission.value; };

  const cpInput = h('input', { type: 'number', min: 1, max: 1000000, value: f.channelPointsPerVote });
  cpInput.onchange = () => { f.channelPointsPerVote = Number(cpInput.value); };

  const tooMany = f.choices.length > limits.choices;
  box.replaceChildren(...[
    h('h2', {}, '＋ Neue Umfrage'),
    h('div', { class: 'seg' }, modeBtn('chat', '💬 Chat-Umfrage'), modeBtn('twitch', '🟣 Twitch-Umfrage')),
    f.mode === 'chat'
      ? h('p', { class: 'note' }, `Zuschauer stimmen im Chat ab (!${state.data.settings.chat.voteCommand} 2${state.data.settings.chat.numberVotes ? ' oder einfach 2' : ''}). Bis zu 10 Antworten, geht in jedem Kanal.`)
      : h('p', { class: 'note' }, 'Die echte Twitch-Umfrage oben im Chat, optional mit Kanalpunkten für Zusatzstimmen. Max. 5 Antworten, 25 Zeichen pro Antwort, 30 Minuten.'),
    state.data.broadcasterType === '' ? h('p', { class: 'warn-note' }, 'Twitch-Umfragen gibt es erst ab Affiliate, deshalb nur Chat-Umfragen.') : null,
    h('div', { class: 'field' }, h('label', {}, 'Frage'), title, titleCounter),
    h('div', { class: 'field' },
      h('label', {}, 'Antworten'),
      h('div', { class: 'choices' }, ...choiceRows),
      tooMany ? h('p', { class: 'warn-note' }, `Eine Twitch-Umfrage hat höchstens ${limits.choices} Antworten.`) : null,
      f.choices.length < limits.choices
        ? h('button', { class: 'btn small', style: { alignSelf: 'flex-start' }, onclick: () => { f.choices.push(''); renderForm(); } }, '＋ Antwort')
        : null),
    h('div', { class: 'field' },
      h('label', {}, 'Dauer'),
      h('div', { class: 'presets' },
        ...DURATIONS.filter(([s]) => s >= limits.minSeconds && s <= limits.maxSeconds).map(([s, l]) =>
          h('button', { class: `btn small${f.durationSeconds === s ? ' on' : ''}`, onclick: () => { f.durationSeconds = s; renderForm(); } }, l)),
        custom, h('span', { class: 'note' }, 'Sekunden'))),
    f.mode === 'chat'
      ? h('div', { class: 'f-row' },
        h('div', { class: 'field' }, h('label', {}, 'Wer darf abstimmen?'), permission),
        h('div', { class: 'opt-row' }, toggle(f.allowChange, (on) => { f.allowChange = on; }, 'Stimme ändern'), h('span', {}, 'Stimme darf geändert werden')))
      : h('div', { class: 'f-row' },
        h('div', { class: 'opt-row' }, toggle(f.channelPoints, (on) => { f.channelPoints = on; renderForm(); }, 'Kanalpunkte'), h('span', {}, 'Zusatzstimmen mit Kanalpunkten')),
        f.channelPoints ? h('div', { class: 'field' }, h('label', {}, 'Kanalpunkte pro Zusatzstimme'), cpInput) : h('span')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: startPoll }, '▶ Umfrage starten'),
      h('button', { class: 'btn', onclick: () => { resetForm(); renderForm(); } }, 'Leeren')),
  ].filter(Boolean));
}

async function startPoll() {
  const f = state.form;
  const payload = { ...f, choices: f.choices.map((c) => c.trim()).filter(Boolean), title: f.title.trim() };
  try {
    await api(`${BASE}/start`, payload);
    // Zuletzt benutzte Einstellungen als Standard merken
    const d = state.data.settings.defaults;
    await api(`${BASE}/settings`, {
      defaults: { ...d, mode: f.mode, durationSeconds: f.durationSeconds, allowChange: f.allowChange, permission: f.permission, channelPoints: f.channelPoints, channelPointsPerVote: f.channelPointsPerVote },
    }).catch(() => {});
    toast('Umfrage läuft!', 'ok');
    state.form = null;
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderLive() {
  const p = state.data.active;
  const left = p.endsAt - now();
  const total = p.total;
  const max = Math.max(0, ...p.choices.map((c) => c.votes));
  const box = $('#current');

  box.replaceChildren(
    h('div', { class: 'live-head' },
      h('span', { class: 'badge live-badge ok' }, '● LÄUFT'),
      h('span', { class: 'badge' }, p.mode === 'chat' ? '💬 Chat' : '🟣 Twitch'),
      p.external ? h('span', { class: 'badge accent', title: 'Direkt bei Twitch gestartet' }, 'von Twitch') : null,
      p.startedBy && !p.external && p.startedBy !== 'Dashboard' ? h('span', { class: 'badge' }, `gestartet von ${p.startedBy}`) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'time-left' }, left > 0 ? fmtTime(left) : 'endet…')),
    h('div', { class: 'live-title' }, p.title),
    h('div', { class: 'progress' }, h('div', { style: { width: `${Math.max(0, Math.min(100, (left / (p.endsAt - p.startedAt)) * 100))}%` } })),
    h('div', { class: 'bars' }, ...p.choices.map((c, i) =>
      h('div', { class: `bar${c.votes === max && max > 0 ? ' lead' : ''}` },
        h('div', { class: 'bar-fill', style: { width: `${pct(c.votes, total)}%` } }),
        h('div', { class: 'bar-content' },
          h('span', { class: 'choice-num' }, `${i + 1}`),
          h('span', { class: 'bar-label' }, c.title),
          p.mode === 'chat' ? h('button', { class: 'btn small', title: 'Test-Stimme (Fake-Zuschauer)', onclick: () => testVote(i) }, '+1') : null,
          h('span', { class: 'bar-num' }, `${c.votes}`),
          h('span', { class: 'bar-pct' }, `${pct(c.votes, total)}%`))))),
    h('p', { class: 'note' },
      `${total} ${total === 1 ? 'Stimme' : 'Stimmen'}`,
      p.mode === 'chat' ? ` · abstimmen: ${roleLabel(p.permission)} · ${p.allowChange ? 'Stimme änderbar' : 'Stimme fest'}` : ''),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: () => endPoll(false) }, '🏁 Jetzt beenden'),
      h('button', { class: 'btn', onclick: () => endPoll(true) }, '✕ Abbrechen (ohne Ergebnis)')),
  );
}

async function endPoll(cancel) {
  if (cancel && !confirm('Umfrage abbrechen? Das Ergebnis wird nicht im Chat verkündet.')) return;
  try {
    await api(`${BASE}/end`, { cancel });
    toast(cancel ? 'Umfrage abgebrochen' : 'Umfrage beendet', 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function testVote(choice) {
  try {
    await api(`${BASE}/test-vote`, { choice });
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================ Verlauf

function renderHistory() {
  const list = state.data.history;
  const box = $('#history');
  const key = JSON.stringify(list.map((r) => r.id));
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'Noch keine Umfragen.'));
    return;
  }
  box.replaceChildren(h('div', { class: 'hist' }, ...list.map((r) =>
    h('div', { class: 'h-item' },
      h('div', { class: 'h-main' },
        h('div', { class: 'h-title' }, r.title),
        h('div', { class: 'h-meta' },
          h('span', {}, new Date(r.startedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })),
          h('span', { class: 'badge' }, r.mode === 'chat' ? '💬 Chat' : '🟣 Twitch'),
          h('span', {}, `${r.total} ${r.total === 1 ? 'Stimme' : 'Stimmen'}`),
          r.completed ? null : h('span', { class: 'badge warn' }, 'abgebrochen')),
        h('div', { class: 'mini-bars' }, ...r.choices.map((c, i) =>
          h('div', { class: `mini${r.winners.includes(i) ? ' win' : ''}` },
            h('span', {}, `${r.winners.includes(i) ? '🏆 ' : ''}${c.title}`),
            h('div', { class: 'track' }, h('div', { style: { width: `${pct(c.votes, r.total)}%` } })),
            h('span', {}, `${pct(c.votes, r.total)}%`))))),
      h('div', { class: 'h-actions' },
        h('button', {
          class: 'icon-btn', title: 'Nochmal (ins Formular übernehmen)',
          onclick: () => {
            if (state.data.active) return toast('Es läuft gerade eine Umfrage.', 'err');
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
        }, '🗑'))))));
}

// ============================================================ Hilfe

function renderHelp() {
  const s = state.data.settings;
  const box = $('#chat-help');
  const key = JSON.stringify([s.chat, s.modCommands]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    h('div', {}, h('b', {}, 'Zuschauer (Chat-Umfrage): '), h('code', {}, `!${s.chat.voteCommand} 2`), s.chat.numberVotes ? [' oder einfach ', h('code', {}, '2')] : null,
      ' – auch der Text der Antwort geht: ', h('code', {}, `!${s.chat.voteCommand} Minecraft`)),
    s.modCommands.enabled
      ? h('div', {}, h('b', {}, `${roleLabel(s.modCommands.permission)}: `), h('code', {}, `!${s.modCommands.pollCommand} 90 Frage | Antwort 1 | Antwort 2`),
        h('div', { class: 'note' }, 'Die Zahl vorne (Sekunden, oder z.B. 5m) ist optional. Es wird die zuletzt benutzte Art (Chat/Twitch) genommen.'),
        h('div', {}, h('code', {}, `!${s.modCommands.endCommand}`), ' beendet die laufende Umfrage.'))
      : h('div', { class: 'note' }, 'Umfragen per Chat starten ist aus (Einstellungen → Mod-Commands).'));
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

const START_VARS = [['{title}', 'Die Frage'], ['{options}', '1) A · 2) B …'], ['{command}', 'z.B. !vote'], ['{duration}', 'Dauer der Umfrage']];
const END_VARS = [['{title}', 'Die Frage'], ['{winner}', 'Gewinner-Antwort'], ['{percent}', 'Prozent des Gewinners'], ['{votes}', 'Stimmen des Gewinners'], ['{total}', 'Stimmen insgesamt'], ['{results}', 'Alle Ergebnisse: A 60% · B 40%']];

function openSettings() {
  const s = structuredClone(state.data.settings);
  const c = s.chat;
  const m = s.modCommands;
  const o = s.overlay;

  const voteCmd = h('input', { type: 'text', value: c.voteCommand, maxlength: 30 });
  const startChat = textArea(c.announceStartChat);
  const startTwitch = textArea(c.announceStartTwitch);
  const reminderText = textArea(c.announceReminder);
  const endText = textArea(c.announceEnd);
  const confirmText = textArea(c.confirmVote);

  const pollCmd = h('input', { type: 'text', value: m.pollCommand, maxlength: 30 });
  const endCmd = h('input', { type: 'text', value: m.endCommand, maxlength: 30 });
  const modRole = h('select', {}, ...ROLES.map(([v, l]) => h('option', { value: v, selected: v === m.permission }, l)));

  const color = (value) => h('input', { type: 'color', value });
  const num = (value, min, max) => h('input', { type: 'number', min, max, value });
  const accent = color(o.accent);
  const textColor = color(o.textColor);
  const bg = color(o.background);
  const bgOpacity = num(o.backgroundOpacity, 0, 100);
  const fontSize = num(o.fontSize, 12, 60);
  const width = num(o.width, 250, 1920);
  const resultSec = num(o.showResultSeconds, 0, 300);

  const collect = () => ({
    chat: {
      voteCommand: voteCmd.value, numberVotes: c.numberVotes,
      announceStartChat: startChat.value, announceStartTwitch: startTwitch.value,
      announceReminder: reminderText.value, reminder: c.reminder,
      announceEnd: endText.value, confirmVote: confirmText.value,
    },
    modCommands: { enabled: m.enabled, pollCommand: pollCmd.value, endCommand: endCmd.value, permission: modRole.value },
    overlay: {
      accent: accent.value, textColor: textColor.value, background: bg.value, backgroundOpacity: Number(bgOpacity.value),
      fontSize: Number(fontSize.value), width: Number(width.value), showResultSeconds: Number(resultSec.value),
      showVotes: o.showVotes, showTimer: o.showTimer, showHowTo: o.showHowTo,
    },
  });

  const save = async (close, andTest) => {
    try {
      const settings = await api(`${BASE}/settings`, collect());
      state.data.settings = settings;
      if (andTest) await api(`${BASE}/overlay/test`, {});
      else {
        toast('Gespeichert', 'ok');
        close();
      }
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const opt = (checked, onchange, text) => h('div', { class: 'opt-row' }, toggle(checked, onchange, text), h('span', {}, text));

  modal('⚙ Umfragen-Einstellungen', [
    {
      title: '💬 Abstimmen & Nachrichten',
      content: [
        h('div', { class: 'f-row' },
          field('Abstimm-Command', voteCmd),
          opt(c.numberVotes, (on) => { c.numberVotes = on; }, 'Eine Zahl allein zählt als Stimme („2“)')),
        h('p', { class: 'note' }, 'Die Nachrichten schreibt dein Bot (falls verknüpft). Feld leer lassen = keine Nachricht.'),
        field('Start einer Chat-Umfrage', ...withChips(startChat, START_VARS)),
        field('Start einer Twitch-Umfrage', ...withChips(startTwitch, START_VARS)),
        opt(c.reminder, (on) => { c.reminder = on; }, 'Erinnerung zur Halbzeit (Chat-Umfragen ab 1 Minute)'),
        field('Erinnerung', ...withChips(reminderText, [...START_VARS.slice(0, 3), ['{left}', 'Restzeit']])),
        field('Ergebnis', ...withChips(endText, END_VARS)),
        field('Bestätigung pro Stimme (Standard: leer, sonst wird es schnell zu viel)', ...withChips(confirmText, [['{user}', 'Name'], ['{choice}', 'Gewählte Antwort'], ['{number}', 'Nummer der Antwort']])),
      ],
    },
    {
      title: '🛡 Mod-Commands',
      content: [
        opt(m.enabled, (on) => { m.enabled = on; }, 'Umfragen per Chat starten und beenden'),
        h('div', { class: 'f-row3' }, field('Starten', pollCmd), field('Beenden', endCmd), field('Wer darf das?', modRole)),
        h('p', { class: 'note' }, 'Beispiel: !poll 2m Pizza oder Burger? | Pizza | Burger'),
      ],
    },
    {
      title: '🎥 Overlay',
      content: [
        h('div', { class: 'f-row3' }, field('Akzentfarbe', accent), field('Textfarbe', textColor), field('Hintergrund', bg)),
        h('div', { class: 'f-row3' }, field('Deckkraft Hintergrund (%)', bgOpacity), field('Schriftgröße (px)', fontSize), field('Breite (px)', width)),
        field('Ergebnis so lange zeigen (Sekunden)', resultSec),
        opt(o.showVotes, (on) => { o.showVotes = on; }, 'Anzahl der Stimmen zeigen'),
        opt(o.showTimer, (on) => { o.showTimer = on; }, 'Restzeit zeigen'),
        opt(o.showHowTo, (on) => { o.showHowTo = on; }, 'Bei Chat-Umfragen zeigen, wie man abstimmt (!vote 1)'),
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
  const url = `${location.origin}/addons/polls/overlay.html`;
  $('#overlay-url').value = url;
  $('#copy-url').onclick = async () => {
    await navigator.clipboard.writeText(url).catch(() => {});
    toast('Link kopiert', 'ok');
  };
  $('#overlay-test').onclick = async () => {
    try {
      await api(`${BASE}/overlay/test`, {});
      toast('Beispiel-Umfrage im Overlay (nur dort, nicht im Chat)', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#open-settings').onclick = openSettings;
  await load();
  // Läuft eine Umfrage: jede Sekunde aktualisieren, sonst alle 5 Sekunden
  let ticks = 0;
  setInterval(() => {
    ticks++;
    if ($('#modal-host').childElementCount) return;
    if (state.data?.active || ticks % 5 === 0) void load();
  }, 1000);
})();
