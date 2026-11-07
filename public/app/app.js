const { $, h, api, toast, toggle, icon } = window.UI;

const state = {
  status: null,
  addons: { installed: [], upcoming: [] },
  twitchKey: '',
  logKey: '',
};

/**
 * Event-Arten für Test-Knöpfe und den Event-Feed: Beschriftung, Lucide-Icon und Anfang der Log-Zeile
 * (Texte aus describe() in src/core/eventBus.ts; der Rest der Zeile wird zum Detail, z.B. der Name)
 */
const EVENT_KINDS = {
  follow: { label: 'Follow', icon: 'heart', re: /^follow von / },
  sub: { label: 'Sub', icon: 'star', re: /^sub von / },
  resub: { label: 'Resub', icon: 'star', re: /^resub von / },
  giftsub: { label: 'Gift-Subs', icon: 'gift', re: /^giftsub von / },
  cheer: { label: 'Cheer', icon: 'gem', re: /^cheer von / },
  raid: { label: 'Raid', icon: 'rocket', re: /^raid von / },
  redemption: { label: 'Kanalpunkte', icon: 'sparkles', re: /^redemption von / },
  hypetrain: { label: 'Hype Train', icon: 'train-front', re: /^Hype Train / },
  prediction: { label: 'Vorhersage', icon: 'wand-sparkles', re: /^Vorhersage / },
  shoutout: { label: 'Shoutout', icon: 'megaphone', re: /^Shoutout / },
  adbreak: { label: 'Werbung', icon: 'tv', re: /^Werbepause: / },
  poll: { label: 'Twitch-Umfrage', icon: 'chart-column', re: /^Twitch-Umfrage / },
  redemptionupdate: { label: 'Einlösung', icon: 'check', re: /^Einlösung / },
  online: { label: 'Stream ist live', icon: 'radio', re: /^Stream ist live\s*\S*/ },
  offline: { label: 'Stream beendet', icon: 'circle-stop', re: /^Stream beendet/ },
  channel: { label: 'Kanal geändert', icon: 'pencil-line', re: /^Kanal geändert: / },
};
const TEST_EVENTS = ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'redemption', 'hypetrain', 'prediction', 'shoutout', 'adbreak'];
const FEED_MAX = 8;

// Lucide-Icons (ISC) je eingebautem Addon; unbekannte IDs und Plugins behalten ihr Emoji
const ADDON_ICONS = {
  alerts: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>', // bell
  channelpoints: '<path d="M13.744 17.736a6 6 0 1 1-7.48-7.48"/><path d="M15 6h1v4"/><path d="m6.134 14.768.866-.5 2 3.464"/><circle cx="16" cy="8" r="6"/>', // coins
  queue: '<path d="M11 5h10"/><path d="M11 12h10"/><path d="M11 19h10"/><path d="M4 4h1v5"/><path d="M4 9h2"/><path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"/>', // list-ordered
  commands: '<rect width="18" height="18" x="3" y="3" rx="2"/><line x1="9" x2="15" y1="15" y2="9"/>', // square-slash
  timers: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>', // timer
  polls: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>', // chart-column
  predictions: '<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/>', // dices
  goals: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>', // flag
  lurk: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>', // eye
  shoutout: '<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"/><path d="M8 6v8"/>', // megaphone
  ads: '<path d="m17 2-5 5-5-5"/><rect width="20" height="15" x="2" y="7" rx="2"/>', // tv
  modguard: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>', // shield
  streaminfo: '<path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>', // pencil-line
  chat: '<path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/>', // messages-square
  intro: '<path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/>', // clapperboard
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', // music
  obs: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>', // video
  uwuclip: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>', // scissors
};

// Lucide-Icons (ISC) für die Shell selbst
const SHELL_ICONS = {
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>', // arrow-left
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>', // layout-grid
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>', // search
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', // house
  store: '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>', // puzzle
  settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>', // settings
  tools: '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>', // flask-conical
};

const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

/** Icon-Element aus Lucide-Pfaden */
function svgIcon(paths, cls = 'nav-icon') {
  const el = h('span', { class: cls, 'aria-hidden': 'true' });
  el.innerHTML = svg(paths);
  return el;
}

/** Icon eines Addons: Lucide-SVG für eingebaute Addons, sonst das Emoji aus dem Manifest */
function addonIcon(addon, cls) {
  const paths = !addon.plugin && ADDON_ICONS[addon.id];
  if (paths) return svgIcon(paths, cls);
  return h('span', { class: `${cls} emoji`, 'aria-hidden': 'true' }, addon.icon);
}

/** Gruppen auf dem Startbildschirm und im Store, in dieser Reihenfolge. Unbekannte Addons und Plugins landen in OTHER. */
const GROUPS = [
  ['Chat', ['chat', 'commands', 'timers', 'lurk', 'modguard']],
  ['Zuschauer-Interaktion', ['channelpoints', 'queue', 'polls', 'predictions', 'goals', 'shoutout']],
  ['Overlays & Show', ['alerts', 'intro', 'music', 'uwuclip']],
  ['Stream-Steuerung', ['streaminfo', 'obs', 'ads']],
];
const OTHER = 'Weitere Addons';
const GROUP_NAMES = [...GROUPS.map(([name]) => name), OTHER];
const ORDER = GROUPS.flatMap(([, ids]) => ids);
const groupOf = (a) => (!a.plugin && GROUPS.find(([, ids]) => ids.includes(a.id))?.[0]) || OTHER;
/** Addons nach Gruppe: [[Gruppenname, Addons], …], leere Gruppen fallen weg */
function grouped(list) {
  const rank = (a) => (a.plugin || !ORDER.includes(a.id) ? ORDER.length : ORDER.indexOf(a.id));
  return GROUP_NAMES
    .map((name) => [name, list.filter((a) => groupOf(a) === name).sort((x, y) => rank(x) - rank(y))])
    .filter(([, items]) => items.length);
}

/** Bereiche der Suite selbst (eigene Kacheln und Routen) */
const SUITE = [
  { view: 'store', name: 'Addon-Store', icon: SHELL_ICONS.store },
  { view: 'settings', name: 'Einstellungen', icon: SHELL_ICONS.settings, text: 'Twitch, Bot-Account, App und Sicherung' },
  { view: 'tools', name: 'Test & Log', icon: SHELL_ICONS.tools, text: 'Test-Events senden und sehen, was passiert' },
];
const VIEWS = ['overview', 'addon', ...SUITE.map((s) => s.view)];

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

/** Aktuelle Route: { view, id } aus #/overview, #/store, #/settings, #/tools, #/addon/<id> */
function currentRoute() {
  const [, view = 'overview', id] = (location.hash || '#/overview').split('/');
  return { view: VIEWS.includes(view) ? view : 'overview', id };
}

function route(event) {
  const { view, id } = currentRoute();
  let addon = null;
  if (view === 'addon') {
    addon = state.addons.installed.find((a) => a.id === id && a.active && a.settingsPage);
    if (!addon) {
      location.hash = '#/store';
      return;
    }
    const src = `/addons/${addon.id}/${addon.settingsPage}`;
    const frame = $('#addon-frame');
    if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
    frame.title = addon.name;
  }
  document.body.dataset.view = view;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${view}`));
  renderCrumbs(view, addon);
  if (view === 'overview') refreshDetails();
  if (event) {
    // Nach einem Wechsel startet der Screenreader/Tab im neuen Inhalt statt oben in der Leiste
    const main = $('#main');
    main.scrollTop = 0;
    main.focus({ preventScroll: true });
  }
}

/** Brotkrumen in der oberen Leiste: Start › Gruppe › Addon */
function renderCrumbs(view, addon) {
  const current = (text) => h('li', { 'aria-current': 'page' }, text);
  const items = view === 'overview'
    ? [current('Start')]
    : [h('li', {}, h('a', { class: 'crumb-home', href: '#/overview' }, svgIcon(SHELL_ICONS.back), 'Start')),
      ...(addon ? [h('li', {}, groupOf(addon)), current(addon.name)] : [current(SUITE.find((s) => s.view === view).name)])];
  $('#crumbs').replaceChildren(...items);
}

/** Startbildschirm: aktive Addons als Kacheln, nach Zweck gruppiert, dazu die Bereiche der Suite */
function renderAddonNav() {
  const withPage = state.addons.installed.filter((a) => a.active && a.settingsPage);
  state.details = {};
  const tile = (href, iconEl, name, text, id) => {
    const detail = h('span', { class: 'tile-detail' }, text);
    if (id) state.details[id] = { el: detail, text };
    return h('li', {}, h('a', { class: 'tile', href }, iconEl, h('span', { class: 'tile-name' }, name), detail));
  };
  const section = (name, i, tiles) => h('section', { class: 'tile-group', 'aria-labelledby': `group-${i}` },
    h('h2', { id: `group-${i}` }, name),
    h('ul', { class: 'tiles' }, tiles));

  const { installed } = state.addons;
  const suiteText = { store: `${installed.filter((a) => a.active).length} von ${installed.length} Addons aktiv` };
  $('#addon-nav').replaceChildren(
    ...(withPage.length
      ? grouped(withPage).map(([name, list], i) => section(name, i, list.map((a) => tile(`#/addon/${a.id}`, addonIcon(a, 'tile-icon'), a.name, a.description, a.id))))
      : [h('p', { class: 'nav-empty' }, 'Keine aktiven Addons. Im Addon-Store kannst du welche einschalten.')]),
    section('Suite', 'suite', SUITE.map((s) => tile(`#/${s.view}`, svgIcon(s.icon, 'tile-icon'), s.name, suiteText[s.view] ?? s.text))));
  refreshDetails();
}

/** Live-Angaben für einzelne Kacheln: [API-Pfad, Status → Text oder null (= Kurzbeschreibung)] */
const LIVE = {
  queue: ['state', (s) => (s.entries.length ? `${s.entries.length} in der Warteschlange` : 'Warteschlange ist leer')],
  lurk: ['state', (s) => (s.active.length ? `${s.active.length} im Lurk` : null)],
  polls: ['state', (s) => (s.active ? `Läuft: ${s.active.title}` : null)],
  obs: ['state', (s) => (s.status.state !== 'connected' ? 'Nicht mit OBS verbunden' : s.status.currentScene ? `Szene: ${s.status.currentScene}` : 'Mit OBS verbunden')],
  alerts: ['pause', (s) => (s.paused ? `Pausiert, ${s.held} warten` : null)],
  ads: ['state', (s) => {
    state.live = s.live === true;
    return null;
  }],
};

async function refreshDetails() {
  if (currentRoute().view !== 'overview' || !state.details) return;
  await Promise.all(Object.entries(state.details).map(async ([id, { el, text }]) => {
    if (!LIVE[id]) return;
    const [path, fn] = LIVE[id];
    const s = await api(`addons/${id}/${path}`).catch(() => null);
    if (!s) return;
    const next = fn(s) ?? text;
    if (el.textContent !== next) el.textContent = next;
  }));
  if (!state.details.ads) state.live = false;
  renderHomeStatus();
}

/** Begrüßung mit Nyu und Verbindungsstatus als ein Satz mit Aktion */
function renderHomeStatus() {
  if (!state.status) return;
  const { auth, eventsub } = state.status;
  const key = JSON.stringify(auth) + eventsub + state.live;
  if (key === state.homeKey) return;
  state.homeKey = key;

  const btn = (text, onclick, primary) => h('button', { class: `btn${primary ? ' primary' : ''}`, onclick }, text);
  const link = (text, href, primary) => h('a', { class: `btn${primary ? ' primary' : ''}`, href }, text);
  let mood = 'sleepy';
  let dot = 'err';
  let sentence;
  let actions = [];
  switch (auth.state) {
    case 'no-client-id':
      sentence = 'Die Suite braucht noch eine Twitch-Client-ID.';
      actions = [link('Einrichten', '#/settings', true)];
      break;
    case 'logged-out':
      sentence = 'Noch nicht mit Twitch verbunden. Ohne Verbindung kommen keine Events an.';
      actions = [btn('Mit Twitch verbinden', () => call('core/login/start', {}), true)];
      break;
    case 'pending':
      mood = 'puzzled';
      dot = 'warn';
      sentence = 'Im Browser hat sich Twitch geöffnet. Bestätige dort den Login. Falls nach einem Code gefragt wird:';
      actions = [h('span', { class: 'code-box no-i18n' }, auth.userCode),
        h('a', { class: 'btn', href: auth.verificationUri, target: '_blank' }, 'Seite erneut öffnen'),
        btn('Abbrechen', () => call('core/login/cancel', {}))];
      break;
    case 'error':
      mood = 'sad';
      sentence = auth.message;
      actions = [btn('Erneut verbinden', () => call('core/login/start', {}), true)];
      break;
    case 'logged-in':
      if (eventsub === 'connected') {
        mood = state.live ? 'cheer' : 'uwu';
        dot = 'ok';
        sentence = state.live ? 'Du bist live und alle Events kommen an.' : 'Mit Twitch verbunden, Events kommen an.';
        actions = [link('Test-Event senden', '#/tools')];
      } else if (eventsub === 'connecting') {
        mood = 'puzzled';
        dot = 'warn';
        sentence = 'Mit Twitch verbunden, die Events verbinden sich gerade …';
      } else {
        mood = 'sad';
        sentence = 'Mit Twitch verbunden, aber gerade kommen keine Events an.';
        actions = [link('Verbindung prüfen', '#/settings')];
      }
      break;
  }
  const name = auth.state === 'logged-in' ? auth.user.displayName : '';
  $('#hello').textContent = name ? `Hallo, ${name}!` : 'Hallo!';
  $('#nyu').innerHTML = window.NYU[mood];
  $('#home-status').replaceChildren(
    h('p', { class: 'hero-sentence' }, h('span', { class: `dot ${dot}` }), h('span', {}, sentence)),
    actions.length ? h('div', { class: 'btn-row' }, actions) : null);
}

// ---------------------------------------------------------------- Schnellwechsler (Strg+K)

const sw = { items: [], index: 0 };

function openSwitcher() {
  const dlg = $('#switcher');
  if (dlg.open) return;
  const here = location.hash || '#/overview';
  const entry = (href, iconEl, name, group) => {
    const li = h('li', { role: 'option', class: 'sw-item', 'aria-current': href === here ? 'page' : null, onclick: () => go(href) },
      iconEl, h('span', { class: 'sw-name' }, name), h('span', { class: 'sw-group' }, group));
    li.dataset.href = href;
    return li;
  };
  const addons = state.addons.installed.filter((a) => a.active && a.settingsPage);
  const lis = [
    entry('#/overview', svgIcon(SHELL_ICONS.home), 'Start', 'Suite'),
    ...grouped(addons).flatMap(([group, list]) => list.map((a) => entry(`#/addon/${a.id}`, addonIcon(a, 'nav-icon'), a.name, group))),
    ...SUITE.map((s) => entry(`#/${s.view}`, svgIcon(s.icon), s.name, 'Suite')),
  ];
  lis.forEach((li, i) => {
    li.id = `sw-${i}`;
    li.addEventListener('mousemove', () => setSwitch(sw.items.indexOf(li)));
  });
  $('#switch-list').replaceChildren(...lis, h('li', { class: 'sw-empty', role: 'presentation', hidden: true }, 'Nichts gefunden'));
  $('#switch-input').value = '';
  dlg.showModal();
  filterSwitch();
}

function filterSwitch() {
  // Gefiltert wird nach dem angezeigten (ggf. übersetzten) Text
  const q = $('#switch-input').value.trim().toLowerCase();
  const all = [...$('#switch-list').querySelectorAll('.sw-item')];
  all.forEach((li) => { li.hidden = !!q && !li.textContent.toLowerCase().includes(q); });
  sw.items = all.filter((li) => !li.hidden);
  $('#switch-list .sw-empty').hidden = sw.items.length > 0;
  const currentIndex = sw.items.findIndex((li) => li.hasAttribute('aria-current'));
  setSwitch(q || currentIndex < 0 ? 0 : currentIndex);
}

function setSwitch(index) {
  if (index < 0) return;
  sw.index = index;
  const input = $('#switch-input');
  sw.items.forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
  const active = sw.items[index];
  if (active) {
    input.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function go(href) {
  $('#switcher').close();
  location.hash = href;
}

$('#switch-input').addEventListener('input', filterSwitch);
$('#switch-input').addEventListener('keydown', (e) => {
  const n = sw.items.length;
  if (!n) return;
  if (e.key === 'ArrowDown') setSwitch((sw.index + 1) % n);
  else if (e.key === 'ArrowUp') setSwitch((sw.index - 1 + n) % n);
  else if (e.key === 'Home' && e.ctrlKey) setSwitch(0);
  else if (e.key === 'End' && e.ctrlKey) setSwitch(n - 1);
  else if (e.key === 'Enter') go(sw.items[sw.index].dataset.href);
  else return;
  e.preventDefault();
});
// Klick auf den abgedunkelten Hintergrund schließt
$('#switcher').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#switch-open').addEventListener('click', openSwitcher);
$('#switch-icon').innerHTML = svg(SHELL_ICONS.grid);
$('#switch-search-icon').innerHTML = svg(SHELL_ICONS.search);

/** Strg+K öffnet den Wechsler, auch wenn gerade ein Addon (iframe, gleiche Herkunft) den Fokus hat */
function shortcut(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSwitcher();
  }
}
document.addEventListener('keydown', shortcut);
$('#addon-frame').addEventListener('load', (e) => {
  try {
    e.target.contentWindow.addEventListener('keydown', shortcut);
  } catch { /* fremde Herkunft: kein Kürzel im Addon */ }
});

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
  const title = h('h2', {}, icon('plug'), ' Twitch-Verbindung');
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
          h('div', {}, h('strong', { class: 'no-i18n' }, u.displayName), h('div', { class: 'muted' }, `@${u.login}`))),
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

/** Kurzstatus oben rechts, führt zu den Einstellungen */
function renderSidebarStatus() {
  const { auth, eventsub } = state.status;
  const loggedIn = auth.state === 'logged-in';
  const [cls, text] = !loggedIn ? ['err', 'Twitch: nicht verbunden']
    : eventsub !== 'connected' ? ['warn', 'Events: verbinde…']
      : state.live ? ['ok', 'Live'] : ['ok', `Twitch: ${auth.user.displayName}`];
  if (state.topKey === cls + text) return;
  state.topKey = cls + text;
  $('#sidebar-status').replaceChildren(
    h('a', { href: '#/settings', title: 'Einstellungen' }, h('span', { class: `dot ${cls}` }), h('span', {}, text)));
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
  const title = h('h2', {}, icon('bot'), ' Bot-Account');
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
            h('button', { class: 'btn small', onclick: async () => { if (await botCall('/make-mod', {})) toast('Bot ist jetzt Mod', 'ok'); } }, icon('shield'), ' Zum Mod machen'))
          : h('span', { class: 'status-line muted' }, h('span', { class: 'dot' }), 'Mod-Status unbekannt');
      card.replaceChildren(title,
        h('div', { class: 'user-row' },
          u.avatar ? h('img', { class: 'avatar', src: u.avatar, alt: '' }) : null,
          h('div', {}, h('strong', { class: 'no-i18n' }, u.displayName), h('div', { class: 'muted' }, `@${u.login}`))),
        modLine,
        h('div', { class: 'opt-line' },
          toggle(bot.enabled, (on) => botCall('/settings', { enabled: on }), 'Bot schreibt die Nachrichten'),
          h('span', {}, bot.enabled ? 'Der Bot schreibt die Nachrichten der Suite' : 'Pausiert: dein eigener Account schreibt')),
        h('div', { class: 'opt-line' },
          toggle(bot.fallback, (on) => botCall('/settings', { fallback: on }), 'Notfalls eigener Account'),
          h('span', {}, 'Klappt es mit dem Bot nicht, notfalls mit deinem Account senden')),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', disabled: !bot.enabled, onclick: async () => { if (await botCall('/test', {})) toast('Test-Nachricht gesendet', 'ok'); } }, icon('message-circle'), ' Test-Nachricht'),
          h('button', { class: 'btn', onclick: () => botCall('/check-mod', {}) }, icon('rotate-cw'), ' Mod-Status prüfen'),
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
    h('h2', {}, icon('app-window'), ' App'),
    h('div', { class: 'opt-line' },
      toggle(d.autostart, (on) => loadDesktop({ autostart: on }), 'Mit Windows starten'),
      h('span', {}, 'Mit Windows starten (unsichtbar im Infobereich)')),
    d.autostartAvailable ? null : h('p', { class: 'muted small' }, 'Autostart geht nur in der installierten App, nicht beim Starten mit npm start.'),
    h('div', { class: 'opt-line' },
      toggle(d.closeToTray, (on) => loadDesktop({ closeToTray: on }), 'Beim Schließen weiterlaufen'),
      h('span', {}, 'X schließt nur das Fenster, die Suite läuft im Infobereich weiter')),
    h('p', { class: 'muted small' }, 'So bleiben Overlays, Commands und Bot aktiv, auch wenn das Fenster zu ist. Beenden: Rechtsklick auf das Symbol unten rechts.'),
    h('div', { class: 'opt-line no-i18n' },
      h('span', {}, icon('languages'), ' Sprache / Language'),
      ...[['de', 'Deutsch'], ['en', 'English']].map(([code, label]) => h('button', {
        class: `btn small${window.I18N.lang === code ? ' primary' : ''}`,
        onclick: () => {
          if (window.I18N.lang === code) return;
          window.I18N.setLang(code);
          location.reload();
        },
      }, label))),
    updateLine(),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => api('core/desktop/open-data', {}).catch((err) => toast(err.message, 'err')) }, icon('folder-open'), ' Datenordner öffnen'),
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
    idle: [icon('circle-check'), ' Du hast die neueste Version.'],
    checking: [icon('search'), ' Suche nach Updates…'],
    downloading: [icon('download'), ` Version ${u.version} wird geladen (${u.percent ?? 0} %)…`],
    ready: [icon('party-popper'), ` Version ${u.version} ist bereit. Wird beim Beenden installiert.`],
    error: [icon('triangle-alert'), ` ${u.message}`],
  }[u.state];
  return h('div', { class: 'opt-line' },
    h('span', { class: 'small', style: { flex: 1 } }, text),
    u.state === 'ready'
      ? h('button', { class: 'btn small primary', onclick: run('core/update/install') }, 'Jetzt neu starten')
      : h('button', { class: 'btn small', disabled: u.state === 'checking' || u.state === 'downloading', onclick: run('core/update/check') }, 'Nach Updates suchen'));
}

// ---------------------------------------------------------------- Sicherung (Export/Import)

async function loadBackup() {
  state.backup = await api('core/backup').catch(() => null);
  renderBackupCard();
}

function renderBackupCard() {
  const b = state.backup;
  state.backupWithFiles ??= true;
  const run = async (path, body) => {
    try {
      const result = await api(path, body);
      if (result.saved) toast(`Gesichert: ${result.addons.length} Addons, ${result.files} Dateien`, 'ok');
      if (result.imported) {
        toast('Sicherung eingespielt. Die Suite startet neu …', 'ok');
        return;
      }
    } catch (err) {
      toast(err.message, 'err');
    }
    loadBackup();
  };
  $('#backup-card').replaceChildren(
    h('h2', {}, icon('archive'), ' Sicherung'),
    h('p', { class: 'muted' }, 'Alle Einstellungen in eine Datei packen, z.B. für einen neuen PC, oder eine Sicherung wieder einspielen. Deine Twitch-Anmeldung ist nicht dabei.'),
    h('div', { class: 'opt-line' },
      toggle(state.backupWithFiles, (on) => { state.backupWithFiles = on; }, 'Dateien mitsichern'),
      h('span', {}, 'Hochgeladene Bilder und Sounds mitsichern')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: () => run('core/backup/export', { withFiles: state.backupWithFiles }) }, icon('download'), ' Sicherung speichern'),
      h('button', { class: 'btn', onclick: () => run('core/backup/import', {}) }, icon('upload'), ' Sicherung einspielen')),
    h('div', { class: 'opt-line' },
      h('span', { class: 'muted small', style: { flex: 1 } },
        b?.count ? `Automatisch: einmal am Tag (nur Einstellungen). ${b.count} Sicherung(en) im Ordner.` : 'Automatisch: einmal am Tag (nur Einstellungen).'),
      h('button', { class: 'btn small', onclick: () => api('core/backup/open-folder', {}).catch((err) => toast(err.message, 'err')) }, icon('folder-open'), ' Ordner')));
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
  renderHomeStatus();
}

// ---------------------------------------------------------------- Log

async function refreshLogs() {
  const logs = await api('core/logs').catch(() => null);
  if (!logs) return;
  const key = `${logs.length}:${logs.at(-1)?.time ?? 0}`;
  if (key === state.logKey) return;
  state.logKey = key;

  renderFeed(logs);
  const box = $('#log');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
  box.replaceChildren(...logs.map((entry) =>
    h('div', { class: entry.level },
      h('span', { class: 'muted' }, `${new Date(entry.time).toLocaleTimeString('de-DE')} `),
      h('span', { class: 'src' }, `[${entry.source}] `),
      entry.message)));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** Event-Feed auf dem Startbildschirm: die letzten Events aus dem Log, neueste oben */
function renderFeed(logs) {
  const list = $('#event-feed');
  const events = logs.filter((entry) => entry.source === 'Events').slice(-FEED_MAX);
  const seen = state.feedSeen ?? new Set();
  state.feedSeen = new Set(events.map((entry) => entry.time + entry.message));
  // Nur neue Zeilen oben einfügen, damit der Screenreader (role="log") nicht alles neu vorliest
  for (const entry of events) {
    const key = entry.time + entry.message;
    if (seen.has(key)) continue;
    const test = entry.message.startsWith('[Test] ');
    const text = test ? entry.message.slice(7) : entry.message;
    const [, kind = { label: 'Event', icon: 'zap', re: /^/ }] = Object.entries(EVENT_KINDS).find(([, k]) => k.re.test(text)) ?? [];
    const detail = text.replace(kind.re, '').trim();
    list.prepend(h('li', { class: 'feed-row' },
      h('span', { class: 'feed-icon', 'data-icon': kind.icon }),
      h('span', { class: 'feed-text' }, h('strong', {}, kind.label), detail ? h('span', { class: 'no-i18n' }, ` ${detail}`) : null),
      test ? h('span', { class: 'badge' }, 'Test') : null,
      h('time', { class: 'feed-time', datetime: new Date(entry.time).toISOString() },
        new Date(entry.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }))));
  }
  while (list.children.length > FEED_MAX) list.lastElementChild.remove();
  $('#feed-empty').hidden = list.children.length > 0;
}

// ---------------------------------------------------------------- Addon-Store

async function loadAddons() {
  try {
    [state.addons, state.plugins] = await Promise.all([api('core/addons'), api('core/plugins')]);
  } catch (err) {
    toast(err.message, 'err');
  }
  renderStore();
  renderAddonNav();
}

function renderStore() {
  const card = (addon) =>
    h('div', { class: 'card addon-card' },
      h('div', { class: 'top' },
        addonIcon(addon, 'addon-icon'),
        h('div', {}, h('strong', {}, addon.name), h('small', {}, `v${addon.version} · von ${addon.author}`, addon.plugin ? ' · Plugin' : ''))),
      h('p', { class: 'muted' }, addon.description),
      h('div', { class: 'bottom' },
        addon.active ? h('span', { class: 'badge ok' }, 'Aktiv') : h('span', { class: 'badge' }, 'Aus'),
        toggle(addon.enabled, async (enabled) => {
          const ok = await call('core/addons/toggle', { id: addon.id, enabled });
          if (ok) toast(`${addon.name} ${enabled ? 'aktiviert' : 'deaktiviert'}`, 'ok');
          await loadAddons();
        }, `${addon.name} aktivieren`)));

  const upcoming = state.addons.upcoming.map((addon) =>
    h('div', { class: 'card addon-card upcoming' },
      h('div', { class: 'top' },
        addonIcon(addon, 'addon-icon'),
        h('div', {}, h('strong', {}, addon.name), h('small', {}, `von ${addon.author}`))),
      h('p', { class: 'muted' }, addon.description),
      h('div', { class: 'bottom' }, h('span', { class: 'badge accent' }, 'Bald verfügbar'))));

  const section = (name, i, cards) => h('section', { class: 'tile-group', 'aria-labelledby': `store-group-${i}` },
    h('h2', { id: `store-group-${i}` }, name), h('div', { class: 'store-grid' }, cards));
  $('#store-grid').replaceChildren(
    ...grouped(state.addons.installed).map(([name, list], i) => section(name, i, list.map(card))),
    upcoming.length ? section('Bald verfügbar', 'soon', upcoming) : null);
  renderPluginBar();
}

// ---------------------------------------------------------------- Plugins

/** Hinweis auf den Plugin-Ordner + Plugins, die nicht geladen werden konnten */
function renderPluginBar() {
  const p = state.plugins;
  if (!p) return;
  const broken = p.plugins.filter((x) => x.error);
  $('#plugin-bar').replaceChildren(...[
    h('span', { class: 'muted small' }, icon('puzzle'), ' Plugins (Addons von außerhalb) kommen in den Plugin-Ordner und bleiben bei Updates erhalten. Danach die Suite neu starten.'),
    h('button', { class: 'btn small', onclick: () => api('core/plugins/open-folder', {}).catch((err) => toast(err.message, 'err')) }, icon('folder-open'), ' Plugin-Ordner öffnen'),
    ...broken.map((x) => h('div', { class: 'badge err' }, `Plugin „${x.folder}“: ${x.error}`)),
  ]);
}

// ---------------------------------------------------------------- Start

$('#test-buttons').replaceChildren(...TEST_EVENTS.map((type) =>
  h('button', { class: 'btn', onclick: async () => {
    if (await call('core/test-event', { type })) {
      toast(`Test-Event „${type}“ gesendet`, 'ok');
      refreshLogs();
    }
  } }, h('span', { 'data-icon': EVENT_KINDS[type].icon }), EVENT_KINDS[type].label)));

window.addEventListener('hashchange', route);

(async () => {
  await refreshStatus();
  await loadAddons();
  await loadDesktop();
  loadBackup();
  route();
  refreshLogs();
  setInterval(refreshStatus, 2000);
  setInterval(refreshLogs, 2000);
  setInterval(refreshDetails, 4000);
  setInterval(async () => {
    const before = JSON.stringify(state.update);
    state.update = await api('core/update').catch(() => state.update);
    if (JSON.stringify(state.update) !== before) renderDesktopCard();
  }, 5000);
})();
