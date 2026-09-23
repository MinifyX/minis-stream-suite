const { $, h, api, toast } = window.UI;
const BASE = 'addons/chat';
const MAX_ITEMS = 500;
const EVENT_LABELS = {
  follow: '💜 Follows', sub: '⭐ Subs', resub: '⭐ Resubs', giftsub: '🎁 Gift-Subs',
  cheer: '💎 Bits', raid: '🚀 Raids', redemption: '✨ Einlösungen', stream: '🔴 Stream',
  hypetrain: '🚂 Hype Train', prediction: '🔮 Vorhersagen', shoutout: '📣 Shoutouts', ads: '📺 Werbung',
};

const list = $('#list');
const input = $('#input');
let settings = null;
let items = [];
let replyTo = null; // { id, name }
let paused = false;
let unseen = 0;

// ============================================================ Darstellung

const w = () => settings.window;

function visible(item) {
  if (item.kind === 'event') return !!w().events[item.event];
  if (w().hideCommands && ChatRender.plainText(item).trim().startsWith('!')) return false;
  return true;
}

/** Erwähnung von dir oder eines deiner Stichwörter? */
function isHighlight(item) {
  if (item.kind !== 'message' || item.own) return false;
  const text = ChatRender.plainText(item).toLowerCase();
  const login = (ChatRender.getAssets().broadcaster || '').toLowerCase();
  if (w().highlightMentions && login && (text.includes(`@${login}`) || new RegExp(`(^|\\W)${login}(\\W|$)`).test(text))) return true;
  return w().highlightWords.some((word) => word && text.includes(word));
}

function build(item) {
  if (item.kind === 'event') {
    const node = ChatRender.event(item);
    if (item.hiddenReward) {
      node.classList.add('cr-muted');
      node.querySelector('.cr-ev-line').append(h('span', { class: 'cr-mute-note', title: 'Diese Belohnung ist im Alert-Filter stumm und wird im Overlay nicht gezeigt' }, '🔕 nicht im Overlay'));
    }
    if (item.replay) {
      node.append(h('div', { class: 'cw-actions' },
        h('button', { title: 'Alert dazu nochmal im Overlay abspielen', onclick: () => replay(item) }, '▶')));
    }
    return node;
  }
  const node = ChatRender.message(item, { settings, showBadges: w().showBadges, timestamps: w().timestamps, darkBackground: true });
  if (isHighlight(item)) node.classList.add('cr-hl');
  if (item.hiddenReward) {
    node.classList.add('cr-muted');
    node.append(h('span', { class: 'cr-mute-note' }, '🔕 nicht im Overlay'));
  }
  node.querySelector('.cr-name')?.addEventListener('click', () => insertText(`@${item.user.login || item.user.name} `));
  node.append(h('div', { class: 'cw-actions' },
    h('button', { title: 'Antworten', onclick: () => setReply(item) }, '↩'),
    h('button', { title: 'Text kopieren', onclick: () => copy(ChatRender.plainText(item)) }, '📋')));
  return node;
}

function renderAll() {
  list.style.setProperty('--cw-size', `${w().fontSize}px`);
  list.classList.toggle('alt', w().alternateBackground);
  const shown = items.filter(visible);
  list.replaceChildren(...(shown.length
    ? shown.map(build)
    : [h('div', { class: 'cw-empty' }, 'Noch keine Nachrichten. Sobald jemand schreibt oder ein Event kommt, erscheint es hier.')]));
  scrollToBottom();
}

function scrollToBottom() {
  list.scrollTop = list.scrollHeight;
  paused = false;
  unseen = 0;
  $('#more').hidden = true;
}

function add(item) {
  items.push(item);
  if (items.length > MAX_ITEMS) {
    items.shift();
    if (list.children.length > MAX_ITEMS) list.firstElementChild.remove();
  }
  if (!visible(item)) return;
  list.querySelector('.cw-empty')?.remove();
  list.append(build(item));
  if (paused) {
    unseen++;
    $('#more').hidden = false;
    $('#more').textContent = `⏬ ${unseen} neue ${unseen === 1 ? 'Nachricht' : 'Nachrichten'}`;
  } else {
    list.scrollTop = list.scrollHeight;
  }
}

function markDeleted(predicate) {
  for (const item of items) if (item.kind === 'message' && predicate(item)) item.deleted = true;
  list.querySelectorAll('.cr-msg').forEach((node) => {
    const item = items.find((i) => i.id === node.dataset.id);
    if (item?.deleted) node.classList.add('cr-deleted');
  });
}

// ============================================================ Eingabe

function insertText(text) {
  const pos = input.selectionStart ?? input.value.length;
  input.value = input.value.slice(0, pos) + text + input.value.slice(input.selectionEnd ?? pos);
  input.focus();
  input.setSelectionRange(pos + text.length, pos + text.length);
}

function setReply(item) {
  replyTo = item ? { id: item.id, name: item.user.name } : null;
  const bar = $('#reply');
  bar.hidden = !replyTo;
  if (replyTo) {
    bar.replaceChildren(h('span', {}, `↩ Antwort an ${replyTo.name}`), h('button', { title: 'Abbrechen', onclick: () => setReply(null) }, '✕'));
    input.focus();
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Kopiert', 'ok');
  } catch {
    toast('Kopieren nicht möglich', 'err');
  }
}

async function send() {
  const message = input.value.trim();
  if (!message) return;
  $('#send').disabled = true;
  try {
    await api(`${BASE}/send`, { message, replyTo: replyTo?.id });
    input.value = '';
    setReply(null);
    autosize();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    $('#send').disabled = false;
    input.focus();
  }
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 90)}px`;
}

// ============================================================ Kopfleiste

async function saveSettings() {
  try {
    settings = await api(`${BASE}/settings`, { settings });
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderFilterMenu() {
  $('#filter-menu').replaceChildren(
    ...Object.entries(EVENT_LABELS).map(([kind, label]) =>
      h('button', {
        class: w().events[kind] ? 'on' : '',
        onclick: async () => {
          w().events[kind] = !w().events[kind];
          renderFilterMenu();
          renderAll();
          await saveSettings();
        },
      }, label)),
    h('button', {
      class: w().hideCommands ? 'on' : '',
      title: 'Nachrichten, die mit ! beginnen, ausblenden',
      onclick: async () => {
        w().hideCommands = !w().hideCommands;
        renderFilterMenu();
        renderAll();
        await saveSettings();
      },
    }, '🙈 !Commands ausblenden'));
}

// ============================================================ Alerts steuern (nochmal abspielen, pausieren)

async function replay(item) {
  try {
    const result = await api(`${BASE}/replay`, { id: item.id });
    toast(result.shown ? `▶ Alert „${result.variant}“ kommt` : 'Kein Alert: keine aktive Variante passt (oder die Belohnung ist stumm)', result.shown ? 'ok' : 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** Pause-Knopf: zeigt, ob Alerts pausiert sind und wie viele warten */
function renderAlerts(status) {
  const pause = $('#alerts-pause');
  pause.hidden = !status;
  $('#alerts-skip').hidden = !status;
  if (!status) return;
  pause.classList.toggle('on', status.paused);
  pause.textContent = status.paused ? `▶${status.held ? ` ${status.held}` : ''}` : '⏸';
  pause.title = status.paused
    ? `Alerts sind pausiert${status.held ? ` (${status.held} warten)` : ''}. Klicken zum Fortsetzen.`
    : 'Alerts pausieren: neue Alerts warten, bis du fortsetzt';
}

async function refreshAlerts() {
  renderAlerts(await api(`${BASE}/alerts`).catch(() => null));
}

async function refreshPin() {
  try {
    const state = await api(`${BASE}/window/state`);
    $('#pin').classList.toggle('on', state.onTop);
  } catch {
    // z.B. als OBS-Dock geöffnet
  }
}

// ============================================================ Start

async function load() {
  const [s, assets, history] = await Promise.all([
    api(`${BASE}/settings`),
    api(`${BASE}/assets`).catch(() => null),
    api(`${BASE}/history`),
  ]);
  settings = s;
  ChatRender.setAssets(assets);
  if (assets?.broadcaster) $('#channel').textContent = assets.broadcaster;
  items = history.slice(-MAX_ITEMS);
  renderFilterMenu();
  renderAll();
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws?channel=chat`);
  ws.onmessage = async (msg) => {
    const data = JSON.parse(msg.data);
    if (!settings) return;
    switch (data.kind) {
      case 'item': add(data.item); break;
      case 'delete': markDeleted((i) => i.id === data.id); break;
      case 'clear':
        if (data.userId) markDeleted((i) => i.user.id === data.userId);
        else {
          markDeleted(() => true);
          add({ kind: 'event', id: `clear-${Date.now()}`, time: Date.now(), event: 'stream', icon: '🧹', text: 'Der Chat wurde geleert.', user: '', detail: '', hiddenReward: false, test: false });
        }
        break;
      case 'settings':
        settings = await api(`${BASE}/settings`);
        renderFilterMenu();
        renderAll();
        break;
      case 'assets':
        ChatRender.setAssets(await api(`${BASE}/assets`).catch(() => null));
        break;
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

list.addEventListener('scroll', () => {
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  paused = !atBottom;
  if (atBottom) {
    unseen = 0;
    $('#more').hidden = true;
  }
});
$('#more').onclick = scrollToBottom;
$('#send').onclick = send;
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  } else if (e.key === 'Escape') setReply(null);
});
input.addEventListener('input', autosize);
$('#filter').onclick = () => {
  $('#filter-menu').hidden = !$('#filter-menu').hidden;
  $('#filter').classList.toggle('on', !$('#filter-menu').hidden);
};
$('#pin').onclick = async () => {
  try {
    const { onTop } = await api(`${BASE}/window/pin`, { on: !$('#pin').classList.contains('on') });
    $('#pin').classList.toggle('on', onTop);
  } catch (err) {
    toast(err.message, 'err');
  }
};
const changeFont = async (delta) => {
  w().fontSize = Math.max(10, Math.min(30, w().fontSize + delta));
  renderAll();
  await saveSettings();
};
$('#alerts-pause').onclick = async () => {
  try {
    const status = await api(`${BASE}/alerts/pause`, { paused: !$('#alerts-pause').classList.contains('on') });
    renderAlerts(status);
    toast(status.paused ? '⏸ Alerts pausiert' : '▶ Alerts laufen wieder', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
};
$('#alerts-skip').onclick = () => api(`${BASE}/alerts/skip`, {}).catch((err) => toast(err.message, 'err'));
$('#font-down').onclick = () => changeFont(-1);
$('#font-up').onclick = () => changeFont(1);

load().catch((err) => toast(err.message, 'err'));
connect();
refreshAlerts();
// Pause kann auch woanders umgeschaltet werden (z.B. im Alert-Editor)
setInterval(refreshAlerts, 3000);
refreshPin();
