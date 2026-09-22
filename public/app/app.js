const { $, h, api, toast, toggle } = window.UI;

const state = {
  status: null,
  addons: { installed: [], upcoming: [] },
  twitchKey: '',
  logKey: '',
};

const TEST_EVENTS = [
  ['follow', '💜 Follow'],
  ['sub', '⭐ Sub'],
  ['resub', '⭐ Resub'],
  ['giftsub', '🎁 Gift-Subs'],
  ['cheer', '💎 Cheer'],
  ['raid', '🚀 Raid'],
  ['redemption', '✨ Kanalpunkte'],
];

/** API-Aufruf mit Fehlermeldung als Toast. Gibt null zurück, wenn es schiefging. */
async function call(path, body) {
  try {
    const result = await api(path, body);
    await refreshStatus();
    return result;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

// ---------------------------------------------------------------- Navigation

function route() {
  const [, view = 'overview', id] = (location.hash || '#/overview').split('/');
  if (view === 'addon') {
    const addon = state.addons.installed.find((a) => a.id === id && a.active && a.settingsPage);
    if (!addon) {
      location.hash = '#/store';
      return;
    }
    const src = `/addons/${addon.id}/${addon.settingsPage}`;
    const frame = $('#addon-frame');
    if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
  }
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${view}`));
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === location.hash));
}

function renderAddonNav() {
  const withPage = state.addons.installed.filter((a) => a.active && a.settingsPage);
  $('#addon-nav').replaceChildren(
    ...(withPage.length
      ? withPage.map((a) => h('a', { href: `#/addon/${a.id}` }, h('span', {}, a.icon), ` ${a.name}`))
      : [h('div', { class: 'nav-empty' }, 'Keine aktiven Addons')]),
  );
}

// ---------------------------------------------------------------- Twitch-Verbindung

function eventsubBadge(status) {
  const map = {
    connected: ['ok', 'Events kommen an'],
    connecting: ['warn', 'Verbinde…'],
    disconnected: ['err', 'Nicht verbunden'],
  };
  const [cls, text] = map[status] ?? ['', status];
  return h('span', { class: 'status-line' }, h('span', { class: `dot ${cls}` }), text);
}

/** Eigene Client-ID eintragen (optional – die Suite bringt eine mit). current = eigene ID oder '' */
function clientIdSetup(current) {
  const input = h('input', { type: 'text', placeholder: 'leer = mitgelieferte Client-ID verwenden', value: current || '' });
  const save = async () => {
    if (await call('core/client-id', { clientId: input.value })) toast(input.value.trim() ? 'Eigene Client-ID gespeichert' : 'Mitgelieferte Client-ID wird verwendet', 'ok');
  };
  return [
    h('p', { class: 'muted' }, 'Nur für Fortgeschrittene: Die Suite bringt eine eigene Twitch-App mit, du musst hier nichts tun. Wenn du lieber deine eigene Twitch-App nutzen willst:'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Öffne die ', h('a', { href: 'https://dev.twitch.tv/console/apps/create', target: '_blank' }, 'Twitch Developer Console'), ' und logge dich ein.'),
      h('li', {}, 'Name: frei wählbar (das Wort „Twitch“ ist nicht erlaubt).'),
      h('li', {}, 'OAuth-Redirect-URL: ', h('code', {}, 'http://localhost')),
      h('li', {}, 'Kategorie: ', h('b', {}, 'Application Integration'), ', Client-Typ: ', h('b', {}, 'Öffentlich')),
      h('li', {}, 'Erstellen, dann bei der App auf „Verwalten“ und die ', h('b', {}, 'Client-ID'), ' kopieren.')),
    h('div', { class: 'field' }, h('label', {}, 'Eigene Client-ID'), input),
    h('p', { class: 'muted' }, 'Nach dem Ändern musst du dich (und den Bot) neu verbinden.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: save }, 'Speichern'),
      h('button', { class: 'btn', onclick: () => renderTwitchCard(true) }, 'Zurück')),
  ];
}

function renderTwitchCard(force = false) {
  const { auth, eventsub, clientId, customClientId } = state.status;
  const key = JSON.stringify(auth) + eventsub;
  if (!force && key === state.twitchKey) return;
  state.twitchKey = key;

  const card = $('#twitch-card');
  const title = h('h2', {}, 'Twitch-Verbindung');
  const changeId = h('button', { class: 'btn', onclick: () => card.replaceChildren(title, ...clientIdSetup(customClientId ? clientId : '')) }, customClientId ? 'Eigene Client-ID ändern' : 'Erweitert');

  switch (auth.state) {
    case 'no-client-id':
      card.replaceChildren(title, ...clientIdSetup(''));
      break;
    case 'logged-out':
      card.replaceChildren(title,
        h('p', { class: 'muted' }, 'Verbinde die Suite mit deinem Kanal, damit Events ankommen.'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', onclick: () => call('core/login/start', {}) }, 'Mit Twitch verbinden'),
          changeId));
      break;
    case 'pending':
      card.replaceChildren(title,
        h('p', {}, 'Im Browser hat sich Twitch geöffnet. Bestätige dort den Login. Falls nach einem Code gefragt wird:'),
        h('div', { class: 'code-box' }, auth.userCode),
        h('div', { class: 'btn-row' },
          h('a', { class: 'btn', href: auth.verificationUri, target: '_blank' }, 'Seite erneut öffnen'),
          h('button', { class: 'btn', onclick: () => call('core/login/cancel', {}) }, 'Abbrechen')));
      break;
    case 'logged-in': {
      const u = auth.user;
      card.replaceChildren(title,
        h('div', { class: 'user-row' },
          u.avatar ? h('img', { class: 'avatar', src: u.avatar, alt: '' }) : null,
          h('div', {}, h('strong', {}, u.displayName), h('div', { class: 'muted' }, `@${u.login}`))),
        eventsubBadge(eventsub),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => call('core/logout', {}) }, 'Abmelden')));
      break;
    }
    case 'error':
      card.replaceChildren(title,
        h('p', { class: 'badge err' }, auth.message),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', onclick: () => call('core/login/start', {}) }, 'Erneut verbinden'),
          changeId));
      break;
  }
}

function renderSidebarStatus() {
  const { auth, eventsub } = state.status;
  const loggedIn = auth.state === 'logged-in';
  $('#sidebar-status').replaceChildren(...[
    h('div', {}, h('span', { class: `dot ${loggedIn ? 'ok' : 'err'}` }), loggedIn ? `Twitch: ${auth.user.displayName}` : 'Twitch: nicht verbunden'),
    loggedIn ? h('div', {}, h('span', { class: `dot ${eventsub === 'connected' ? 'ok' : 'warn'}` }), eventsub === 'connected' ? 'Events: live' : 'Events: verbinde…') : null,
    state.status.bot ? h('div', {}, '🤖', `Bot: ${state.status.bot.displayName}`) : null,
    h('div', {}, `v${state.status.version}`),
  ].filter(Boolean));
}

// ---------------------------------------------------------------- Bot-Account

async function botCall(path, body) {
  try {
    state.bot = await api(`core/bot${path}`, body);
    renderBotCard(true);
    return true;
  } catch (err) {
    toast(err.message, 'err');
    return false;
  }
}

function renderBotCard(force = false) {
  const bot = state.bot;
  if (!bot) return;
  const mainLoggedIn = state.status?.auth.state === 'logged-in';
  const key = JSON.stringify(bot) + mainLoggedIn;
  if (!force && key === state.botKey) return;
  state.botKey = key;

  const card = $('#bot-card');
  const title = h('h2', {}, '🤖 Bot-Account');
  const intro = h('p', { class: 'muted' },
    'Optional: Ein zweiter Twitch-Account (z.B. „MinisBot“), der die Nachrichten der Suite schreibt: Commands, Timer, Umfragen, Lurk. Ohne Bot schreibt dein eigener Account.');

  switch (bot.auth.state) {
    case 'no-client-id':
    case 'logged-out':
      card.replaceChildren(title, intro,
        h('ol', { class: 'steps' },
          h('li', {}, 'Leg bei Twitch einen zweiten Account für den Bot an (falls noch nicht geschehen).'),
          h('li', {}, 'Klick auf „Bot verknüpfen“. Es öffnet sich ein eigenes Fenster: Dort mit dem ', h('b', {}, 'Bot-Account'), ' anmelden und bestätigen.'),
          h('li', {}, 'Mach den Bot zum Mod (geht danach mit einem Klick).')),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', disabled: !mainLoggedIn, onclick: () => botCall('/login/start', {}) }, 'Bot verknüpfen'),
          mainLoggedIn ? null : h('span', { class: 'muted' }, 'Erst oben deinen Kanal verbinden.')));
      break;
    case 'pending':
      card.replaceChildren(title,
        h('p', {}, 'Melde dich im geöffneten Fenster mit dem ', h('b', {}, 'Bot-Account'), ' an und bestätige. Falls nach einem Code gefragt wird:'),
        h('div', { class: 'code-box' }, bot.auth.userCode),
        h('p', { class: 'muted' }, 'Lieber im Browser? Öffne den Link in einem privaten Fenster, damit dein Hauptaccount angemeldet bleibt: ',
          h('code', {}, bot.auth.verificationUri)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => botCall('/login/window', {}) }, 'Fenster erneut öffnen'),
          h('button', { class: 'btn', onclick: () => botCall('/login/cancel', {}) }, 'Abbrechen')));
      break;
    case 'logged-in': {
      const u = bot.auth.user;
      const modLine = bot.isMod === true
        ? h('span', { class: 'status-line' }, h('span', { class: 'dot ok' }), 'Ist Mod in deinem Kanal')
        : bot.isMod === false
          ? h('div', { class: 'status-line' }, h('span', { class: 'dot warn' }), 'Noch kein Mod: schreibt langsamer, Links können blockiert werden.',
            h('button', { class: 'btn small', onclick: async () => { if (await botCall('/make-mod', {})) toast('Bot ist jetzt Mod', 'ok'); } }, '🛡 Zum Mod machen'))
          : h('span', { class: 'status-line muted' }, h('span', { class: 'dot' }), 'Mod-Status unbekannt');
      card.replaceChildren(title,
        h('div', { class: 'user-row' },
          u.avatar ? h('img', { class: 'avatar', src: u.avatar, alt: '' }) : null,
          h('div', {}, h('strong', {}, u.displayName), h('div', { class: 'muted' }, `@${u.login}`))),
        modLine,
        h('div', { class: 'opt-line' },
          toggle(bot.enabled, (on) => botCall('/settings', { enabled: on }), 'Bot schreibt die Nachrichten'),
          h('span', {}, bot.enabled ? 'Der Bot schreibt die Nachrichten der Suite' : 'Pausiert: dein eigener Account schreibt')),
        h('div', { class: 'opt-line' },
          toggle(bot.fallback, (on) => botCall('/settings', { fallback: on }), 'Notfalls eigener Account'),
          h('span', {}, 'Klappt es mit dem Bot nicht, notfalls mit deinem Account senden')),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', disabled: !bot.enabled, onclick: async () => { if (await botCall('/test', {})) toast('Test-Nachricht gesendet', 'ok'); } }, '💬 Test-Nachricht'),
          h('button', { class: 'btn', onclick: () => botCall('/check-mod', {}) }, '↻ Mod-Status prüfen'),
          h('button', { class: 'btn', onclick: () => { if (confirm('Bot-Account trennen?')) botCall('/logout', {}); } }, 'Trennen')));
      break;
    }
    case 'error':
      card.replaceChildren(title,
        h('p', { class: 'badge err' }, bot.auth.message),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', disabled: !mainLoggedIn, onclick: () => botCall('/login/start', {}) }, 'Erneut verknüpfen'),
          h('button', { class: 'btn', onclick: () => botCall('/logout', {}) }, 'Abbrechen')));
      break;
  }
}

// ---------------------------------------------------------------- App (Autostart, Tray)

async function loadDesktop(body) {
  try {
    [state.desktop, state.update] = await Promise.all([api('core/desktop', body), api('core/update')]);
  } catch (err) {
    toast(err.message, 'err');
  }
  renderDesktopCard();
}

function renderDesktopCard() {
  const d = state.desktop;
  if (!d) return;
  $('#desktop-card').replaceChildren(...[
    h('h2', {}, '🖥 App'),
    h('div', { class: 'opt-line' },
      toggle(d.autostart, (on) => loadDesktop({ autostart: on }), 'Mit Windows starten'),
      h('span', {}, 'Mit Windows starten (unsichtbar im Infobereich)')),
    d.autostartAvailable ? null : h('p', { class: 'muted small' }, 'Autostart geht nur in der installierten App, nicht beim Starten mit npm start.'),
    h('div', { class: 'opt-line' },
      toggle(d.closeToTray, (on) => loadDesktop({ closeToTray: on }), 'Beim Schließen weiterlaufen'),
      h('span', {}, 'X schließt nur das Fenster, die Suite läuft im Infobereich weiter')),
    h('p', { class: 'muted small' }, 'So bleiben Overlays, Commands und Bot aktiv, auch wenn das Fenster zu ist. Beenden: Rechtsklick auf das Symbol unten rechts.'),
    updateLine(),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => api('core/desktop/open-data', {}).catch((err) => toast(err.message, 'err')) }, '📁 Datenordner öffnen'),
      h('span', { class: 'muted small', style: { alignSelf: 'center' } }, `v${state.status?.version ?? ''}${d.packaged ? '' : ' · Entwicklermodus'}`))].filter(Boolean));
}

/** Zeile mit dem Update-Stand (GitHub Releases) */
function updateLine() {
  const u = state.update;
  if (!u || u.state === 'disabled') return null;
  const run = (path) => async () => {
    try {
      state.update = await api(path, {});
    } catch (err) {
      toast(err.message, 'err');
    }
    renderDesktopCard();
  };
  const text = {
    idle: '✅ Du hast die neueste Version.',
    checking: '🔎 Suche nach Updates…',
    downloading: `⬇ Version ${u.version} wird geladen (${u.percent ?? 0} %)…`,
    ready: `🎉 Version ${u.version} ist bereit. Wird beim Beenden installiert.`,
    error: `⚠ ${u.message}`,
  }[u.state];
  return h('div', { class: 'opt-line' },
    h('span', { class: 'small', style: { flex: 1 } }, text),
    u.state === 'ready'
      ? h('button', { class: 'btn small primary', onclick: run('core/update/install') }, 'Jetzt neu starten')
      : h('button', { class: 'btn small', disabled: u.state === 'checking' || u.state === 'downloading', onclick: run('core/update/check') }, 'Nach Updates suchen'));
}

async function refreshStatus() {
  try {
    [state.status, state.bot] = await Promise.all([api('core/status'), api('core/bot')]);
  } catch {
    return;
  }
  renderTwitchCard();
  renderBotCard();
  renderSidebarStatus();
}

// ---------------------------------------------------------------- Log

async function refreshLogs() {
  const logs = await api('core/logs').catch(() => null);
  if (!logs) return;
  const key = `${logs.length}:${logs.at(-1)?.time ?? 0}`;
  if (key === state.logKey) return;
  state.logKey = key;

  const box = $('#log');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
  box.replaceChildren(...logs.map((entry) =>
    h('div', { class: entry.level },
      h('span', { class: 'muted' }, `${new Date(entry.time).toLocaleTimeString('de-DE')} `),
      h('span', { class: 'src' }, `[${entry.source}] `),
      entry.message)));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- Addon-Store

async function loadAddons() {
  try {
    state.addons = await api('core/addons');
  } catch (err) {
    toast(err.message, 'err');
  }
  renderStore();
  renderAddonNav();
}

function renderStore() {
  const installed = state.addons.installed.map((addon) =>
    h('div', { class: 'card addon-card' },
      h('div', { class: 'top' },
        h('div', { class: 'addon-icon' }, addon.icon),
        h('div', {}, h('strong', {}, addon.name), h('small', {}, `v${addon.version} · von ${addon.author}`))),
      h('p', { class: 'muted' }, addon.description),
      h('div', { class: 'bottom' },
        addon.active ? h('span', { class: 'badge ok' }, 'Aktiv') : h('span', { class: 'badge' }, 'Aus'),
        toggle(addon.enabled, async (enabled) => {
          const ok = await call('core/addons/toggle', { id: addon.id, enabled });
          if (ok) toast(`${addon.name} ${enabled ? 'aktiviert' : 'deaktiviert'}`, 'ok');
          await loadAddons();
        }, `${addon.name} aktivieren`))));

  const upcoming = state.addons.upcoming.map((addon) =>
    h('div', { class: 'card addon-card upcoming' },
      h('div', { class: 'top' },
        h('div', { class: 'addon-icon' }, addon.icon),
        h('div', {}, h('strong', {}, addon.name), h('small', {}, `von ${addon.author}`))),
      h('p', { class: 'muted' }, addon.description),
      h('div', { class: 'bottom' }, h('span', { class: 'badge accent' }, 'Bald verfügbar'))));

  $('#store-grid').replaceChildren(...installed, ...upcoming);
}

// ---------------------------------------------------------------- Start

$('#test-buttons').replaceChildren(...TEST_EVENTS.map(([type, label]) =>
  h('button', { class: 'btn', onclick: async () => {
    if (await call('core/test-event', { type })) toast(`Test-Event „${type}“ gesendet`, 'ok');
  } }, label)));

window.addEventListener('hashchange', route);

(async () => {
  await refreshStatus();
  await loadAddons();
  await loadDesktop();
  route();
  refreshLogs();
  setInterval(refreshStatus, 2000);
  setInterval(refreshLogs, 2000);
  setInterval(async () => {
    const before = JSON.stringify(state.update);
    state.update = await api('core/update').catch(() => state.update);
    if (JSON.stringify(state.update) !== before) renderDesktopCard();
  }, 5000);
})();
