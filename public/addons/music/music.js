const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/music';

const state = {
  s: null,
  lists: null,
  tab: 'spotify',
  loadingLists: false,
};

async function call(path, body, message) {
  try {
    state.s = await api(`${BASE}/${path}`, body);
    if (message) toast(message, 'ok');
    render();
    return true;
  } catch (err) {
    toast(err.message, 'err');
    return false;
  }
}

async function load() {
  try {
    state.s = await api(`${BASE}/state`);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  render();
}

async function loadLists() {
  state.loadingLists = true;
  renderLists();
  try {
    state.lists = await api(`${BASE}/playlists`);
  } catch (err) {
    toast(err.message, 'err');
  }
  state.loadingLists = false;
  renderLists();
  // Namen der Auto-Start-Playlist sind jetzt bekannt
  if (state.s) renderAutostart();
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} kopiert`, 'ok');
  } catch {
    toast('Kopieren hat nicht geklappt.', 'err');
  }
}

/** Wie replaceChildren, aber null/false (aus Bedingungen) fallen weg */
const fill = (selector, ...children) => $(selector).replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));

const copyRow = (text, what) => h('div', { class: 'copy-row' }, h('code', { class: 'no-i18n' }, text), h('button', { class: 'btn small', onclick: () => copy(text, what) }, 'Kopieren'));

// ============================================================ Kopf & Quelle

function renderHead() {
  const { host, spotify } = state.s;
  const hp = $('#host-pill');
  hp.className = `status-pill ${host.connected ? 'ok' : 'err'}`;
  hp.replaceChildren(h('span', { class: `dot ${host.connected ? 'ok' : 'err'}` }), host.connected ? 'Music-Host offen' : 'Music-Host zu');
  const sp = $('#spotify-pill');
  const sdkText = { ready: 'Gerät bereit', connecting: 'Gerät startet…', failed: 'Gerät geht nicht', off: '' }[spotify.sdkState];
  sp.className = `status-pill ${spotify.loggedIn ? (spotify.sdkState === 'failed' ? 'warn' : 'ok') : ''}`;
  sp.replaceChildren(h('span', { class: `dot ${spotify.loggedIn ? 'ok' : ''}` }), spotify.loggedIn ? `Spotify${sdkText ? ` · ${sdkText}` : ''}` : 'Spotify nicht verbunden');

  const select = $('#provider');
  select.replaceChildren(...state.s.providers.map((p) => h('option', { value: p.id, selected: p.id === state.s.chosenProvider }, `${p.label}${p.reason ? ' ⚠' : ''}`)));
  select.onchange = () => call('provider', { provider: select.value });
  const chosen = state.s.providers.find((p) => p.id === state.s.chosenProvider);
  select.title = chosen?.reason ?? 'Quelle';

  $('#fallback').replaceChildren(...(state.s.fallback
    ? [h('div', { class: 'fallback' }, `⚠ Spotify in der Suite geht gerade nicht (${spotify.sdkError ?? 'unbekannt'}). Die Suite steuert stattdessen die Spotify-App fern. Erneut versuchen: oben „Spotify (in der Suite)“ wählen.`)]
    : chosen?.reason ? [h('p', { class: 'warn-note' }, chosen.reason)] : []));
}

// ============================================================ Auto-Start

function sourceName(source) {
  if (!source) return null;
  if (source === 'game') return '🎮 Set passend zum Spiel';
  if (source.startsWith('set:')) return `🎛 ${state.s.sets?.sets.find((x) => x.id === source.slice(4))?.name ?? 'gelöschtes Set'}`;
  const all = [...(state.lists?.spotify ?? []), ...(state.lists?.local ?? [])];
  return all.find((p) => p.id === source)?.name ?? source;
}

function renderAutostart() {
  const source = state.s.settings.autoStartSource;
  const input = h('input', { type: 'text', class: 'no-i18n', placeholder: 'Spotify-Link oder -URI (Playlist, Album, Titel) – oder unten ⭐ klicken', value: source.startsWith('local:') ? '' : source });
  fill('#autostart',
    h('p', { class: 'auto-current' }, source ? ['Nach dem Intro läuft: ', h('b', { class: 'no-i18n' }, sourceName(source))] : 'Noch nichts eingestellt.'),
    h('div', { class: 'field' },
      h('select', { onchange: (e) => e.target.value && call('settings', { autoStartSource: e.target.value }, 'Auto-Start gespeichert') },
        h('option', { value: '', selected: !(source === 'game' || source.startsWith('set:')) }, '– Playlist (unten mit ⭐ wählen oder Link einfügen) –'),
        h('option', { value: 'game', selected: source === 'game' }, '🎮 Set passend zum Spiel'),
        ...(state.s.sets?.sets ?? []).map((x) => h('option', { value: `set:${x.id}`, selected: source === `set:${x.id}`, class: 'no-i18n' }, `🎛 ${x.name}`)))),
    h('div', { class: 'auto-row' },
      input,
      h('button', { class: 'btn small', onclick: () => call('settings', { autoStartSource: input.value }, 'Auto-Start gespeichert') }, 'Speichern'),
      source ? h('button', { class: 'btn small', onclick: () => call('play', { source }) }, '▶ Testen') : null),
    h('div', { class: 'f-row' },
      h('div', { class: 'field' }, h('label', {}, `Lautstärke danach: ${state.s.settings.volume}%`),
        h('input', { type: 'range', min: 0, max: 100, value: state.s.settings.volume, onchange: (e) => call('settings', { volume: Number(e.target.value) }) })),
      h('div', { class: 'field' },
        h('div', { class: 'opt-row' }, h('span', {}, 'Zufällig'), toggle(state.s.settings.shuffle, (on) => call('settings', { shuffle: on }), 'Zufällig')),
        h('div', { class: 'opt-row' }, h('span', {}, 'Wiederholen'), toggle(state.s.settings.repeat, (on) => call('settings', { repeat: on }), 'Wiederholen')))),
    h('p', { class: 'note' }, 'Einblende-Dauer und ob die Musik nach dem Intro startet, stellst du auf der Intro-Seite ein.'),
  );
}

// ============================================================ Playlists

function renderLists() {
  const tabs = [['spotify', 'Spotify'], ['local', 'Eigene Musik']];
  $('#tabs').replaceChildren(...tabs.map(([id, label]) => h('button', { class: state.tab === id ? 'on' : '', onclick: () => {
    state.tab = id;
    renderLists();
  } }, label)));

  const box = $('#playlists');
  if (state.loadingLists && !state.lists) return box.replaceChildren(h('div', { class: 'empty' }, 'Lade…'));
  if (!state.lists) return box.replaceChildren(h('div', { class: 'empty' }, '–'));
  const items = state.lists[state.tab] ?? [];
  const auto = state.s.settings.autoStartSource;
  if (state.tab === 'spotify' && !state.s.spotify.loggedIn) return box.replaceChildren(h('div', { class: 'empty' }, 'Erst rechts mit Spotify verbinden.'));
  if (state.tab === 'spotify' && state.lists.spotifyError) return box.replaceChildren(h('div', { class: 'empty' }, state.lists.spotifyError));
  if (!items.length) {
    return box.replaceChildren(h('div', { class: 'empty' }, state.tab === 'local' ? 'Keine Musik gefunden. Rechts einen Ordner einstellen – jeder Unterordner wird eine Playlist.' : 'Keine Playlists.'));
  }
  box.replaceChildren(...items.map((p) => h('div', { class: `pl${p.id === auto ? ' auto' : ''}` },
    h('div', { class: 'pl-img', style: p.image ? { backgroundImage: `url("${p.image}")` } : {} }, p.image ? '' : (p.provider === 'local' ? '📁' : '🎵')),
    h('div', { class: 'pl-main' }, h('div', { class: 'pl-name no-i18n', title: p.name }, p.name), h('div', { class: 'pl-count' }, `${p.count} Titel`)),
    h('button', { class: `icon-btn${p.id === auto ? ' on' : ''}`, title: 'Als Auto-Start nach dem Intro', onclick: () => call('settings', { autoStartSource: p.id }, `„${p.name}“ läuft nach dem Intro`) }, p.id === auto ? '★' : '☆'),
    h('button', { class: 'icon-btn', title: 'Jetzt abspielen', onclick: () => call('play', { source: p.id }) }, '▶'))));
}

// ============================================================ Music-Host

function renderHost() {
  const { host } = state.s;
  const open = async () => {
    try {
      const res = await api(`${BASE}/open-host`, {});
      toast(`Music-Host öffnet sich in ${res.browser}.`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  fill('#host',
    h('div', { class: 'status-list' },
      h('div', { class: 'line' }, h('span', { class: `dot ${host.connected ? 'ok' : 'err'}` }), host.connected ? `Offen${host.browser ? ` (${host.browser})` : ''}` : 'Nicht offen'),
      host.connected ? h('div', { class: 'line' }, h('span', { class: `dot ${host.audioUnlocked ? 'ok' : 'warn'}` }), host.audioUnlocked ? 'Ton freigegeben' : 'Ton blockiert – im Host-Fenster einmal klicken') : null,
      host.connected > 1 ? h('p', { class: 'warn-note' }, `⚠ ${host.connected} Host-Fenster offen – bitte nur eins.`) : null),
    h('button', { class: 'btn primary', onclick: open }, host.connected ? 'Noch ein Fenster öffnen' : '🖥 Music-Host öffnen'),
    h('p', { class: 'note' }, 'Öffnet ein eigenes Chrome- oder Edge-Fenster. Spotify braucht einen echten Browser – in OBS oder im Suite-Fenster geht es nicht. Das Fenster offen lassen (minimieren ist ok).'),
    h('details', {},
      h('summary', {}, h('span', { class: 'note' }, '📖 Ton in OBS einbinden')),
      h('ol', { class: 'howto' },
        h('li', {}, 'In OBS: Quelle hinzufügen → ', h('b', {}, 'Anwendungsaudioaufnahme'), '.'),
        h('li', {}, 'Fenster: ', h('b', {}, '„Music-Host – Stream Suite“'), ' (bzw. bei „Desktop-App fernsteuern“: die Spotify-App).'),
        h('li', {}, 'Ob die Musik im Twitch-VOD landet, stellst du in OBS unter ', h('i', {}, 'Erweiterte Audioeigenschaften'), ' bei den Spuren ein.'))),
    h('p', { class: 'note' }, 'Adresse (falls du es selbst öffnen willst):'),
    copyRow(host.url, 'Adresse'),
  );
}

// ============================================================ Spotify

function renderSpotify() {
  const { spotify, settings, clientIdFromEnv } = state.s;
  const idInput = h('input', { type: 'text', class: 'no-i18n', value: settings.spotify.clientId, placeholder: clientIdFromEnv ? 'kommt aus SPOTIFY_CLIENT_ID' : '32 Zeichen, aus dem Spotify Dashboard' });
  const deviceInput = h('input', { type: 'text', class: 'no-i18n', value: settings.spotify.deviceName });
  const connectInput = h('input', { type: 'text', class: 'no-i18n', value: settings.spotify.connectDeviceName, placeholder: 'leer = automatisch (Computer)' });
  const login = async () => {
    try {
      await api(`${BASE}/spotify/login`, {});
      toast('Im Browser hat sich Spotify geöffnet – dort bestätigen.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  const hasId = settings.spotify.clientId || clientIdFromEnv;

  fill('#spotify',
    spotify.loggedIn
      ? h('div', { class: 'status-list' },
        h('div', { class: 'line' }, h('span', { class: 'dot ok' }), `Verbunden${spotify.user ? ` als ${spotify.user.name}` : ''}`),
        h('div', { class: 'line' }, h('span', { class: `dot ${{ ready: 'ok', connecting: 'warn', failed: 'err' }[spotify.sdkState] ?? ''}` }),
          { ready: `Gerät „${settings.spotify.deviceName}“ bereit`, connecting: 'Gerät startet…', failed: `Gerät geht nicht: ${spotify.sdkError ?? ''}`, off: 'Gerät aus (Music-Host öffnen)' }[spotify.sdkState]))
      : h('p', { class: 'note' }, hasId ? 'Noch nicht verbunden.' : 'Für Spotify brauchst du eine eigene (kostenlose) Spotify-App – Anleitung unten.'),
    h('div', { class: 'btn-row' },
      spotify.loggedIn
        ? h('button', { class: 'btn small', onclick: () => call('spotify/logout', {}, 'Abgemeldet') }, 'Abmelden')
        : h('button', { class: 'btn primary', disabled: !hasId, onclick: login }, 'Mit Spotify verbinden')),
    h('div', { class: 'field' }, h('label', {}, 'Client-ID'), idInput),
    h('div', { class: 'field' }, h('label', {}, 'Gerätename der Suite'), deviceInput),
    h('div', { class: 'field' }, h('label', {}, 'Desktop-App fernsteuern: Gerät'), connectInput),
    h('button', { class: 'btn small', onclick: () => call('settings', { spotify: { clientId: idInput.value, deviceName: deviceInput.value, connectDeviceName: connectInput.value } }, 'Gespeichert') }, 'Speichern'),
    h('details', {},
      h('summary', {}, h('span', { class: 'note' }, '📖 Spotify-App anlegen (einmalig)')),
      h('ol', { class: 'howto' },
        h('li', {}, h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank' }, 'developer.spotify.com/dashboard'), ' öffnen, mit deinem Spotify-Account anmelden.'),
        h('li', {}, '„Create app“: Name frei wählbar, bei ', h('b', {}, 'Redirect URI'), ' genau diese Adresse eintragen:'),
        copyRow(spotify.redirectUri, 'Redirect URI'),
        h('li', {}, 'Bei „Which API/SDKs“: ', h('b', {}, 'Web API'), ' und ', h('b', {}, 'Web Playback SDK'), ' ankreuzen, speichern.'),
        h('li', {}, 'In den Einstellungen der App die ', h('b', {}, 'Client ID'), ' kopieren und oben eintragen.'),
        h('li', {}, 'Unter „User Management“ deinen eigenen Spotify-Account eintragen (Name + E-Mail).')),
      h('p', { class: 'note' }, 'Seit Februar 2026 gilt für solche Apps („Development Mode“): Spotify Premium nötig, höchstens 5 Nutzer, eine Client-ID pro Person.')),
  );
}

// ============================================================ Lokal

function renderLocal() {
  const { settings, library } = state.s;
  const dir = h('input', { type: 'text', class: 'no-i18n', value: settings.local.rootDir, placeholder: 'z.B. C:\\Users\\…\\Music\\Stream' });
  const fade = h('input', { type: 'number', min: 0, max: 15, step: 0.5, value: settings.local.crossfadeMs / 1000 });
  const total = library.reduce((s, p) => s + p.count, 0);
  fill('#local',
    h('div', { class: 'field' }, h('label', {}, 'Musik-Ordner'), dir),
    h('p', { class: 'note' }, 'Jeder Unterordner ist eine Playlist. MP3, FLAC, WAV, OGG. Titel und Cover kommen aus den Tags, sonst aus dem Dateinamen („Artist - Titel.mp3“).'),
    h('div', { class: 'field' }, h('label', {}, 'Überblenden (Sek.)'), fade),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small primary', onclick: () => call('settings', { local: { rootDir: dir.value, crossfadeMs: Number(fade.value) * 1000 } }, 'Gespeichert').then((ok) => ok && loadLists()) }, 'Speichern'),
      h('button', { class: 'btn small', onclick: () => call('library/rescan', {}, 'Ordner neu eingelesen').then((ok) => ok && loadLists()) }, '↻ Neu einlesen')),
    settings.local.rootDir ? h('p', { class: 'note' }, `${library.length} Playlist(s), ${total} Titel.`) : null,
  );
}

// ============================================================ Overlay

function renderOverlay() {
  const { overlayUrl, settings } = state.s;
  const corners = [['bottom-left', 'unten links'], ['bottom-right', 'unten rechts'], ['top-left', 'oben links'], ['top-right', 'oben rechts']];
  fill('#overlay',
    copyRow(overlayUrl, 'Adresse'),
    h('p', { class: 'note' }, 'In OBS als Browser-Quelle, z.B. 800 × 200. Erscheint bei jedem Titelwechsel – für alle Quellen (Spotify und eigene Musik).'),
    h('div', { class: 'f-row' },
      h('div', { class: 'field' }, h('label', {}, 'Sichtbar (Sek., 0 = immer)'),
        h('input', { type: 'number', min: 0, max: 600, value: settings.overlay.showSeconds, onchange: (e) => call('settings', { overlay: { showSeconds: Number(e.target.value) } }) })),
      h('div', { class: 'field' }, h('label', {}, 'Ecke'),
        h('select', { onchange: (e) => call('settings', { overlay: { corner: e.target.value } }) },
          ...corners.map(([v, l]) => h('option', { value: v, selected: v === settings.overlay.corner }, l))))),
    h('a', { class: 'link-btn', href: `${overlayUrl}?demo=1`, target: '_blank' }, 'Beispiel ansehen'),
  );
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

function render() {
  if (!state.s) return;
  renderHead();
  renderAutostart();
  renderLists();
  renderHost();
  renderSpotify();
  renderLocal();
  renderOverlay();
  renderLog();
}

// ============================================================ Live

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws?channel=music`);
  let reloadTimer = null;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    // Reiter „Musik-Sets“ und „Songwünsche“ hören mit
    window.dispatchEvent(new CustomEvent('music-msg', { detail: msg }));
    if (msg.type === 'system.log' && state.s) {
      state.s.log.unshift({ level: msg.level, message: msg.message, ts: msg.ts });
      state.s.log.length = Math.min(state.s.log.length, 50);
      renderLog();
    }
    // Zustand geändert (Host, Spotify-Gerät, Provider) → einmal gebündelt neu laden
    if (msg.type === 'music.state' || msg.type === 'system.log') {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 300);
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

$('#reload-lists').onclick = loadLists;

// Reiter: Player / Musik-Sets / Songwünsche (gemerkt in der Adresse, z.B. #requests)
function showTab(tab) {
  const known = ['player', 'sets', 'requests'];
  const current = known.includes(tab) ? tab : 'player';
  document.querySelectorAll('#page-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === current));
  document.querySelectorAll('[data-panel]').forEach((p) => {
    p.hidden = p.dataset.panel !== current;
  });
  window.dispatchEvent(new CustomEvent('music-tab', { detail: current }));
}
document.querySelectorAll('#page-tabs button').forEach((b) => {
  b.onclick = () => {
    history.replaceState(null, '', `#${b.dataset.tab}`);
    showTab(b.dataset.tab);
  };
});
showTab(location.hash.slice(1));
$('#log-clear').onclick = () => call('log/clear', {});

(async () => {
  await load();
  if (state.s && !state.s.spotify.loggedIn) state.tab = 'local';
  connect();
  window.MusicMini.mount($('#player'));
  loadLists();
  window.RemoteCard.render($('#remote'), [
    ['POST', '/api/music/play', 'abspielen (Body optional: { "source": … })'],
    ['POST', '/api/music/pause', 'Pause'],
    ['POST', '/api/music/toggle', 'Play/Pause umschalten'],
    ['POST', '/api/music/next', 'nächster Titel'],
    ['POST', '/api/music/previous', 'voriger Titel'],
    ['POST', '/api/music/volume', 'Body: { "volume": 0–100 } oder { "delta": ±n }'],
    ['POST', '/api/music/provider', 'Body: { "provider": "spotify-sdk" | "spotify-connect" | "local" }'],
    ['GET', '/api/music/now-playing', 'aktueller Titel'],
    ['GET', '/api/music/state', 'Zustand'],
  ]);
})();
