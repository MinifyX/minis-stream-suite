const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/channelpoints';
const GROUP_ICONS = ['📁', '👻', '😱', '🎮', '🎵', '💧', '🍕', '🎲', '🔥', '⭐', '🎁', '🗣️', '🎨', '⚡', '🧪', '💀'];
const GROUP_COLORS = ['#9146FF', '#FF3B6B', '#FF8A3D', '#FFE14D', '#4DFF88', '#35D0FF', '#2F6BFF', '#B0B0C0'];

const state = {
  data: null, // { rewards, groups, imports, max }
  error: '',
  selected: 'all', // 'all' | 'none' | Gruppen-ID
  search: '',
  login: '',
  mutedGroups: null, // null = Alerts-Addon ist aus
};

const groupById = (id) => state.data?.groups.find((g) => g.id === id);
const groupsOf = (rewardId) => state.data.groups.filter((g) => g.rewardIds.includes(rewardId));

async function call(path, body, successMessage) {
  try {
    const result = await api(`${BASE}/${path}`, body);
    if (successMessage) toast(successMessage, 'ok');
    return result ?? {};
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

// ============================================================ Laden

async function load() {
  try {
    state.data = await api(`${BASE}/state`);
    state.error = '';
  } catch (err) {
    state.error = err.message;
  }
  try {
    state.mutedGroups = (await api('addons/alerts/settings')).mutedGroups ?? [];
  } catch {
    state.mutedGroups = null;
  }
  if (state.selected !== 'all' && state.selected !== 'none' && !groupById(state.selected)) state.selected = 'all';
  render();
}

// ============================================================ Gruppen-Liste (links)

function renderNav() {
  const nav = $('#group-nav');
  if (!state.data) {
    nav.replaceChildren();
    return;
  }
  const { rewards, groups } = state.data;
  const inAnyGroup = new Set(groups.flatMap((g) => g.rewardIds));
  const item = (id, icon, name, count, color) =>
    h('button', { class: `g-item${state.selected === id ? ' active' : ''}`, onclick: () => { state.selected = id; render(); } },
      color ? h('span', { class: 'dot-color', style: { background: color } }) : null,
      h('span', {}, icon),
      h('span', { class: 'g-name' }, name),
      h('span', { class: 'count' }, count));

  nav.replaceChildren(...[
    item('all', '📋', 'Alle Belohnungen', rewards.length),
    item('none', '📂', 'Ohne Gruppe', rewards.filter((r) => !inAnyGroup.has(r.id)).length),
    groups.length ? h('div', { class: 'g-sep' }) : null,
    ...groups.map((g) => item(g.id, g.icon, g.name, rewards.filter((r) => g.rewardIds.includes(r.id)).length, g.color)),
  ].filter(Boolean));
}

// ============================================================ Kopfbereich

function renderHead() {
  const head = $('#head');
  if (!state.data) {
    head.replaceChildren(h('div', { class: 'cp-title' }, h('h1', {}, '🎯 Kanalpunkte')));
    return;
  }
  const { rewards, max } = state.data;
  const manageable = rewards.filter((r) => r.manageable).length;
  const stats = h('div', { class: 'stat-row' },
    h('span', { class: `badge${rewards.length >= max ? ' err' : ''}` }, `${rewards.length} / ${max} Belohnungen`),
    h('span', { class: 'badge ok' }, `✎ ${manageable} von der Suite verwaltet`),
    rewards.length - manageable ? h('span', { class: 'badge', title: 'Im Twitch-Dashboard oder von einer anderen App (z.B. HudFX) angelegt' }, `🔒 ${rewards.length - manageable} nur lesen`) : null);

  const group = groupById(state.selected);
  if (!group) {
    const title = state.selected === 'none' ? '📂 Ohne Gruppe' : '🎯 Alle Belohnungen';
    head.replaceChildren(h('div', { class: 'cp-title' }, h('h1', {}, title)), stats);
    return;
  }

  const members = rewards.filter((r) => group.rewardIds.includes(r.id));
  const controllable = members.filter((r) => r.manageable).length;
  const alertsRow = state.mutedGroups
    ? h('div', { class: 'row' },
      h('span', { class: 'label' }, '🔔 Alerts'),
      toggle(!state.mutedGroups.includes(group.id), (on) => setGroupMuted(group.id, !on), `Alerts für ${group.name}`),
      h('span', { class: 'muted' }, state.mutedGroups.includes(group.id)
        ? 'Aus: Belohnungen dieser Gruppe lösen nie einen Alert aus.'
        : 'An: Alerts wie im Alert-Editor eingestellt.'))
    : h('div', { class: 'note' }, 'Tipp: Mit dem Alerts-Addon kannst du Alerts für diese Gruppe hier direkt stummschalten.');

  head.replaceChildren(
    h('div', { class: 'cp-title' },
      h('span', { class: 'dot-color', style: { background: group.color, width: '14px', height: '14px' } }),
      h('h1', {}, `${group.icon} ${group.name}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => openMembers(group) }, '＋ Belohnungen zuordnen'),
      h('button', { class: 'btn small', onclick: () => openGroupEditor(group) }, '✎ Bearbeiten'),
      h('button', { class: 'btn small', onclick: () => deleteGroup(group) }, '🗑')),
    h('div', { class: 'group-panel' },
      alertsRow,
      h('div', { class: 'row' },
        h('span', { class: 'label' }, '🛡 Andere App'),
        toggle(!!group.foreign, (on) => setGroupForeign(group, on), 'Belohnungen gehören einer anderen App'),
        h('span', { class: 'muted' }, group.foreign
          ? 'An: Diese Belohnungen gehören einer anderen App (z.B. HudFX) und werden nie übernommen.'
          : 'Aus: Belohnungen können übernommen werden.'),
        group.foreign ? dashboardButton('↗ Im Dashboard bearbeiten') : null),
      h('div', { class: 'row' },
        h('span', { class: 'label' }, '⚡ Ganze Gruppe'),
        h('button', { class: 'btn small', disabled: !controllable, onclick: () => groupAction(group, 'pause') }, '⏸ Pausieren'),
        h('button', { class: 'btn small', disabled: !controllable, onclick: () => groupAction(group, 'resume') }, '▶ Fortsetzen'),
        h('button', { class: 'btn small', disabled: !controllable, onclick: () => groupAction(group, 'disable') }, '🚫 Ausblenden'),
        h('button', { class: 'btn small', disabled: !controllable, onclick: () => groupAction(group, 'enable') }, '👁 Einblenden')),
      h('div', { class: 'note' }, controllable === members.length
        ? `Alle ${members.length} Belohnungen dieser Gruppe kann die Suite steuern.`
        : `${controllable} von ${members.length} Belohnungen kann die Suite steuern. Die anderen (🔒) wurden im Twitch-Dashboard oder von einer anderen App wie HudFX angelegt und werden übersprungen.`)),
    stats);
}

async function setGroupMuted(groupId, muted) {
  const next = muted ? [...state.mutedGroups, groupId] : state.mutedGroups.filter((id) => id !== groupId);
  try {
    state.mutedGroups = (await api('addons/alerts/settings', { mutedGroups: next })).mutedGroups;
    toast(muted ? 'Alerts für diese Gruppe aus' : 'Alerts für diese Gruppe an', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  renderHead();
}

async function groupAction(group, action) {
  const labels = { pause: 'pausiert', resume: 'fortgesetzt', disable: 'ausgeblendet', enable: 'eingeblendet' };
  const result = await call('groups/action', { id: group.id, action });
  if (!result) return;
  let message = `${result.changed} Belohnung(en) ${labels[action]}`;
  if (result.skipped.length) message += ` · ${result.skipped.length} übersprungen (🔒)`;
  toast(message, result.failed.length ? 'err' : 'ok');
  if (result.failed.length) toast(result.failed.join('\n'), 'err');
  await load();
}

async function deleteGroup(group) {
  if (!confirm(`Gruppe „${group.name}“ löschen? Die Belohnungen selbst bleiben erhalten.`)) return;
  if (await call('groups/delete', { id: group.id }, 'Gruppe gelöscht')) {
    if (state.mutedGroups?.includes(group.id)) await setGroupMuted(group.id, false);
    state.selected = 'all';
    await load();
  }
}

// ============================================================ Übernehmen-Hinweise

function dashboardUrl() {
  return state.login
    ? `https://dashboard.twitch.tv/u/${encodeURIComponent(state.login)}/viewer-rewards/channel-points/rewards`
    : 'https://dashboard.twitch.tv/';
}

function renderImports() {
  const box = $('#imports');
  const imports = state.data?.imports ?? [];
  box.replaceChildren(...imports.map((imp) => h('div', { class: 'import-banner' },
    h('strong', {}, `⏳ „${imp.data.title}“ wird übernommen`),
    h('ol', {},
      h('li', {}, imp.originalExists
        ? h('span', {}, 'Lösche die Original-Belohnung im ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openDashboard(); } }, 'Twitch-Dashboard'), '.')
        : h('span', {}, '✓ Original ist gelöscht.')),
      h('li', {}, 'Klick auf „Jetzt neu anlegen“. Die Suite legt sie mit denselben Einstellungen neu an und übernimmt Gruppen und Alert-Einstellungen.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary small', onclick: () => finishImport(imp) }, 'Jetzt neu anlegen'),
      h('button', { class: 'btn small', onclick: () => cancelImport(imp) }, 'Abbrechen'),
      imp.originalExists ? h('span', { class: 'note' }, 'Nach dem Löschen: ↻ Neu laden') : null))));
}

async function finishImport(imp) {
  const result = await call('imports/finish', { id: imp.oldId });
  if (!result) return;
  // Alert-Einstellungen auf die neue ID umziehen (klappt nur, wenn das Alerts-Addon an ist)
  await api('addons/alerts/rewards/migrate', { from: result.oldId, to: result.id }).catch(() => {});
  toast(`„${imp.data.title}“ wird jetzt von der Suite verwaltet`, 'ok');
  await load();
}

async function cancelImport(imp) {
  if (await call('imports/cancel', { id: imp.oldId })) await load();
}

function openImport(reward) {
  const pending = state.data.imports.some((i) => i.oldId === reward.id);
  if (pending) return toast('Diese Belohnung wird schon übernommen, siehe oben.');
  const close = modal(`Übernehmen: ${reward.title}`, [
    h('p', {}, 'Twitch lässt eine App nur Belohnungen ändern, die sie selbst angelegt hat. Damit die Suite diese Belohnung pausieren und bearbeiten kann, muss sie einmal neu angelegt werden:'),
    h('ol', {},
      h('li', {}, 'Die Suite merkt sich alle Einstellungen (Name, Kosten, Beschreibung, Farbe, Limits, Abklingzeit).'),
      h('li', {}, 'Du löschst das Original im Twitch-Dashboard.'),
      h('li', {}, 'Die Suite legt sie neu an. Gruppen und Alert-Einstellungen wandern mit.')),
    h('div', { class: 'warn-note' }, '⚠ Nicht übernehmen, wenn die Belohnung von einer anderen App stammt (z.B. HudFX, Sound Alerts, Spiele-Integrationen)! Die andere App erkennt die neue Belohnung sonst nicht mehr.'),
    reward.customImage ? h('div', { class: 'warn-note' }, '⚠ Das eigene Bild kann Twitch nicht per App setzen. Lade es danach im Dashboard wieder hoch.') : null,
    h('div', { class: 'note' }, 'Die Einlöse-Statistik der alten Belohnung geht dabei verloren.'),
  ], [
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        if (await call('imports/start', { id: reward.id })) {
          close();
          openDashboard();
          await load();
        }
      },
    }, 'Einstellungen merken & Dashboard öffnen'),
  ]);
}

// ============================================================ Belohnungen

function visibleRewards() {
  const { rewards, groups } = state.data;
  const q = state.search.toLowerCase();
  const inAnyGroup = new Set(groups.flatMap((g) => g.rewardIds));
  return rewards.filter((r) => {
    if (q && !r.title.toLowerCase().includes(q) && !r.prompt.toLowerCase().includes(q)) return false;
    if (state.selected === 'none') return !inAnyGroup.has(r.id);
    if (state.selected !== 'all') return groupById(state.selected)?.rewardIds.includes(r.id);
    return true;
  });
}

function renderRewards() {
  const box = $('#rewards');
  if (state.error) {
    box.replaceChildren(h('div', { class: 'empty' }, state.error));
    return;
  }
  if (!state.data) {
    box.replaceChildren(h('div', { class: 'empty' }, 'Lade Belohnungen von Twitch…'));
    return;
  }
  const list = visibleRewards();
  if (!list.length) {
    const group = groupById(state.selected);
    box.replaceChildren(h('div', { class: 'empty' },
      group ? h('div', {}, 'Diese Gruppe ist noch leer. ', h('button', { class: 'btn small', onclick: () => openMembers(group) }, '＋ Belohnungen zuordnen')) : 'Keine Belohnungen gefunden.'));
    return;
  }
  box.replaceChildren(h('div', { class: 'reward-list' }, ...list.map(rewardRow)));
}

function rewardRow(r) {
  const status = [];
  if (!r.enabled) status.push(h('span', { class: 'badge' }, 'ausgeblendet'));
  if (r.paused) status.push(h('span', { class: 'badge warn' }, 'pausiert'));
  const actions = [];
  if (r.manageable) {
    actions.push(
      h('button', {
        class: 'icon-btn', title: r.paused ? 'Fortsetzen' : 'Pausieren',
        onclick: async () => { if (await call('rewards/toggle', { id: r.id, paused: !r.paused })) await load(); },
      }, r.paused ? '▶' : '⏸'),
      h('button', { class: 'icon-btn', title: 'Bearbeiten', onclick: () => openRewardEditor(r) }, '✎'),
      h('button', { class: 'icon-btn', title: 'Löschen', onclick: () => deleteReward(r) }, '🗑'),
      toggle(r.enabled, async (on) => { if (await call('rewards/toggle', { id: r.id, enabled: on })) await load(); }, `${r.title} sichtbar`));
  } else {
    actions.push(dashboardButton());
    if (r.foreign === null || r.foreign === 'self') {
      actions.push(h('button', {
        class: `icon-btn${r.foreign ? ' on' : ''}`,
        title: r.foreign
          ? 'Markiert als „von einer anderen App“. Klicken zum Aufheben.'
          : 'Als „von einer anderen App“ (z.B. HudFX) markieren. Dann kann sie nicht versehentlich übernommen werden.',
        onclick: () => setRewardForeign(r, !r.foreign),
      }, '🛡'));
    }
    if (!r.foreign) actions.push(h('button', { class: 'btn small', title: 'Von der Suite verwalten lassen', onclick: () => openImport(r) }, '⇪ Übernehmen'));
  }

  return h('div', { class: `reward${!r.enabled || r.paused ? ' off' : ''}` },
    h('div', { class: 'r-img', style: { background: r.color } }, r.image ? h('img', { src: r.image, alt: '' }) : null),
    h('div', { class: 'r-info' },
      h('div', { class: 'r-title', title: r.title }, r.title),
      r.prompt ? h('div', { class: 'r-prompt', title: r.prompt }, r.prompt) : null,
      h('div', { class: 'r-meta' },
        h('span', { class: 'muted' }, `${r.cost.toLocaleString('de-DE')} Punkte`),
        r.redeemedThisStream ? h('span', { class: 'muted' }, `· ${r.redeemedThisStream}× in diesem Stream`) : null,
        ...status,
        r.manageable
          ? h('span', { class: 'badge ok', title: 'Von der Suite angelegt – kann bearbeitet und pausiert werden' }, '✎ verwaltet')
          : h('span', { class: 'badge', title: 'Im Twitch-Dashboard oder von einer anderen App angelegt – nur lesen' }, '🔒 nur lesen'),
        r.foreign
          ? h('span', { class: 'badge warn', title: 'Wird nicht übernommen. Bearbeiten nur im Twitch-Dashboard oder in der anderen App.' },
            r.foreign === 'self' ? '🛡 andere App' : `🛡 andere App (Gruppe ${r.foreign})`)
          : null,
        ...groupsOf(r.id).map((g) => h('span', { class: 'group-chip', style: { background: `${g.color}55` } }, `${g.icon} ${g.name}`)))),
    h('div', { class: 'r-actions' },
      h('button', { class: 'icon-btn', title: 'Gruppen', onclick: () => openRewardGroups(r) }, '🏷'),
      ...actions));
}

/** Öffnet die Twitch-Belohnungsverwaltung in einem Fenster der Suite */
async function openDashboard() {
  try {
    await api('core/twitch-window', { url: dashboardUrl() });
  } catch (err) {
    toast(`${err.message}. Öffne im Browser…`, 'err');
    window.open(dashboardUrl(), '_blank');
  }
}

function dashboardButton(label = '↗ Dashboard') {
  return h('button', {
    class: 'btn small',
    title: 'Öffnet die Belohnungsverwaltung von Twitch in einem Fenster der Suite. Dort kannst du Bild, Farbe & Co. ändern. Die Belohnung bleibt dieselbe, also funktioniert sie in HudFX weiter.',
    onclick: openDashboard,
  }, label);
}

async function setRewardForeign(r, foreign) {
  if (await call('rewards/foreign', { id: r.id, foreign }, foreign ? `„${r.title}“ als „andere App“ markiert` : 'Markierung entfernt')) await load();
}

async function setGroupForeign(group, foreign) {
  if (await call('groups/foreign', { id: group.id, foreign }, foreign ? 'Gruppe als „andere App“ markiert' : 'Markierung entfernt')) await load();
}

async function deleteReward(r) {
  if (!confirm(`Belohnung „${r.title}“ bei Twitch löschen? Das kann nicht rückgängig gemacht werden.`)) return;
  if (await call('rewards/delete', { id: r.id }, 'Belohnung gelöscht')) await load();
}

// ============================================================ Dialoge

function modal(title, body, footer) {
  const host = $('#modal-host');
  const close = () => host.replaceChildren();
  const content = typeof body === 'function' ? body(close) : body;
  host.replaceChildren(h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Schließen', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, ...content.filter(Boolean)),
      footer ? h('div', { class: 'modal-foot' }, ...footer) : null)));
  return close;
}

const field = (label, ...controls) => h('div', { class: 'field' }, h('label', {}, label), ...controls);

function openGroupEditor(group) {
  const isNew = !group;
  let icon = group?.icon ?? '📁';
  let color = group?.color ?? GROUP_COLORS[0];
  let foreign = !!group?.foreign;
  const foreignRow = h('div', { class: 'opt-row' },
    toggle(foreign, (on) => { foreign = on; }, 'Andere App'),
    h('span', {}, 'Belohnungen gehören einer anderen App (z.B. HudFX)'));
  const name = h('input', { type: 'text', value: group?.name ?? '', placeholder: 'z.B. HudFX', maxlength: 40 });
  const iconRow = h('div', { class: 'emoji-row' });
  const colorRow = h('div', { class: 'emoji-row' });
  const renderPickers = () => {
    iconRow.replaceChildren(...GROUP_ICONS.map((e) => h('button', { class: e === icon ? 'selected' : '', onclick: () => { icon = e; renderPickers(); } }, e)));
    colorRow.replaceChildren(...GROUP_COLORS.map((c) => h('button', { class: c === color ? 'selected' : '', style: { background: c }, title: c, onclick: () => { color = c; renderPickers(); } })));
  };
  renderPickers();

  const close = modal(isNew ? 'Neue Gruppe' : 'Gruppe bearbeiten', [
    field('Name', name),
    field('Symbol', iconRow),
    field('Farbe', colorRow),
    foreignRow,
    h('div', { class: 'note' }, 'Belohnungen einer anderen App kann die Suite sortieren und für Alerts stummschalten, aber nicht übernehmen. Bearbeiten geht über „↗ Dashboard“.'),
  ], [
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        const saved = await call('groups/save', { id: group?.id, name: name.value, icon, color, foreign }, isNew ? 'Gruppe angelegt' : 'Gespeichert');
        if (!saved) return;
        close();
        state.selected = saved.id;
        await load();
        if (isNew) openMembers(groupById(saved.id));
      },
    }, isNew ? 'Anlegen' : 'Speichern'),
  ]);
  setTimeout(() => name.focus(), 0);
}

function checkList(items, checkedIds) {
  const checked = new Set(checkedIds);
  const list = h('div', { class: 'check-list' }, ...items.map((item) =>
    h('label', {},
      h('input', { type: 'checkbox', checked: checked.has(item.id), onchange: (e) => (e.target.checked ? checked.add(item.id) : checked.delete(item.id)) }),
      h('span', {}, item.label),
      item.extra ? h('span', { class: 'cost' }, item.extra) : null)));
  return { list, checked };
}

function openMembers(group) {
  const search = h('input', { type: 'search', placeholder: 'Suchen…' });
  const { list, checked } = checkList(
    state.data.rewards.map((r) => ({ id: r.id, label: `${r.manageable ? '' : '🔒 '}${r.title}`, extra: r.cost.toLocaleString('de-DE') })),
    group.rewardIds);
  search.oninput = () => {
    const q = search.value.toLowerCase();
    [...list.children].forEach((label) => { label.hidden = !label.textContent.toLowerCase().includes(q); });
  };
  const close = modal(`${group.icon} ${group.name}: Belohnungen`, [
    h('div', { class: 'note' }, 'Hake alle Belohnungen an, die zu dieser Gruppe gehören. 🔒 = kann die Suite nicht pausieren, aber für Alerts stummschalten.'),
    search,
    list,
  ], [
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        if (await call('groups/members', { id: group.id, rewardIds: [...checked] }, 'Gruppe gespeichert')) {
          close();
          await load();
        }
      },
    }, 'Speichern'),
  ]);
}

function openRewardGroups(reward) {
  if (!state.data.groups.length) {
    toast('Lege zuerst links eine Gruppe an.');
    openGroupEditor(null);
    return;
  }
  const { list, checked } = checkList(
    state.data.groups.map((g) => ({ id: g.id, label: `${g.icon} ${g.name}` })),
    groupsOf(reward.id).map((g) => g.id));
  const close = modal(`Gruppen: ${reward.title}`, [list], [
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        if (await call('groups/assign', { rewardId: reward.id, groupIds: [...checked] }, 'Gespeichert')) {
          close();
          await load();
        }
      },
    }, 'Speichern'),
  ]);
}

function openRewardEditor(reward) {
  const isNew = !reward;
  const d = structuredClone(reward?.data ?? {
    title: '', cost: 100, prompt: '', is_enabled: true, background_color: '#9146FF',
    is_user_input_required: false,
    is_max_per_stream_enabled: false, max_per_stream: 1,
    is_max_per_user_per_stream_enabled: false, max_per_user_per_stream: 1,
    is_global_cooldown_enabled: false, global_cooldown_seconds: 60,
    should_redemptions_skip_request_queue: false,
  });

  const title = h('input', { type: 'text', value: d.title, maxlength: 45, placeholder: 'z.B. Hydrate!' });
  const titleCount = h('div', { class: 'counter' }, `${d.title.length}/45`);
  title.oninput = () => { titleCount.textContent = `${title.value.length}/45`; };
  const cost = h('input', { type: 'number', value: d.cost, min: 1 });
  const prompt = h('textarea', { rows: 3, maxlength: 200, placeholder: 'Was passiert, wenn man die Belohnung einlöst?' });
  prompt.value = d.prompt;
  const color = h('input', { type: 'color', value: d.background_color });

  // Option mit Schalter und optionaler Zahl
  const option = (label, key, numberKey, unit) => {
    const num = numberKey ? h('input', { type: 'number', min: 1, value: d[numberKey], disabled: !d[key] }) : null;
    if (num) num.onchange = () => { d[numberKey] = Number(num.value); };
    return h('div', { class: 'opt-row' },
      toggle(d[key], (on) => { d[key] = on; if (num) num.disabled = !on; }, label),
      h('span', {}, label),
      num, unit ? h('span', { class: 'muted' }, unit) : null);
  };

  const groupPick = isNew && state.data.groups.length
    ? checkList(state.data.groups.map((g) => ({ id: g.id, label: `${g.icon} ${g.name}` })), state.data.groups.some((g) => g.id === state.selected) ? [state.selected] : [])
    : null;

  const close = modal(isNew ? 'Neue Belohnung' : `Bearbeiten: ${reward.title}`, [
    h('div', { class: 'f-row' }, field('Name', title, titleCount), field('Kosten (Punkte)', cost)),
    field('Beschreibung', prompt),
    field('Hintergrundfarbe', h('div', { class: 'color-row' }, color)),
    option('Sichtbar für Zuschauer', 'is_enabled'),
    option('Zuschauer muss Text eingeben', 'is_user_input_required'),
    option('Max. pro Stream', 'is_max_per_stream_enabled', 'max_per_stream', 'mal'),
    option('Max. pro Zuschauer & Stream', 'is_max_per_user_per_stream_enabled', 'max_per_user_per_stream', 'mal'),
    option('Abklingzeit', 'is_global_cooldown_enabled', 'global_cooldown_seconds', 'Sekunden'),
    option('Einlösungen sofort als erledigt markieren', 'should_redemptions_skip_request_queue'),
    groupPick ? field('Gruppen', groupPick.list) : null,
    h('div', { class: 'note' }, 'Ein eigenes Bild kann Twitch nicht per App setzen. Das geht nur im ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openDashboard(); } }, 'Twitch-Dashboard'), '.'),
  ], [
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        const data = { ...d, title: title.value, cost: Number(cost.value), prompt: prompt.value, background_color: color.value };
        const saved = await call('rewards/save', { id: reward?.id, data, groupIds: groupPick ? [...groupPick.checked] : [] }, isNew ? 'Belohnung angelegt' : 'Gespeichert');
        if (!saved) return;
        close();
        await load();
      },
    }, isNew ? 'Anlegen' : 'Speichern'),
  ]);
  setTimeout(() => title.focus(), 0);
}

// ============================================================ Start

function render() {
  renderNav();
  renderHead();
  renderImports();
  renderRewards();
}

(async () => {
  $('#search').oninput = (e) => {
    state.search = e.target.value;
    renderRewards();
  };
  $('#reload').onclick = load;
  $('#new-group').onclick = () => openGroupEditor(null);
  $('#new-reward').onclick = () => {
    if (!state.data) return toast(state.error || 'Noch nicht geladen', 'err');
    if (state.data.rewards.length >= state.data.max) return toast(`Twitch erlaubt höchstens ${state.data.max} Belohnungen.`, 'err');
    openRewardEditor(null);
  };
  try {
    state.login = (await api('core/status')).auth.user?.login ?? '';
  } catch {
    // egal
  }
  render();
  await load();
})();
