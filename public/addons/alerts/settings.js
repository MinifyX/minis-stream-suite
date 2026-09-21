const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/alerts';

// Typ → [Icon, Name, verfügbare Platzhalter]
const TYPES = {
  redemption: ['✨', 'Kanalpunkte', '{user} {reward} {cost}'],
  follow: ['💜', 'Follow', '{user}'],
  sub: ['⭐', 'Neues Abo', '{user} {tier}'],
  resub: ['⭐', 'Abo-Verlängerung', '{user} {tier} {months}'],
  giftsub: ['🎁', 'Verschenkte Abos', '{user} {tier} {count}'],
  cheer: ['💎', 'Cheer (Bits)', '{user} {bits}'],
  raid: ['🚀', 'Raid', '{user} {viewers}'],
};

let settings = null;
let rewards = [];

// ---------------------------------------------------------------- Speichern (gesammelt, kurz verzögert)

let pending = {};
let saveTimer = null;

function save(patch) {
  Object.assign(pending, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

async function flush() {
  clearTimeout(saveTimer);
  if (!Object.keys(pending).length) return;
  const body = pending;
  pending = {};
  try {
    settings = await api(`${BASE}/settings`, body);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function testAlert(type, reward) {
  await flush();
  try {
    const result = await api(`${BASE}/test`, { type, reward, respectFilter: !!reward });
    if (result.shown) toast('Alert wird im Overlay angezeigt', 'ok');
    else toast('Kein Alert: diese Belohnung ist stumm geschaltet ✓');
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------- Event-Arten + Allgemein

function renderTypes() {
  $('#types').replaceChildren(...Object.entries(TYPES).map(([type, [icon, label, vars]]) =>
    h('div', { class: 'type-row' },
      toggle(settings.enabled[type], (on) => {
        settings.enabled[type] = on;
        save({ enabled: settings.enabled });
      }, `${label} an/aus`),
      h('div', { class: 'type-label' }, h('strong', {}, `${icon} ${label}`), h('small', { class: 'muted' }, vars)),
      h('input', {
        type: 'text',
        value: settings.templates[type],
        'aria-label': `Text für ${label}`,
        oninput: (e) => {
          settings.templates[type] = e.target.value;
          save({ templates: settings.templates });
        },
      }),
      h('button', { class: 'btn small', onclick: () => testAlert(type) }, 'Test'))));
}

function numberField(label, key, { min = 0, step = 1, scale = 1, suffix = '' } = {}) {
  return h('div', { class: 'field' },
    h('label', {}, label),
    h('div', { class: 'with-suffix' },
      h('input', {
        type: 'number', min, step,
        value: settings[key] / scale,
        onchange: (e) => {
          const value = Math.max(min, Number(e.target.value) || 0);
          e.target.value = value;
          save({ [key]: Math.round(value * scale) });
        },
      }),
      suffix ? h('span', { class: 'muted' }, suffix) : null));
}

function renderGeneral() {
  $('#general').replaceChildren(
    numberField('Anzeigedauer', 'durationMs', { min: 1, step: 0.5, scale: 1000, suffix: 'Sekunden' }),
    numberField('Cheer-Alert ab', 'minBits', { min: 1, suffix: 'Bits' }),
    numberField('Raid-Alert ab', 'minRaiders', { min: 1, suffix: 'Leuten' }),
    h('div', { class: 'toggle-row' },
      toggle(settings.sound, (on) => save({ sound: on }), 'Sound'),
      h('span', {}, 'Sound abspielen')));
}

// ---------------------------------------------------------------- Belohnungen

function renderDefaultRow() {
  $('#default-row').replaceChildren(
    toggle(settings.newRewardDefault, async (on) => {
      settings.newRewardDefault = on;
      save({ newRewardDefault: on });
      await flush();
      loadRewards();
    }, 'Standard'),
    h('div', {},
      h('strong', {}, 'Standard: Alert für Belohnungen ohne eigene Einstellung'),
      h('small', { class: 'muted' }, 'Gilt auch für Belohnungen, die du später neu anlegst.')));
}

function visibleRewards() {
  const query = $('#reward-search').value.trim().toLowerCase();
  return rewards.filter((r) => r.title.toLowerCase().includes(query));
}

function renderRewards() {
  const box = $('#rewards');
  if (!rewards.length) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Keine Belohnungen gefunden.'));
    return;
  }
  box.replaceChildren(...visibleRewards().map((r) =>
    h('div', { class: `reward-row${r.alert ? '' : ' silent'}` },
      h('div', { class: 'reward-img', style: { background: r.color } }, r.image ? h('img', { src: r.image, alt: '' }) : null),
      h('div', { class: 'reward-info' },
        h('strong', {}, r.title),
        h('div', { class: 'reward-meta' },
          h('span', { class: 'muted' }, `${r.cost.toLocaleString('de-DE')} Punkte`),
          !r.enabled ? h('span', { class: 'badge' }, 'deaktiviert') : null,
          r.paused ? h('span', { class: 'badge warn' }, 'pausiert') : null,
          r.custom ? h('span', { class: 'badge accent' }, 'eigene Einstellung') : h('span', { class: 'badge' }, 'Standard'))),
      h('div', { class: 'reward-actions' },
        r.custom ? h('button', { class: 'btn small', title: 'Auf Standard zurücksetzen', onclick: () => setRewards({ [r.id]: null }) }, '↺') : null,
        h('button', { class: 'btn small', onclick: () => testAlert('redemption', { id: r.id, title: r.title, cost: r.cost }) }, 'Test'),
        h('span', { class: 'bell', title: r.alert ? 'Alert an' : 'Kein Alert' }, r.alert ? '🔔' : '🔕'),
        toggle(r.alert, (on) => setRewards({ [r.id]: { alert: on, title: r.title } }), `Alert für ${r.title}`)))));
}

async function setRewards(changes) {
  try {
    await api(`${BASE}/rewards`, { changes });
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  for (const r of rewards) {
    if (!(r.id in changes)) continue;
    const change = changes[r.id];
    r.custom = change !== null;
    r.alert = change ? change.alert : settings.newRewardDefault;
  }
  renderRewards();
}

function setVisible(alert) {
  const list = visibleRewards();
  if (!list.length) return;
  setRewards(Object.fromEntries(list.map((r) => [r.id, { alert, title: r.title }])));
  toast(`${list.length} Belohnung(en): Alert ${alert ? 'an' : 'aus'}`, 'ok');
}

async function loadRewards() {
  const box = $('#rewards');
  box.replaceChildren(h('p', { class: 'muted' }, 'Lade Belohnungen von Twitch…'));
  try {
    rewards = (await api(`${BASE}/rewards`)).rewards;
    renderRewards();
  } catch (err) {
    rewards = [];
    box.replaceChildren(h('p', { class: 'error-text' }, err.message));
  }
}

// ---------------------------------------------------------------- Start

(async () => {
  const overlayUrl = `${location.origin}/addons/alerts/overlay.html`;
  $('#overlay-url').value = overlayUrl;
  $('#copy-url').onclick = async () => {
    await navigator.clipboard.writeText(overlayUrl);
    toast('URL kopiert', 'ok');
  };
  $('#skip').onclick = () => api(`${BASE}/skip`, {}).catch((err) => toast(err.message, 'err'));
  $('#reload-rewards').onclick = loadRewards;
  $('#reward-search').oninput = renderRewards;
  $('#bulk-on').onclick = () => setVisible(true);
  $('#bulk-off').onclick = () => setVisible(false);

  try {
    settings = await api(`${BASE}/settings`);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  renderTypes();
  renderGeneral();
  renderDefaultRow();
  loadRewards();
})();
