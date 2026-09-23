const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/queue';
/** Als kleines Fenster geöffnet (oder als OBS-Dock)? */
const COMPACT = new URLSearchParams(location.search).has('window');

const state = { data: null, clockOffset: 0, rewards: null, rewardsError: '', rewardSearch: '' };

async function call(path, body) {
  try {
    const result = await api(`${BASE}${path}`, body);
    if (result?.entries) {
      state.data = result;
      state.clockOffset = result.now - Date.now();
      render();
    }
    return result;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

const load = () => call('/state');

function ago(t) {
  const min = Math.floor((Date.now() + state.clockOffset - t) / 60_000);
  if (min < 1) return 'gerade';
  if (min < 60) return `${min} Min.`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} Std. ${min % 60} Min.`;
  return new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

// ============================================================ Liste

function entryRow(e, index) {
  const locked = !e.manageable && !e.test;
  return h('div', { class: 'q-item' },
    h('span', { class: 'q-num' }, index + 1),
    h('div', { class: 'q-main' },
      h('div', { class: 'q-line' },
        h('strong', { class: 'no-i18n' }, e.user.name),
        h('span', { class: 'q-reward no-i18n' }, e.rewardTitle),
        e.test ? h('span', { class: 'badge accent' }, '🧪 Test') : null,
        locked ? h('span', { class: 'badge', title: 'Fremde Belohnung: Abhaken nur hier in der Liste, bei Twitch bleibt sie offen.' }, '🔒') : null),
      e.input ? h('div', { class: 'q-input', title: e.input }, `„${e.input}“`) : null,
      h('div', { class: 'q-time' }, `vor ${ago(e.at)}`)),
    h('div', { class: 'q-actions' },
      h('button', {
        class: 'icon-btn q-done',
        title: locked ? 'Abhaken (nur in der Liste)' : 'Erledigt (auch bei Twitch)',
        onclick: () => call('/done', { id: e.id }),
      }, '✓'),
      locked
        ? h('button', { class: 'icon-btn', title: 'Aus der Liste entfernen', onclick: () => call('/remove', { id: e.id }) }, '✕')
        : h('button', {
          class: 'icon-btn',
          title: `Zurückerstatten: ${e.user.name} bekommt ${e.cost.toLocaleString('de-DE')} Punkte zurück`,
          onclick: () => {
            if (confirm(`${e.user.name} die ${e.cost.toLocaleString('de-DE')} Punkte für „${e.rewardTitle}“ zurückgeben?`)) call('/refund', { id: e.id });
          },
        }, '↩')));
}

function renderList(box, emptyText) {
  const entries = state.data.entries;
  // Nur neu bauen, wenn sich etwas geändert hat (sonst springt die Maus beim Klicken)
  const key = JSON.stringify(entries.map((e) => e.id)) + state.data.enabled + Math.floor((Date.now() + state.clockOffset) / 60_000);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...(entries.length
    ? entries.map(entryRow)
    : [h('div', { class: 'empty' }, emptyText)]));
}

async function doneAll() {
  const n = state.data?.entries.length ?? 0;
  if (!n) return;
  if (confirm(`Alle ${n} Einlösungen als erledigt markieren?`)) await call('/done-all', {});
}

// ============================================================ Große Ansicht

function renderToggle() {
  const on = state.data.enabled;
  const box = $('#enabled-toggle');
  if (box.dataset.on === String(on)) return;
  box.dataset.on = String(on);
  box.replaceChildren(toggle(on, (v) => call('/settings', { enabled: v }), 'Warteschlange an/aus'), on ? 'An' : 'Aus');
}

function render() {
  if (!state.data) return;
  const n = state.data.entries.length;
  if (COMPACT) {
    $('#qw-count').textContent = n ? `${n} offen` : 'Warteschlange';
    renderList($('#qw-list'), state.data.enabled ? 'Nichts offen 🎉' : 'Warteschlange ist aus.');
    return;
  }
  renderToggle();
  $('#count-title').textContent = n ? `Offen (${n})` : 'Offen';
  $('#done-all').disabled = !n;
  renderList($('#list'), state.data.enabled
    ? 'Nichts offen 🎉 Neue Einlösungen erscheinen hier automatisch.'
    : 'Die Warteschlange ist aus. Schalte sie oben rechts ein.');
}

// ============================================================ Einstellungen: welche Belohnungen

async function loadRewards() {
  try {
    state.rewards = await api(`${BASE}/rewards`);
    state.rewardsError = '';
  } catch (err) {
    state.rewards = null;
    state.rewardsError = err.message;
  }
  renderRewards();
}

async function setMode(r, mode) {
  try {
    await api(`${BASE}/rewards/mode`, { id: r.id, title: r.title, mode });
  } catch (err) {
    toast(err.message, 'err');
  }
  loadRewards();
}

async function setIgnoredGroups(ids) {
  await call('/settings', { ignoredGroups: ids });
  loadRewards();
}

function renderRewards() {
  const res = state.rewards;
  if (!res) {
    $('#groups').replaceChildren();
    $('#rewards').replaceChildren(h('p', { class: state.rewardsError ? 'warn-note' : 'note' }, state.rewardsError || 'Lade Belohnungen…'));
    return;
  }

  const ignored = new Set(res.ignoredGroups);
  $('#groups').replaceChildren(...(res.groups?.length
    ? [h('div', { class: 'sub' }, 'GRUPPEN'),
      ...res.groups.map((g) => h('div', { class: 'opt-row' },
        toggle(!ignored.has(g.id), (on) => setIgnoredGroups(on ? [...ignored].filter((id) => id !== g.id) : [...ignored, g.id]), `Gruppe ${g.name}`),
        h('span', { class: 'no-i18n' }, `${g.icon} ${g.name}`),
        h('span', { class: 'note' }, ignored.has(g.id) ? 'nie in der Liste' : 'wie eingestellt'))),
      h('div', { class: 'sub' }, 'BELOHNUNGEN')]
    : []));

  const q = state.rewardSearch.toLowerCase();
  const rows = res.rewards.filter((r) => r.title.toLowerCase().includes(q));
  $('#rewards').replaceChildren(...rows.map((r) => {
    const select = h('select', { class: 'mode-select', onchange: (e) => setMode(r, e.target.value || null) },
      h('option', { value: '', selected: !r.mode }, r.usesQueue ? 'Standard (in Liste)' : 'Standard (nicht)'),
      h('option', { value: 'always', selected: r.mode === 'always' }, 'Immer in Liste'),
      h('option', { value: 'never', selected: r.mode === 'never' }, 'Nie in Liste'));
    return h('div', { class: `q-reward-row${r.inQueue ? '' : ' off'}` },
      h('span', { class: 'q-dot', style: { background: r.color } }, r.image ? h('img', { src: r.image, alt: '' }) : null),
      h('span', { class: 'q-reward-name', title: r.title }, r.title, r.manageable ? null : h('span', { class: 'q-lock', title: 'Fremde Belohnung: nur lokal abhakbar' }, ' 🔒')),
      select);
  }));
}

// ============================================================ Start

async function initCompact() {
  document.body.classList.add('compact');
  $('#page').hidden = true;
  $('#compact').hidden = false;
  $('#qw-done-all').onclick = doneAll;
  // Im OBS-Dock gibt es kein Suite-Fenster zum Anheften
  const win = await api(`${BASE}/window/state`).catch(() => null);
  $('#pin').hidden = !win?.open;
  $('#pin').classList.toggle('on', !!win?.onTop);
  $('#pin').onclick = async () => {
    try {
      const { onTop } = await api(`${BASE}/window/pin`, { onTop: !$('#pin').classList.contains('on') });
      $('#pin').classList.toggle('on', onTop);
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

function initPage() {
  $('#open-window').onclick = () => api(`${BASE}/window/open`, {}).catch((err) => toast(err.message, 'err'));
  $('#done-all').onclick = doneAll;
  $('#sync').onclick = async () => {
    const result = await call('/sync', {});
    if (result) toast(result.added || result.removed ? `Abgeglichen: ${result.added} neu, ${result.removed} entfernt` : 'Alles aktuell ✓', 'ok');
  };
  $('#reward-search').oninput = (e) => {
    state.rewardSearch = e.target.value;
    renderRewards();
  };
  loadRewards();
}

(async () => {
  if (COMPACT) await initCompact();
  else initPage();
  await load();
  setInterval(() => { if (!document.hidden) load(); }, 2000);
})();
