// Mini's Chat – ersetzt im eigenen Kanal die Nachrichtenliste von Twitch durch einen eigenen Chat
// mit 7TV/BTTV/FFZ-Emotes, Markdown und Farben. Das Eingabefeld von Twitch bleibt erhalten.
//
// Nachrichten kommen direkt aus dem Twitch-Chat (anonym, nur lesen) – ein Login ist nicht nötig.
// Sicherheit: Alles aus dem Chat landet nur als Text im DOM (siehe render.js).
(() => {
  if (window.__minisChatLoaded) return;
  window.__minisChatLoaded = true;

  const CONFIG = globalThis.MSS_CONFIG ?? {
    channel: 'minifyx',
    markdown: { enabled: true, minRole: 'everyone' },
    colors: { enabled: true, minRole: 'subscriber' },
    hiddenRewardIds: [],
  };
  const ext = globalThis.browser ?? globalThis.chrome;
  const MAX_ITEMS = 250;
  const HIDE_CLASS = 'mss-hidden-twitch-chat';
  const R = window.ChatRender;

  // ============================================================ Einstellungen (pro Zuschauer)

  const DEFAULT_PREFS = { enabled: true, timestamps: false, badges: true, fontSize: 13, seventv: true, bttv: true, ffz: true };
  let prefs = { ...DEFAULT_PREFS };

  async function loadPrefs() {
    try {
      if (ext?.storage?.local) {
        const data = await ext.storage.local.get('mss');
        return { ...DEFAULT_PREFS, ...(data?.mss ?? {}) };
      }
    } catch { /* weiter mit localStorage */ }
    try {
      return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('mss-prefs') || '{}') };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  async function savePrefs() {
    try {
      if (ext?.storage?.local) return void (await ext.storage.local.set({ mss: prefs }));
    } catch { /* weiter mit localStorage */ }
    try {
      localStorage.setItem('mss-prefs', JSON.stringify(prefs));
    } catch { /* egal */ }
  }

  /** JSON laden – über den Hintergrund-Teil der Erweiterung (dort gelten deren Berechtigungen) */
  async function fetchJson(url) {
    try {
      if (ext?.runtime?.sendMessage) {
        const res = await ext.runtime.sendMessage({ type: 'fetchJson', url });
        return res?.ok ? res.data : null;
      }
    } catch { /* Fallback: direkt */ }
    try {
      const res = await fetch(url);
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  // ============================================================ Emotes & Abzeichen

  const assets = { badges: {}, emotes: {}, broadcaster: CONFIG.channel };
  let assetsFor = null;

  async function loadAssets(roomId) {
    if (assetsFor === roomId) return;
    assetsFor = roomId;
    const badges = {};
    const addBadges = (list) => {
      for (const set of list ?? []) {
        badges[set.set_id] ??= {};
        for (const v of set.versions ?? []) badges[set.set_id][v.id] = v.image_url_2x || v.image_url_1x;
      }
    };
    const emotes = {};
    const jobs = [
      fetchJson('https://api.ivr.fi/v2/twitch/badges/global').then(addBadges),
      fetchJson(`https://api.ivr.fi/v2/twitch/badges/channel?id=${roomId}`).then(addBadges),
    ];
    if (prefs.ffz) {
      const addFfz = (sets) => {
        for (const set of Object.values(sets ?? {})) {
          for (const e of set.emoticons ?? []) {
            const url = e.urls?.['2'] ?? e.urls?.['1'];
            if (url) emotes[e.name] = url.startsWith('//') ? `https:${url}` : url;
          }
        }
      };
      jobs.push(fetchJson('https://api.frankerfacez.com/v1/set/global').then((d) => d && addFfz(
        Object.fromEntries(Object.entries(d.sets ?? {}).filter(([id]) => (d.default_sets ?? []).includes(Number(id)))))));
      jobs.push(fetchJson(`https://api.frankerfacez.com/v1/room/id/${roomId}`).then((d) => addFfz(d?.sets)));
    }
    if (prefs.bttv) {
      const addBttv = (list) => { for (const e of list ?? []) emotes[e.code] = `https://cdn.betterttv.net/emote/${e.id}/2x`; };
      jobs.push(fetchJson('https://api.betterttv.net/3/cached/emotes/global').then(addBttv));
      jobs.push(fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`).then((d) => addBttv([...(d?.channelEmotes ?? []), ...(d?.sharedEmotes ?? [])])));
    }
    if (prefs.seventv) {
      const add7tv = (list) => { for (const e of list ?? []) if (e.data?.host?.url) emotes[e.name] = `https:${e.data.host.url}/2x.webp`; };
      jobs.push(fetchJson('https://7tv.io/v3/emote-sets/global').then((d) => add7tv(d?.emotes)));
      jobs.push(fetchJson(`https://7tv.io/v3/users/twitch/${roomId}`).then((d) => add7tv(d?.emote_set?.emotes)));
    }
    await Promise.all(jobs.map((j) => j.catch(() => {})));
    assets.badges = badges;
    assets.emotes = emotes;
    R.setAssets(assets);
    systemLine(`✨ Mini's Chat aktiv: ${Object.keys(emotes).length} Emotes von 7TV, BTTV & FFZ geladen.`);
  }

  // ============================================================ Twitch-Chat mitlesen (IRC über WebSocket, anonym)

  function unescapeTag(v) {
    return v.replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' }[c] ?? c));
  }

  function parseIrc(line) {
    const msg = { tags: {}, prefix: '', command: '', params: [] };
    let rest = line;
    if (rest.startsWith('@')) {
      const sp = rest.indexOf(' ');
      for (const pair of rest.slice(1, sp).split(';')) {
        const eq = pair.indexOf('=');
        msg.tags[eq < 0 ? pair : pair.slice(0, eq)] = eq < 0 ? '' : unescapeTag(pair.slice(eq + 1));
      }
      rest = rest.slice(sp + 1);
    }
    if (rest.startsWith(':')) {
      const sp = rest.indexOf(' ');
      msg.prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }
    const t = rest.indexOf(' :');
    let trailing = null;
    if (t >= 0) {
      trailing = rest.slice(t + 2);
      rest = rest.slice(0, t);
    }
    const parts = rest.split(' ').filter(Boolean);
    msg.command = parts.shift() ?? '';
    msg.params = trailing === null ? parts : [...parts, trailing];
    return msg;
  }

  let ws = null;
  let wsChannel = null;
  let retry = 2000;
  let reconnectTimer = null;

  function connect(channel) {
    disconnect();
    wsChannel = channel;
    setStatus('Verbinde mit dem Chat…');
    const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws = socket;
    socket.onopen = () => {
      socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      socket.send('PASS SCHMOOPIIE');
      socket.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      socket.send(`JOIN #${channel}`);
    };
    socket.onmessage = (e) => {
      for (const line of String(e.data).split('\r\n')) if (line) handleLine(line);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      setStatus('Verbindung weg – neuer Versuch…');
      reconnectTimer = setTimeout(() => wsChannel && connect(wsChannel), retry);
      retry = Math.min(retry * 2, 30000);
    };
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    const socket = ws;
    ws = null;
    wsChannel = null;
    socket?.close();
  }

  // ============================================================ IRC → Chat-Einträge

  const PLAN = { '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3', Prime: 'Prime' };

  function badgesOf(tags) {
    return (tags.badges || '').split(',').filter(Boolean).map((b) => {
      const [set, id] = b.split('/');
      return { set, id };
    });
  }

  function levelOf(badges) {
    const sets = badges.map((b) => b.set);
    if (sets.includes('broadcaster')) return 4;
    if (sets.includes('moderator') || sets.includes('lead_moderator')) return 3;
    if (sets.includes('vip')) return 2;
    if (sets.includes('subscriber') || sets.includes('founder')) return 1;
    return 0;
  }

  /** Text + Emote-Positionen → Teile (Positionen zählen in Unicode-Zeichen, nicht in JS-Einheiten) */
  function fragmentsOf(text, emotesTag) {
    const chars = Array.from(text);
    const ranges = [];
    for (const part of (emotesTag || '').split('/')) {
      const [id, positions] = part.split(':');
      if (!positions) continue;
      for (const r of positions.split(',')) {
        const [s, e] = r.split('-').map(Number);
        ranges.push({ id, s, e });
      }
    }
    ranges.sort((a, b) => a.s - b.s);
    const out = [];
    let i = 0;
    const pushText = (t) => {
      for (const piece of t.split(/(@[\w]+)/)) {
        if (!piece) continue;
        out.push(/^@\w+$/.test(piece) ? { type: 'mention', text: piece } : { type: 'text', text: piece });
      }
    };
    for (const r of ranges) {
      if (r.s < i || r.e >= chars.length) continue;
      if (r.s > i) pushText(chars.slice(i, r.s).join(''));
      out.push({ type: 'emote', text: chars.slice(r.s, r.e + 1).join(''), emoteId: r.id });
      i = r.e + 1;
    }
    if (i < chars.length) pushText(chars.slice(i).join(''));
    return out;
  }

  function messageItem(tags, text, prefixLogin = '') {
    let action = false;
    if (text.startsWith('ACTION ') && text.endsWith('')) {
      action = true;
      text = text.slice(8, -1);
    }
    const badges = badgesOf(tags);
    // Bei PRIVMSG steht der Login im Absender (nick!nick@…), bei USERNOTICE im Tag "login"
    const login = tags.login || prefixLogin;
    return {
      kind: 'message',
      id: tags.id || `m${Date.now()}${Math.random()}`,
      time: Number(tags['tmi-sent-ts']) || Date.now(),
      user: { id: tags['user-id'] || '', login, name: tags['display-name'] || login },
      color: tags.color || '',
      badges,
      level: levelOf(badges),
      fragments: fragmentsOf(text, tags.emotes),
      rewardId: tags['custom-reward-id'] || null,
      hiddenReward: !!tags['custom-reward-id'] && CONFIG.hiddenRewardIds.includes(tags['custom-reward-id']),
      highlighted: tags['msg-id'] === 'highlighted-message',
      replyTo: tags['reply-parent-display-name'] || null,
      own: false,
      test: false,
      action,
      firstMessage: tags['first-msg'] === '1',
      bits: Number(tags.bits) || 0,
    };
  }

  const eventItem = (event, icon, text, user, detail = '') => ({
    kind: 'event', id: `e${Date.now()}${Math.random()}`, time: Date.now(), event, icon, text, user, detail, hiddenReward: false, test: false,
  });

  function handleLine(line) {
    const msg = parseIrc(line);
    const { tags } = msg;
    switch (msg.command) {
      case 'PING':
        ws?.send(`PONG :${msg.params[0] ?? 'tmi.twitch.tv'}`);
        break;
      case 'RECONNECT':
        ws?.close();
        break;
      case '366': // Beitritt fertig
        retry = 2000;
        setStatus('');
        break;
      case 'ROOMSTATE':
        if (tags['room-id']) void loadAssets(tags['room-id']);
        break;
      case 'PRIVMSG': {
        const item = messageItem(tags, msg.params[1] ?? '', msg.prefix.split('!')[0]);
        if (item.bits) add(eventItem('cheer', '💎', `{user} cheert ${item.bits} Bits`, item.user.name));
        add(item);
        break;
      }
      case 'USERNOTICE':
        handleUserNotice(tags, msg.params[1] ?? '');
        break;
      case 'CLEARMSG':
        markDeleted((i) => i.id === tags['target-msg-id']);
        break;
      case 'CLEARCHAT':
        if (tags['target-user-id']) markDeleted((i) => i.user.id === tags['target-user-id']);
        else {
          markDeleted(() => true);
          systemLine('🧹 Der Chat wurde von einem Mod geleert.');
        }
        break;
    }
  }

  function handleUserNotice(tags, text) {
    const name = tags['display-name'] || tags.login || 'Jemand';
    const plan = PLAN[tags['msg-param-sub-plan']] ?? '';
    switch (tags['msg-id']) {
      case 'sub':
        add(eventItem('sub', '⭐', `{user} hat abonniert (${plan})`, name));
        break;
      case 'resub':
        add(eventItem('resub', '⭐', `{user} ist seit ${tags['msg-param-cumulative-months'] || '?'} Monaten dabei (${plan})`, name));
        break;
      case 'subgift':
        // Teil eines Massen-Geschenks → steht schon in der Sammelmeldung
        if (tags['msg-param-community-gift-id']) return;
        add(eventItem('giftsub', '🎁', `{user} verschenkt ein Abo an ${tags['msg-param-recipient-display-name'] || 'jemanden'}`, name));
        break;
      case 'submysterygift': {
        const count = Number(tags['msg-param-mass-gift-count']) || 1;
        const giver = tags.login === 'ananonymousgifter' ? 'Jemand Anonymes' : name;
        add(eventItem('giftsub', '🎁', `{user} verschenkt ${count} ${count === 1 ? 'Abo' : 'Abos'} an die Community!`, giver));
        break;
      }
      case 'raid':
        add(eventItem('raid', '🚀', `{user} raidet mit ${tags['msg-param-viewerCount'] || '?'} Leuten!`, tags['msg-param-displayName'] || name));
        break;
      case 'announcement': {
        const item = messageItem(tags, text);
        item.highlighted = true;
        item.announcement = true;
        add(item);
        return;
      }
      default:
        if (tags['system-msg']) add(eventItem('info', 'ℹ️', tags['system-msg'].replace(/\{user\}/g, name), ''));
    }
    // Nachricht, die zum Event gehört (z.B. Resub-Text)
    if (text) add(messageItem(tags, text));
  }

  // ============================================================ Oberfläche (im Shadow DOM, unabhängig von Twitchs Styles)

  const UI_CSS = `
    :host { all: initial; }
    .mss { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative;
      font-family: Inter, Roobert, "Helvetica Neue", Arial, sans-serif; color: var(--mss-text); background: var(--mss-bg);
      --mss-text: #efeff1; --mss-muted: #adadb8; --mss-bg: #18181b; --mss-hover: rgba(255,255,255,.06); --mss-line: #2f2f35; --mss-accent: #9146ff; }
    .mss.light { --mss-text: #0e0e10; --mss-muted: #53535f; --mss-bg: #ffffff; --mss-hover: rgba(0,0,0,.05); --mss-line: #e5e5ea; }
    .mss-head { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--mss-line); font-size: 12px; font-weight: 700; flex: none; }
    .mss-head .grow { flex: 1; }
    .mss-btn { background: none; border: 1px solid transparent; color: var(--mss-muted); font: inherit; font-weight: 600; padding: 2px 7px; border-radius: 5px; cursor: pointer; }
    .mss-btn:hover { color: var(--mss-text); background: var(--mss-hover); }
    .mss-btn.on { color: #bf94ff; border-color: rgba(145,70,255,.5); }
    .mss-settings { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--mss-line); font-size: 12px; flex: none; }
    .mss-list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; font-size: var(--mss-size, 13px); line-height: 1.5; padding: 4px 0 8px; }
    .mss-list .cr-item { padding: 3px 10px; overflow-wrap: anywhere; }
    .mss-list .cr-item:hover { background: var(--mss-hover); }
    .mss-list .cr-time { color: var(--mss-muted); font-size: .85em; margin-right: .4em; }
    .mss-list .cr-name { cursor: pointer; }
    .mss-list .cr-name:hover { text-decoration: underline; }
    .mss-list .cr-highlighted { background: rgba(145,70,255,.15); box-shadow: inset 3px 0 0 var(--mss-accent); }
    .mss-list .mss-mention { background: rgba(255,80,80,.18); box-shadow: inset 3px 0 0 #ff5c5c; }
    .mss-list .mss-first { box-shadow: inset 3px 0 0 #00c8af; }
    .mss-list .mss-note { display: block; font-size: .8em; color: var(--mss-muted); }
    .mss-list .cr-action .cr-text { font-style: italic; }
    .mss-list .cr-deleted-note { color: var(--mss-muted); }
    .mss-list .cr-event { margin: 3px 6px; border-radius: 6px; padding: 5px 9px; background: rgba(145,70,255,.1); box-shadow: inset 3px 0 0 var(--cr-ev, #9146ff); }
    .cr-ev-sub, .cr-ev-resub { --cr-ev: #ffd700; } .cr-ev-giftsub { --cr-ev: #ff6bd6; } .cr-ev-cheer { --cr-ev: #35d0ff; }
    .cr-ev-raid { --cr-ev: #ff9f43; } .cr-ev-info { --cr-ev: #adadb8; }
    .mss-more { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); background: var(--mss-accent); color: #fff; border: 0; border-radius: 99px;
      padding: 5px 14px; font: 600 12px Inter, Arial, sans-serif; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.4); }
    .mss-status { font-size: 11px; color: var(--mss-muted); padding: 2px 10px; flex: none; }
    .mss.collapsed .mss-list, .mss.collapsed .mss-settings, .mss.collapsed .mss-status, .mss.collapsed .mss-more { display: none; }
    .mss.collapsed { background: transparent; }
    [hidden] { display: none !important; }
  `;

  let host = null;
  let ui = null;
  let items = [];
  let paused = false;
  let unseen = 0;
  const viewerLogin = (document.cookie.match(/(?:^|; )login=([^;]+)/)?.[1] ?? '').toLowerCase();

  function buildUi() {
    host = document.createElement('div');
    host.className = 'mss-host';
    const shadow = host.attachShadow({ mode: 'open' });
    R.setStyleTarget(shadow);
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const root = el('div', 'mss');
    const head = el('div', 'mss-head');
    const title = el('span', '', "✨ Mini's Chat");
    const settingsBtn = el('button', 'mss-btn', '⚙');
    settingsBtn.title = 'Einstellungen';
    const switchBtn = el('button', 'mss-btn', '');
    head.append(title, el('span', 'grow'), settingsBtn, switchBtn);
    const settings = el('div', 'mss-settings');
    settings.hidden = true;
    const list = el('div', 'mss-list');
    const more = el('button', 'mss-more', '⏬ Neue Nachrichten');
    more.hidden = true;
    const status = el('div', 'mss-status', '');
    root.append(head, settings, list, more, status);
    shadow.append(style, root);
    ui = { root, list, more, status, settings, settingsBtn, switchBtn, el };

    settingsBtn.onclick = () => {
      settings.hidden = !settings.hidden;
      settingsBtn.classList.toggle('on', !settings.hidden);
    };
    switchBtn.onclick = async () => {
      prefs.enabled = !prefs.enabled;
      await savePrefs();
      applyMode();
    };
    more.onclick = scrollToBottom;
    list.addEventListener('scroll', () => {
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      paused = !atBottom;
      if (atBottom) {
        unseen = 0;
        more.hidden = true;
      }
    });
    renderSettings();
  }

  function renderSettings() {
    const { settings, el } = ui;
    const toggleBtn = (label, key, reloadAssets = false) => {
      const b = el('button', `mss-btn${prefs[key] ? ' on' : ''}`, label);
      b.onclick = async () => {
        prefs[key] = !prefs[key];
        await savePrefs();
        renderSettings();
        if (reloadAssets && assetsFor) {
          const room = assetsFor;
          assetsFor = null;
          await loadAssets(room);
        }
        renderAll();
      };
      return b;
    };
    const size = (delta, label) => {
      const b = el('button', 'mss-btn', label);
      b.onclick = async () => {
        prefs.fontSize = Math.max(10, Math.min(24, prefs.fontSize + delta));
        await savePrefs();
        renderAll();
      };
      return b;
    };
    settings.replaceChildren(
      toggleBtn('🕘 Uhrzeit', 'timestamps'), toggleBtn('🏷 Abzeichen', 'badges'),
      toggleBtn('7TV', 'seventv', true), toggleBtn('BTTV', 'bttv', true), toggleBtn('FFZ', 'ffz', true),
      size(-1, 'A−'), size(1, 'A+'));
  }

  function applyMode() {
    const list = findTwitchList();
    ui.root.classList.toggle('collapsed', !prefs.enabled);
    host.classList.toggle('mss-collapsed', !prefs.enabled);
    list?.classList.toggle(HIDE_CLASS, prefs.enabled);
    ui.switchBtn.textContent = prefs.enabled ? '↺ Twitch-Chat' : "✨ Mini's Chat anzeigen";
    ui.switchBtn.title = prefs.enabled ? 'Zum normalen Twitch-Chat wechseln' : "Wieder Mini's Chat mit 7TV/BTTV/FFZ anzeigen";
    ui.root.classList.toggle('light', document.documentElement.classList.contains('tw-root--theme-light'));
    if (prefs.enabled) scrollToBottom();
  }

  function setStatus(text) {
    if (ui) ui.status.textContent = text;
  }

  // ------------------------------------------------------------ Einträge

  const settingsForRender = { markdown: CONFIG.markdown, colors: CONFIG.colors };

  function isMention(item) {
    if (!viewerLogin || item.user.login === viewerLogin) return false;
    return R.plainText(item).toLowerCase().includes(`@${viewerLogin}`);
  }

  function build(item) {
    if (item.kind === 'event') return R.event(item);
    const node = R.message(item, {
      settings: settingsForRender,
      showBadges: prefs.badges,
      timestamps: prefs.timestamps,
      deletedText: '‹Nachricht gelöscht›',
      darkBackground: !ui.root.classList.contains('light'),
    });
    if (item.action) {
      node.classList.add('cr-action');
      node.querySelector('.cr-text').style.color = node.querySelector('.cr-name').style.color;
      node.querySelector('.cr-colon').textContent = ' ';
    }
    if (isMention(item)) node.classList.add('mss-mention');
    if (item.firstMessage) {
      node.classList.add('mss-first');
      node.prepend(ui.el('span', 'mss-note', '👋 Erste Nachricht im Kanal'));
    }
    if (item.announcement) node.prepend(ui.el('span', 'mss-note', '📣 Ankündigung'));
    if (item.rewardId) node.prepend(ui.el('span', 'mss-note', '✨ Kanalpunkte-Belohnung'));
    // Klick auf den Namen: @name ins Twitch-Eingabefeld
    node.querySelector('.cr-name')?.addEventListener('click', () => insertIntoTwitchInput(`@${item.user.login || item.user.name} `));
    return node;
  }

  function visible(item) {
    return !item.hiddenReward;
  }

  function renderAll() {
    if (!ui) return;
    ui.list.style.setProperty('--mss-size', `${prefs.fontSize}px`);
    ui.list.replaceChildren(...items.filter(visible).map(build));
    scrollToBottom();
  }

  function add(item) {
    items.push(item);
    if (items.length > MAX_ITEMS) {
      items.shift();
      if (ui && ui.list.children.length > MAX_ITEMS) ui.list.firstElementChild.remove();
    }
    if (!ui || !visible(item)) return;
    ui.list.append(build(item));
    if (paused) {
      unseen++;
      ui.more.hidden = false;
      ui.more.textContent = `⏬ ${unseen} neue ${unseen === 1 ? 'Nachricht' : 'Nachrichten'}`;
    } else {
      ui.list.scrollTop = ui.list.scrollHeight;
    }
  }

  function systemLine(text) {
    add(eventItem('info', '', text, ''));
  }

  function markDeleted(predicate) {
    let changed = false;
    for (const item of items) {
      if (item.kind === 'message' && !item.deleted && predicate(item)) {
        item.deleted = true;
        changed = true;
      }
    }
    if (!changed || !ui) return;
    for (const node of [...ui.list.querySelectorAll('.cr-msg')]) {
      const item = items.find((i) => i.id === node.dataset.id);
      if (item?.deleted && !node.classList.contains('cr-deleted')) node.replaceWith(build(item));
    }
  }

  function scrollToBottom() {
    if (!ui) return;
    ui.list.scrollTop = ui.list.scrollHeight;
    paused = false;
    unseen = 0;
    ui.more.hidden = true;
  }

  function insertIntoTwitchInput(text) {
    const input = document.querySelector('[data-a-target="chat-input"]');
    if (!input) return;
    input.focus();
    try {
      document.execCommand('insertText', false, text);
    } catch { /* manche Browser erlauben das nicht */ }
  }

  // ============================================================ In die Twitch-Seite einhängen

  function channelFromUrl() {
    const parts = location.pathname.split('/').filter(Boolean).map((p) => p.toLowerCase());
    if ((parts[0] === 'popout' || parts[0] === 'embed') && parts[2] === 'chat') return parts[1];
    if (parts[0] === 'moderator') return parts[1] ?? null;
    return parts.length >= 1 && /^\w+$/.test(parts[0]) ? parts[0] : null;
  }

  function findTwitchList() {
    return document.querySelector('.chat-room__content .chat-list--default, .chat-room__content .chat-list--other');
  }

  function unmount() {
    document.querySelectorAll(`.${HIDE_CLASS}`).forEach((n) => n.classList.remove(HIDE_CLASS));
    host?.remove();
    if (wsChannel) {
      disconnect();
      items = [];
      if (ui) ui.list.replaceChildren();
    }
  }

  function tick() {
    const channel = channelFromUrl();
    if (channel !== CONFIG.channel.toLowerCase()) return unmount();
    const list = findTwitchList();
    if (!list) return;
    if (!host) buildUi();
    // Twitch baut Teile der Seite ab und zu neu → dann wieder einhängen
    if (!host.isConnected || host.nextElementSibling !== list) {
      list.parentElement.insertBefore(host, list);
      applyMode();
    }
    if (!list.classList.contains(HIDE_CLASS) && prefs.enabled) applyMode();
    if (wsChannel !== channel) connect(channel);
  }

  // Nur beim Testen außerhalb einer installierten Erweiterung: Chat-Zeilen von Hand einspielen
  if (!ext?.runtime?.id) window.__mssTestLine = handleLine;

  loadPrefs().then((p) => {
    prefs = p;
    tick();
    setInterval(tick, 1000);
  });
})();
