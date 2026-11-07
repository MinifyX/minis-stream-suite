const { $, h, api, toast, toggle, icon } = window.UI;
const BASE = 'addons/uwuclip';

const state = { data: null };

const STATES = {
  off: { text: 'Aus', cls: '' },
  idle: { text: 'Bereit', cls: 'ok' },
  connected: { text: 'Verbunden', cls: 'ok' },
  retrying: { text: 'Nicht erreichbar', cls: 'warn' },
  paused: { text: 'Pausiert', cls: 'err' },
};

const fmtTime = (t) => new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });

async function call(path, body) {
  try {
    const data = await api(`${BASE}${path}`, body);
    state.data = data;
    render();
    return data;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

// ============================================================ Anzeigen

function render() {
  if (!state.data) return;
  renderToggle();
  renderForm();
  renderStatus();
}

function renderToggle() {
  const on = state.data.settings.enabled;
  const box = $('#enabled-toggle');
  if (box.dataset.on === String(on)) return;
  box.dataset.on = String(on);
  box.replaceChildren(toggle(on, (v) => call('/settings', { enabled: v }), 'Weiterleitung an/aus'), on ? 'An' : 'Aus');
}

let formFilled = false;
function renderForm() {
  const { serverUrl, hasSecret, secretPlain } = state.data.settings;
  // Eingaben nicht überschreiben, während jemand tippt
  if (!formFilled) {
    $('#server-url').value = serverUrl;
    formFilled = true;
  }
  $('#secret').placeholder = hasSecret ? '•••••••• (gespeichert)' : 'Schlüssel aus UwUClip einfügen';
  $('#secret-note').textContent = hasSecret
    ? 'Der gespeicherte Schlüssel wird nicht angezeigt. Leer lassen, um ihn zu behalten.'
    : 'Noch kein Schlüssel gespeichert.';
  $('#clear-secret').hidden = !hasSecret;
  $('#secret-plain').hidden = !secretPlain;
}

function renderStatus() {
  const { status, settings } = state.data;
  let info = STATES[status.state] ?? STATES.off;
  if (status.state === 'off' && settings.enabled) info = { text: 'Nicht eingerichtet', cls: 'warn' };
  const pill = $('#status-pill');
  pill.className = `status-pill ${info.cls}`;
  pill.textContent = info.text;

  const rows = [
    ['Status', info.text],
    ['Zuletzt gesendet', status.lastSentAt ? fmtTime(status.lastSentAt) : '–'],
    ['In der Warteschlange', String(status.queued)],
  ];
  if (status.nextAttemptAt) rows.push(['Nächster Versuch', fmtTime(status.nextAttemptAt)]);
  if (status.dropped) rows.push(['Verworfen', String(status.dropped)]);
  const items = rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]);
  if (status.lastError) items.push(h('dt', {}, 'Letzter Fehler'), h('dd', { class: 'err' }, status.lastError));
  $('#status').replaceChildren(...items);
  $('#resume').hidden = !['paused', 'retrying'].includes(status.state);
  $('#clear-queue').hidden = status.queued === 0;
}

function showTestResult(result) {
  const box = $('#test-result');
  box.hidden = false;
  box.className = `test-result ${result.ok ? 'ok' : 'err'}`;
  // Fehlertext als eigener Textknoten, damit ihn die Übersetzung erkennt
  if (result.ok) box.replaceChildren(icon('check'), ` Verbunden (Antwort ${result.status})`);
  else box.replaceChildren(icon('x'), ' ', h('span', {}, result.error));
}

// ============================================================ Aktionen

$('#conn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { serverUrl: $('#server-url').value };
  const secret = $('#secret').value.trim();
  if (secret) body.secret = secret;
  const data = await call('/settings', body);
  if (!data) return;
  $('#secret').value = '';
  $('#server-url').value = data.settings.serverUrl;
  toast('Gespeichert', 'ok');
});

$('#test').addEventListener('click', async () => {
  const button = $('#test');
  button.disabled = true;
  // Getestet wird, was gerade in den Feldern steht (leerer Schlüssel = gespeicherter)
  const body = { serverUrl: $('#server-url').value };
  const secret = $('#secret').value.trim();
  if (secret) body.secret = secret;
  const data = await call('/test', body);
  button.disabled = false;
  if (data) showTestResult(data.result);
});

$('#clear-secret').addEventListener('click', () => {
  if (confirm('Gespeicherten Schlüssel entfernen? Die Weiterleitung stoppt dann.')) call('/settings', { clearSecret: true });
});

$('#resume').addEventListener('click', () => call('/resume', {}));

$('#clear-queue').addEventListener('click', () => {
  if (confirm('Alle wartenden Events verwerfen? Sie werden dann nie an UwUClip geschickt.')) call('/clear', {});
});

// Status regelmäßig auffrischen (nur wenn die Seite sichtbar ist)
call('/state');
setInterval(async () => {
  if (document.hidden) return;
  try {
    state.data = await api(`${BASE}/state`);
    render();
  } catch {
    // still – beim nächsten Mal wieder
  }
}, 3000);
