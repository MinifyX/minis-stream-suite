const { $, api, toast, toggle } = window.UI;
const BASE = 'addons/watchtime';
let filled = false;

function render(data) {
  const { enabled, serverUrl, hasToken } = data.settings;
  const box = $('#enabled-toggle');
  box.replaceChildren(toggle(enabled, (v) => call('/settings', { enabled: v }), 'Watchtime an/aus'), enabled ? 'An' : 'Aus');
  if (!filled) {
    $('#url').value = serverUrl;
    filled = true;
  }
  $('#token-note').textContent = hasToken ? 'Ein Token ist gespeichert. Leer lassen, um ihn zu behalten.' : 'Noch kein Token gespeichert.';
  const { live, queued, lastOk, lastError } = data.status;
  $('#status').textContent = [
    live ? 'Stream läuft.' : 'Gerade kein Stream.',
    lastOk ? `Zuletzt gemeldet: ${new Date(lastOk).toLocaleString('de-DE')}.` : 'Noch nichts gemeldet.',
    queued ? `${queued} Berichte warten.` : '',
    lastError ? `Fehler: ${lastError}` : '',
  ].filter(Boolean).join(' ');
}

async function call(path, body) {
  try {
    const data = await api(`${BASE}${path}`, body);
    render(data);
    return data;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#token').value;
  const data = await call('/settings', { serverUrl: $('#url').value, token });
  if (data) {
    $('#token').value = '';
    toast('Gespeichert');
  }
});

$('#test').addEventListener('click', async () => {
  if (await call('/test', {})) toast('Verbindung klappt');
});

call('/state');
