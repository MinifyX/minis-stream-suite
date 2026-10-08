const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/intro';

const CHAIN = [
  ['IDLE', 'Bereit'],
  ['INTRO', 'Intro'],
  ['LOOP1', 'Loop 1'],
  ['MAIN', 'Main'],
  ['LOOP2', 'Loop 2'],
  ['OUTRO', 'Outro'],
  ['DONE', 'Fertig'],
];
const LOOPS = ['LOOP1', 'LOOP2'];
const SEGMENTS = [['intro', 'Intro'], ['loop1', 'Loop 1'], ['main', 'Main'], ['loop2', 'Loop 2'], ['outro', 'Outro']];
const WEBHOOK_STATES = ['INTRO', 'LOOP1', 'MAIN', 'LOOP2', 'OUTRO', 'DONE'];

const state = {
  /** Antwort von /state */
  s: null,
  /** Wann der Zustand ankam (für den Countdown) */
  stateAt: 0,
  scenes: null,
  busy: false,
};

// ============================================================ Laden & Live-Daten

async function load() {
  try {
    state.s = await api(`${BASE}/state`);
    state.stateAt = Date.now();
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  render();
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws?channel=intro`);
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!state.s) return;
    if (msg.type === 'intro.state') {
      const { type, ...rest } = msg;
      state.s.intro = rest;
      state.stateAt = Date.now();
      renderControl();
      renderPlayer();
    } else if (msg.type === 'player.status') {
      const { type, ...rest } = msg;
      state.s.player = rest;
      renderPlayer();
      renderControl();
    } else if (msg.type === 'system.log') {
      state.s.log.unshift({ level: msg.level, message: msg.message, ts: msg.ts });
      state.s.log.length = Math.min(state.s.log.length, 50);
      renderLog();
    }
  };
  ws.onclose = () => setTimeout(() => {
    load();
    connect();
  }, 2000);
}

// ============================================================ Steuerung

/** Welcher Knopf ist gerade der sinnvolle? */
function hotCommand(intro) {
  if (!intro.playerConnected) return null;
  switch (intro.state) {
    case 'IDLE': return 'start';
    case 'INTRO':
    case 'LOOP1': return intro.pendingTrigger ? null : 'go';
    case 'MAIN':
    case 'LOOP2': return intro.pendingTrigger ? null : 'outro';
    case 'DONE': return 'reset';
    default: return null;
  }
}

async function command(action) {
  if (action === 'abort' && !confirm('Intro wirklich abbrechen? Ton und Bild werden ausgeblendet, danach Szenenwechsel und Musik wie beim normalen Ende.')) return;
  state.busy = true;
  renderControl();
  try {
    const res = await api(`${BASE}/cmd`, { action });
    if (res.queued) toast('Start ist vorgemerkt – läuft los, sobald der Player alles geladen hat.', 'info');
  } catch (err) {
    toast(err.message, 'err');
  }
  state.busy = false;
  renderControl();
}

function remainingMs() {
  const { intro } = state.s;
  if (intro.nextBoundaryInMs === null) return null;
  return Math.max(0, intro.nextBoundaryInMs - (Date.now() - state.stateAt));
}

function renderCountdown() {
  if (!state.s) return;
  const { intro } = state.s;
  const ms = remainingMs();
  const running = !['IDLE', 'DONE'].includes(intro.state);
  const label = LOOPS.includes(intro.state) ? (intro.pendingTrigger ? 'bis zum Wechsel' : 'bis zur Loop-Grenze') : 'bis zum nächsten Teil';
  $('#countdown').replaceChildren(...(running && ms !== null
    ? [`${(ms / 1000).toFixed(1)} s`, h('small', {}, label)]
    : []));
}

function renderControl() {
  const { intro, player } = state.s;
  const index = CHAIN.findIndex(([id]) => id === intro.state);

  $('#chain').replaceChildren(...CHAIN.flatMap(([id, label], i) => [
    i ? h('span', { class: 'arrow' }, '→') : null,
    h('span', { class: `st${i < index ? ' past' : ''}${i === index ? ' now' : ''}${LOOPS.includes(id) ? ' loop' : ''}` }, label),
  ]).filter(Boolean));

  const title = CHAIN[index]?.[1] ?? intro.state;
  const sub = !intro.playerConnected
    ? 'Kein Player verbunden'
    : !player.ready
      ? (player.error ? 'Player: Fehler beim Laden' : `Player lädt (${player.loaded}/${player.total})`)
      : intro.state === 'IDLE' ? (player.startQueued ? 'Start ist vorgemerkt' : 'Bereit zum Start') : intro.state;
  $('#now-state').replaceChildren(title, h('small', {}, sub));

  const triggerLabel = { go: 'Go', outro: 'Outro' }[intro.pendingTrigger];
  $('#pending').replaceChildren(...(intro.pendingTrigger
    ? [h('span', { class: 'pending-badge' }, `⏳ „${triggerLabel}“ vorgemerkt`,
      h('button', { onclick: () => command('cancel-pending') }, 'zurücknehmen'))]
    : []));
  renderCountdown();

  const hot = hotCommand(intro);
  const disabled = state.busy || !intro.playerConnected;
  const btn = (action, label, hint, extra = '') => h('button', {
    class: `btn cmd${hot === action ? ' hot' : ''}${extra}`,
    disabled,
    onclick: () => command(action),
  }, label, h('small', {}, hint));
  $('#commands').replaceChildren(
    btn('start', '▶ Start', 'Sequenz starten'),
    btn('go', '⏭ Go', 'nach Loop 1'),
    btn('outro', '🏁 Outro', 'nach Loop 2'),
    btn('cancel-pending', '↩ Zurücknehmen', 'Trigger verwerfen'),
    btn('abort', '⛔ Abort', 'Notausstieg', ' danger'),
    btn('reset', '⟲ Reset', 'zurück auf Anfang'),
  );

  const hints = {
    IDLE: 'Start spielt das Intro ab. „Go“ darfst du schon während des Intros drücken – Loop 1 läuft dann genau einmal.',
    INTRO: '„Go“ jetzt drücken = Loop 1 läuft genau einmal, dann Main.',
    LOOP1: 'Loop 1 wiederholt sich, bis du „Go“ drückst. Gewechselt wird am Ende des laufenden Durchlaufs.',
    MAIN: '„Outro“ jetzt drücken = Loop 2 läuft genau einmal, dann Outro.',
    LOOP2: 'Loop 2 wiederholt sich, bis du „Outro“ drückst.',
    OUTRO: 'Das Outro läuft. Danach: Szenenwechsel, Musik, Webhooks.',
    DONE: 'Fertig. „Reset“ setzt alles zurück, ohne etwas auszulösen.',
  };
  $('#cmd-hint').textContent = intro.playerConnected ? hints[intro.state] ?? '' : 'Öffne zuerst die Browserquelle in OBS (Adresse rechts).';
}

// ============================================================ Player & Medien

function renderPlayer() {
  const { player, intro } = state.s;
  const pill = $('#player-pill');
  if (!intro.playerConnected) {
    pill.className = 'status-pill err';
    pill.replaceChildren(h('span', { class: 'dot err' }), 'Player nicht verbunden');
  } else if (player.error) {
    pill.className = 'status-pill err';
    pill.replaceChildren(h('span', { class: 'dot err' }), 'Player: Fehler');
  } else if (!player.ready) {
    pill.className = 'status-pill warn';
    pill.replaceChildren(h('span', { class: 'dot warn' }), `Player lädt ${player.loaded}/${player.total}`);
  } else {
    pill.className = 'status-pill ok';
    pill.replaceChildren(h('span', { class: 'dot ok' }), 'Player bereit');
  }

  $('#player-detail').replaceChildren(...[
    player.connected > 1 ? h('p', { class: 'warn-note' }, `⚠ ${player.connected} Player verbunden – das Intro läuft in jedem davon. Bitte nur eine Browserquelle offen lassen.`) : null,
    player.error ? h('p', { class: 'err-note no-i18n' }, player.error) : null,
  ].filter(Boolean));
}

function renderMedia() {
  const s = state.s;
  $('#player-url').textContent = s.playerUrl;
  const dir = $('#media-dir');
  if (document.activeElement !== dir) dir.value = s.settings.mediaDir;
  dir.placeholder = s.defaultMediaDir;
  $('#media-default').textContent = s.settings.mediaDir ? 'Leer lassen = Standardordner der Suite.' : `Standard: ${s.defaultMediaDir}`;

  $('#segments').replaceChildren(...SEGMENTS.map(([id, label]) => {
    const seg = s.settings.segments[id];
    return h('div', { class: 'seg', 'data-id': id },
      h('span', { class: 'seg-name' }, label),
      h('input', { type: 'text', class: 'no-i18n', name: 'video', value: seg.video, placeholder: 'Video (optional)', title: 'Video ohne Ton – leer = schwarzes Bild' }),
      h('input', { type: 'text', class: 'no-i18n', name: 'audio', value: seg.audio, placeholder: 'Audio', title: 'Audio (WAV)' }),
      h('input', { type: 'text', class: 'seg-text no-i18n', name: 'overlayText', value: seg.overlayText, placeholder: 'Text über dem Video (optional)' }));
  }));

  $('#missing').replaceChildren(...(s.missingFiles.length
    ? [h('div', { class: 'missing' }, h('b', {}, `Fehlt im Ordner (${s.missingFiles.length}):`), ...s.missingFiles.map((f) => h('span', { class: 'no-i18n' }, `• ${f}`)))]
    : [h('p', { class: 'note' }, '✓ Alle Dateien gefunden.')]));
}

async function saveMedia() {
  const segments = {};
  for (const row of document.querySelectorAll('.seg')) {
    segments[row.dataset.id] = Object.fromEntries([...row.querySelectorAll('input')].map((i) => [i.name, i.value]));
  }
  try {
    state.s = await api(`${BASE}/settings`, { mediaDir: $('#media-dir').value, segments });
    toast('Gespeichert – der Player lädt die Dateien neu (sobald kein Intro läuft).', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  render();
}

// ============================================================ Nach dem Intro

async function saveSettings(patch, message) {
  try {
    state.s = await api(`${BASE}/settings`, patch);
    if (message) toast(message, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  render();
}

async function loadScenes() {
  try {
    const res = await api(`${BASE}/scenes`);
    state.scenes = res.connected ? res.scenes : null;
  } catch {
    state.scenes = null;
  }
}

/** Auswahl aus den OBS-Szenen, oder ein Textfeld, wenn OBS nicht verbunden ist */
function scenePicker(value, onchange, emptyLabel) {
  if (state.scenes) {
    const options = [...state.scenes];
    if (value && !options.includes(value)) options.push(value);
    return h('select', { class: 'no-i18n', onchange: (e) => onchange(e.target.value) },
      emptyLabel !== undefined ? h('option', { value: '', selected: !value }, emptyLabel) : null,
      ...options.map((name) => h('option', { value: name, selected: name === value }, name)));
  }
  return h('input', { type: 'text', class: 'no-i18n', value, placeholder: emptyLabel ?? 'Name der Szene', onchange: (e) => onchange(e.target.value) });
}

function renderDone() {
  const { onDone, obs } = state.s.settings;
  const s = state.s;
  $('#done-form').replaceChildren(...[
    h('p', { class: 'note' }, 'Läuft nach dem Outro und nach „Abort“ in dieser Reihenfolge. Klappt ein Schritt nicht, geht es trotzdem weiter.'),
    h('div', { class: 'opt-row' },
      h('span', {}, '1. OBS auf Stream-Szene schalten'),
      toggle(onDone.switchScene, (on) => saveSettings({ onDone: { switchScene: on } }), 'OBS-Szene wechseln')),
    onDone.switchScene ? h('div', { class: 'field' }, scenePicker(obs.streamScene, (v) => saveSettings({ obs: { streamScene: v } }, 'Stream-Szene gespeichert'))) : null,
    !s.obsAvailable ? h('p', { class: 'warn-note' }, 'Dafür muss das Addon „OBS-Steuerung“ an und verbunden sein.') : null,
    h('div', { class: 'opt-row' },
      h('span', {}, '2. Musik starten'),
      toggle(onDone.startMusic, (on) => saveSettings({ onDone: { startMusic: on } }), 'Musik starten')),
    onDone.startMusic ? h('div', { class: 'f-row' },
      h('div', { class: 'field' }, h('label', {}, 'Einblenden (Sek.)'),
        h('input', { type: 'number', min: 0, max: 30, step: 0.5, value: onDone.musicFadeInMs / 1000, onchange: (e) => saveSettings({ onDone: { musicFadeInMs: Number(e.target.value) * 1000 } }) })),
      h('p', { class: 'note' }, 'Welche Playlist, stellst du auf der Musik-Seite unter „Auto-Start“ ein.')) : null,
    onDone.startMusic && !s.musicAvailable ? h('p', { class: 'warn-note' }, 'Dafür muss das Addon „Musik“ an sein.') : null,
    h('div', { class: 'opt-row' },
      h('span', {}, '3. Webhooks „DONE“ auslösen'),
      toggle(onDone.webhooks, (on) => saveSettings({ onDone: { webhooks: on } }), 'Webhooks auslösen')),
    h('hr', { class: 'sep' }),
    h('div', { class: 'field' }, h('label', {}, 'Beim Start auf diese Szene schalten'),
      scenePicker(obs.introScene, (v) => saveSettings({ obs: { introScene: v } }, 'Intro-Szene gespeichert'), '– nicht umschalten –')),
    !state.scenes ? h('p', { class: 'note' }, 'OBS ist nicht verbunden – Szenen bitte von Hand eintragen.') : null,
  ].filter(Boolean));
}

function renderWebhooks() {
  const { webhooks } = state.s.settings;
  $('#webhooks').replaceChildren(...WEBHOOK_STATES.map((st) => {
    const area = h('textarea', { class: 'no-i18n', rows: 2, placeholder: 'https://…' });
    area.value = webhooks[st].join('\n');
    return h('div', { class: 'wh' },
      h('div', { class: 'wh-head' }, st, h('span', { class: 'spacer' }),
        h('button', { class: 'link-btn', onclick: async () => {
          try {
            state.s = await api(`${BASE}/test-webhook`, { state: st });
            toast(`Webhooks für ${st} verschickt – Ergebnis im Log.`, 'ok');
          } catch (err) {
            toast(err.message, 'err');
          }
          renderLog();
        } }, 'Testen')),
      area,
      h('button', { class: 'btn small', onclick: () => saveSettings({ webhooks: { [st]: area.value.split('\n') } }, `Webhooks für ${st} gespeichert`) }, 'Speichern'));
  }));
}

// ============================================================ Log

function renderLog() {
  const icons = { info: 'ℹ️', warn: '⚠️', error: '❌' };
  const rows = state.s.log.map((e) => h('div', { class: `l-row ${e.level}` },
    h('span', { class: 'l-time' }, new Date(e.ts).toLocaleTimeString().slice(0, 8)),
    h('span', {}, icons[e.level] ?? ''),
    h('span', { class: 'l-text no-i18n' }, e.message)));
  $('#log').replaceChildren(...(rows.length ? rows : [h('div', { class: 'log-empty' }, 'Noch nichts passiert.')]));
}

// ============================================================ Musik (kleiner Player, wenn das Addon an ist)

async function renderMusic() {
  if (!window.MusicMini) {
    const script = document.createElement('script');
    script.src = '/addons/music/mini.js';
    const ok = await new Promise((resolve) => {
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.append(script);
    });
    if (!ok) return;
  }
  const shown = await window.MusicMini.mount($('#music-mini'));
  $('#music-card').hidden = !shown;
}

// ============================================================ Alles

function render() {
  if (!state.s) return;
  renderControl();
  renderPlayer();
  renderMedia();
  renderDone();
  renderWebhooks();
  renderLog();
}

$('#copy-url').onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.s.playerUrl);
    toast('Adresse kopiert', 'ok');
  } catch {
    toast('Kopieren hat nicht geklappt.', 'err');
  }
};
$('#save-media').onclick = saveMedia;
$('#open-folder').onclick = () => api(`${BASE}/open-media-folder`, {}).catch((err) => toast(err.message, 'err'));
$('#reload-player').onclick = async () => {
  try {
    state.s = await api(`${BASE}/reload-player`, {});
    toast('Player lädt neu (sobald kein Intro läuft).', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  render();
};
$('#log-clear').onclick = async () => {
  try {
    state.s = await api(`${BASE}/log/clear`, {});
  } catch (err) {
    toast(err.message, 'err');
  }
  renderLog();
};
$('#music-open').onclick = (e) => {
  e.preventDefault();
  window.top.location.hash = '#/addon/music';
};

setInterval(renderCountdown, 100);

(async () => {
  await Promise.all([load(), loadScenes()]);
  render();
  connect();
  renderMusic();
  window.RemoteCard.render($('#remote'), [
    ['POST', '/api/intro/start', 'Sequenz starten'],
    ['POST', '/api/intro/go', 'Trigger „go“'],
    ['POST', '/api/intro/outro', 'Trigger „outro“'],
    ['POST', '/api/intro/cancel-pending', 'Trigger zurücknehmen'],
    ['POST', '/api/intro/abort', 'Notausstieg'],
    ['POST', '/api/intro/reset', 'zurück auf Anfang'],
    ['GET', '/api/intro/state', 'Zustand als JSON'],
  ]);
})();
