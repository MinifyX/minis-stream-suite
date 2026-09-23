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
  try {
    state.game = await api(`${BASE}/game`);
  } catch {
    state.game = null;
  }
  try {
    state.keybinds = await api(`${BASE}/keybinds`);
  } catch {
    state.keybinds = { enabled: false, binds: {} };
  }
  try {
    state.satellite = await api('core/satellite');
  } catch {
    state.satellite = null;
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
      h('span', { class: color ? 'g-name no-i18n' : 'g-name' }, name),
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
  const hasRules = state.data.groups.some((g) => g.gameRule?.games.length) || Object.keys(state.data.rewardRules ?? {}).length > 0;
  const stats = h('div', { class: 'stat-row' },
    state.game?.current
      ? h('span', { class: 'badge accent', title: 'Aktuelle Kategorie deines Kanals' }, `🎮 ${state.game.current.name || 'Keine Kategorie'}`)
      : null,
    hasRules ? h('button', { class: 'btn small', title: 'Spiel-Regeln mit dem aktuellen Spiel neu anwenden', onclick: applyRulesNow }, '🎮 Regeln anwenden') : null,
    keybindSwitch(),
    satelliteButton(),
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
      h('h1', { class: 'no-i18n' }, `${group.icon} ${group.name}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => openMembers(group) }, '＋ Belohnungen zuordnen'),
      h('button', { class: 'btn small', onclick: () => openGroupEditor(group) }, '✎ Bearbeiten'),
      h('button', { class: 'btn small', onclick: () => deleteGroup(group) }, '🗑')),
    h('div', { class: 'group-panel' },
      alertsRow,
      gameRuleRow(group, members),
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

// ============================================================ Spiel-Regeln

function gameRuleRow(group, members) {
  const rule = group.gameRule;
  const games = rule?.games ?? [];
  const current = state.game?.current;
  const locked = members.filter((r) => !r.manageable).length;

  const status = !games.length
    ? h('span', { class: 'muted' }, 'Aus: immer aktiv, egal welches Spiel.')
    : current
      ? games.some((g) => g.id === current.id)
        ? h('span', { class: 'badge ok' }, `Gerade aktiv (${current.name})`)
        : h('span', { class: 'badge warn' }, `Gerade ${rule.mode === 'hide' ? 'ausgeblendet' : 'pausiert'} (du spielst ${current.name || 'nichts'})`)
      : null;

  return h('div', { class: 'game-rule' },
    h('div', { class: 'row' },
      h('span', { class: 'label' }, '🎮 Nur bei Spiel'),
      ...games.map((g) => h('span', { class: 'game-chip' }, g.name,
        h('button', { class: 'chip-x', title: 'Entfernen', onclick: () => saveGameRule(group, games.filter((x) => x.id !== g.id), rule.mode) }, '✕'))),
      h('button', { class: 'btn small', onclick: () => openGamePicker(group) }, '＋ Spiel'),
      games.length
        ? h('select', {
          class: 'mode-select',
          onchange: (e) => saveGameRule(group, games, e.target.value),
        },
        h('option', { value: 'hide', selected: rule.mode === 'hide' }, 'Sonst ausblenden'),
        h('option', { value: 'pause', selected: rule.mode === 'pause' }, 'Sonst pausieren'))
        : null,
      status),
    games.length && locked
      ? h('div', { class: 'warn-note' }, `⚠ ${locked} Belohnung(en) dieser Gruppe sind 🔒 und werden nicht automatisch geschaltet. Twitch erlaubt das nur für Belohnungen, die die Suite verwaltet.`)
      : null);
}

async function saveGameRule(group, games, mode = 'hide') {
  const result = await call('groups/game-rule', { id: group.id, rule: games.length ? { games, mode } : null });
  if (!result) return;
  reportApply(result);
  await load();
}

function reportApply(result) {
  let message = result.changed ? `${result.changed} Belohnung(en) umgeschaltet` : 'Alles schon passend geschaltet';
  if (result.skipped?.length) message += ` · ${result.skipped.length} 🔒 übersprungen`;
  toast(message, result.failed?.length ? 'err' : 'ok');
  if (result.failed?.length) toast(result.failed.join('\n'), 'err');
}

async function applyRulesNow() {
  const result = await call('game-rules/apply', {});
  if (!result) return;
  reportApply(result);
  await load();
}

function openGamePicker(group) {
  const games = group.gameRule?.games ?? [];
  const mode = group.gameRule?.mode ?? 'hide';
  gamePicker(`Spiel für „${group.name}“`, 'Die Belohnungen dieser Gruppe sind nur bei den gewählten Spielen aktiv. Bei jedem Kategoriewechsel schaltet die Suite sie automatisch um.', async (game) => {
    if (games.some((g) => g.id === game.id)) return;
    await saveGameRule(group, [...games, { id: game.id, name: game.name }], mode);
  });
}

/** Eigene Spiel-Regel für eine einzelne Belohnung */
function openRewardGameRule(reward) {
  const existing = state.data.rewardRules?.[reward.id];
  const rule = structuredClone(existing ?? { games: [], mode: 'hide' });
  const bindGames = state.keybinds?.binds[reward.id]?.games ?? [];
  const groupRules = groupsOf(reward.id).filter((g) => g.gameRule?.games.length);
  const gamesBox = h('div', { class: 'kb-games' });

  function renderGames() {
    const missingFromBind = bindGames.filter((g) => !rule.games.some((x) => x.id === g.id));
    gamesBox.replaceChildren(
      ...rule.games.map((g) => h('span', { class: 'game-chip' }, g.name,
        h('button', { class: 'chip-x', title: 'Entfernen', onclick: () => { rule.games = rule.games.filter((x) => x.id !== g.id); renderGames(); } }, '✕'))),
      h('button', {
        class: 'btn small',
        onclick: () => gamePicker(`Spiel für „${reward.title}“`, 'Die Belohnung ist nur bei den gewählten Spielen aktiv. Bei jedem Kategoriewechsel schaltet die Suite sie automatisch um.', (game) => {
          if (!rule.games.some((g) => g.id === game.id)) rule.games.push(game);
          renderGames();
        }),
      }, '＋ Spiel'),
      missingFromBind.length
        ? h('button', { class: 'btn small', title: 'Die Spiele aus dem Keybind dieser Belohnung übernehmen', onclick: () => { rule.games.push(...missingFromBind); renderGames(); } }, '⌨ Spiele vom Keybind übernehmen')
        : null,
      rule.games.length ? null : h('span', { class: 'note' }, 'Kein Spiel gewählt: immer aktiv.'));
  }

  const save = async (games) => {
    const result = await call('rewards/game-rule', { rewardId: reward.id, rule: games.length ? { games, mode: rule.mode } : null });
    if (!result) return;
    close();
    reportApply(result);
    await load();
  };

  renderGames();
  const close = modal(`🎮 ${reward.title}`, [
    h('div', { class: 'sub' }, 'NUR AKTIV BEI SPIEL'),
    gamesBox,
    h('div', { class: 'sub' }, 'BEI ANDEREN SPIELEN'),
    h('select', { class: 'mode-select', onchange: (e) => { rule.mode = e.target.value; } },
      h('option', { value: 'hide', selected: rule.mode === 'hide' }, 'Ausblenden (Zuschauer sehen sie nicht)'),
      h('option', { value: 'pause', selected: rule.mode === 'pause' }, 'Pausieren (sichtbar, aber gesperrt)')),
    h('div', { class: 'note' }, 'Wechselst du die Kategorie zu einem der Spiele, wird die Belohnung automatisch wieder aktiv.'),
    groupRules.length
      ? h('div', { class: 'note' }, `Die eigene Regel hat Vorrang vor der Regel der Gruppe ${groupRules.map((g) => `„${g.name}“`).join(', ')}.`)
      : null,
    reward.manageable
      ? null
      : h('div', { class: 'warn-note' }, '⚠ Diese Belohnung ist 🔒 und kann nicht automatisch geschaltet werden. Twitch erlaubt das nur für Belohnungen, die die Suite verwaltet (⇪ Übernehmen).'),
  ], [
    existing ? h('button', { class: 'btn', onclick: () => save([]) }, '🗑 Regel entfernen') : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', { class: 'btn primary', onclick: () => save(rule.games) }, 'Speichern'),
  ].filter(Boolean));
}

/** Dialog zum Suchen eines Spiels (Twitch-Kategorie). onPick bekommt { id, name }. */
function gamePicker(title, hint, onPick) {
  const input = h('input', { type: 'search', placeholder: 'Spiel oder Kategorie suchen, z.B. Minecraft…' });
  const results = h('div', { class: 'game-results' });
  const current = state.game?.current;

  // Bei verschachtelten Dialogen (Keybind-Editor) den alten Inhalt merken und danach wiederherstellen
  const host = $('#modal-host');
  const previous = [...host.childNodes];
  const pick = async (game) => {
    close();
    host.replaceChildren(...previous);
    await onPick({ id: game.id, name: game.name });
  };
  const row = (game) => h('button', { class: 'game-result', onclick: () => pick(game) },
    game.image ? h('img', { src: game.image, alt: '' }) : h('span', { class: 'game-ph' }, '🎮'),
    h('span', {}, game.name));

  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) {
        results.replaceChildren();
        return;
      }
      try {
        const found = await api(`${BASE}/games/search?q=${encodeURIComponent(q)}`);
        results.replaceChildren(...(found.length ? found.map(row) : [h('div', { class: 'note' }, 'Nichts gefunden.')]));
      } catch (err) {
        results.replaceChildren(h('div', { class: 'warn-note' }, err.message));
      }
    }, 300);
  };

  const close = modal(title, [
    current?.id ? h('div', {}, h('div', { class: 'note' }, 'Gerade eingestellt:'), row(current)) : null,
    input,
    results,
    h('div', { class: 'note' }, hint),
  ], previous.length ? [h('button', { class: 'btn', onclick: () => { close(); host.replaceChildren(...previous); } }, 'Zurück')] : null);
  setTimeout(() => input.focus(), 0);
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
  const bind = state.keybinds?.binds[r.id];
  const ownRule = state.data.rewardRules?.[r.id];
  const status = [];
  if (bind) {
    status.push(h('span', {
      class: `badge${bind.enabled && state.keybinds.enabled ? ' accent' : ''}`,
      title: bind.enabled ? (state.keybinds.enabled ? 'Keybind aktiv' : 'Alle Keybinds sind per Not-Aus aus') : 'Keybind ausgeschaltet',
    }, `${bind.target === 'satellite' ? '🛰' : '⌨'} ${bind.steps.map((s) => comboLabel(s.keys)).join(' → ')}${bind.games.length ? ` (nur bei ${bind.games.map((g) => g.name).join(', ')})` : ''}`));
  }
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
      h('div', { class: 'r-title no-i18n', title: r.title }, r.title),
      r.prompt ? h('div', { class: 'r-prompt no-i18n', title: r.prompt }, r.prompt) : null,
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
        ...groupsOf(r.id).map((g) => h('span', { class: 'group-chip no-i18n', style: { background: `${g.color}55` } }, `${g.icon} ${g.name}`)),
        ownRule
          ? h('span', { class: 'badge accent', title: `Eigene Spiel-Regel: sonst ${ownRule.mode === 'hide' ? 'ausgeblendet' : 'pausiert'}` }, `🎮 nur bei ${ownRule.games.map((x) => x.name).join(', ')}`)
          : null,
        ...groupsOf(r.id).filter((g) => g.gameRule?.games.length).map((g) =>
          h('span', {
            class: `badge${ownRule ? '' : ' accent'}`,
            title: ownRule ? `Regel der Gruppe ${g.name} – gilt nicht, weil die Belohnung eine eigene Regel hat` : `Über Gruppe ${g.name}`,
            style: ownRule ? { textDecoration: 'line-through' } : undefined,
          }, `🎮 nur bei ${g.gameRule.games.map((x) => x.name).join(', ')}`)))),
    h('div', { class: 'r-actions' },
      h('button', {
        class: `icon-btn${ownRule ? ' on-accent' : ''}`,
        title: ownRule
          ? `Nur bei: ${ownRule.games.map((g) => g.name).join(', ')}`
          : 'Nur bei bestimmten Spielen anzeigen (sonst ausblenden oder pausieren)',
        onclick: () => openRewardGameRule(r),
      }, '🎮'),
      h('button', {
        class: `icon-btn${bind?.enabled ? ' on-accent' : ''}`,
        title: bind ? `Keybind: ${bind.steps.map((s) => comboLabel(s.keys)).join(' → ')}` : 'Keybind hinzufügen: Tastendruck beim Einlösen',
        onclick: () => openKeybindEditor(r),
      }, '⌨'),
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

// ============================================================ Keybinds

const { comboLabel } = window.KeyUI;
// Tastenbeschriftungen nach eigenem Layout, sobald bekannt
window.KeyUI.onLayoutReady(() => render());

function keybindSwitch() {
  const kb = state.keybinds;
  if (!kb) return null;
  const count = Object.values(kb.binds).filter((b) => b.enabled).length;
  if (!Object.keys(kb.binds).length) return null;
  return h('span', { class: `kill-switch${kb.enabled ? '' : ' off'}`, title: 'Not-Aus für alle Keybinds' },
    toggle(kb.enabled, async (on) => {
      try {
        state.keybinds.enabled = (await api(`${BASE}/keybinds/enabled`, { enabled: on })).enabled;
        toast(on ? 'Keybinds an' : 'Alle Keybinds aus', on ? 'ok' : 'info');
      } catch (err) {
        toast(err.message, 'err');
      }
      render();
    }, 'Keybinds an/aus'),
    kb.enabled ? `⌨ ${count} Keybind(s) aktiv` : '⌨ Keybinds aus');
}

// ============================================================ Satellite

function satelliteButton() {
  const sat = state.satellite;
  if (!sat) return null;
  const [cls, text] = !sat.enabled ? ['', '🛰 Satellite: aus'] : sat.connected ? ['ok', `🛰 ${sat.name} verbunden`] : ['warn', '🛰 Satellite: wartet…'];
  return h('button', { class: `badge-btn ${cls}`, title: 'Keybinds auf einem anderen PC (z.B. Gaming-PC) ausführen', onclick: openSatellite }, text);
}

function download(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function openSatellite() {
  const body = h('div', { class: 'sat' });
  let address = null;
  let poll = null;

  const refresh = async () => {
    if (!body.isConnected) {
      clearInterval(poll);
      return;
    }
    try {
      state.satellite = await api('core/satellite');
    } catch {
      return;
    }
    renderBody();
  };

  const setEnabled = async (on) => {
    try {
      state.satellite = await api('core/satellite/enabled', { enabled: on });
    } catch (err) {
      toast(err.message, 'err');
    }
    renderBody();
    render();
  };

  const downloadScript = async () => {
    try {
      const { filename, content } = await api('core/satellite/script', { address });
      download(filename, content);
      toast('Satellite-Datei gespeichert. Kopiere sie auf den Gaming-PC.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const regenerate = async () => {
    if (!confirm('Neuen Schlüssel erzeugen? Bereits verteilte Satellite-Dateien funktionieren dann nicht mehr, du musst eine neue herunterladen.')) return;
    try {
      state.satellite = await api('core/satellite/regenerate', {});
      toast('Neuer Schlüssel erzeugt. Lade die Satellite-Datei neu herunter.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    renderBody();
  };

  function renderBody() {
    const sat = state.satellite;
    if (!address || !sat.addresses.includes(address)) address = sat.addresses[0] ?? '127.0.0.1';
    const status = !sat.enabled
      ? h('div', { class: 'sat-status' }, h('span', { class: 'dot' }), 'Aus: Kein anderer PC kann sich verbinden.')
      : sat.error
        ? h('div', { class: 'sat-status err' }, h('span', { class: 'dot err' }), sat.error)
        : sat.connected
          ? h('div', { class: 'sat-status ok' }, h('span', { class: 'dot ok' }), `Verbunden mit „${sat.name}“ seit ${new Date(sat.since).toLocaleTimeString('de-DE')}`)
          : h('div', { class: 'sat-status warn' }, h('span', { class: 'dot warn' }), `Wartet auf den Satellite (Port ${sat.port})…`);

    body.replaceChildren(
      h('p', { class: 'note' }, 'Der Satellite ist eine kleine Datei für deinen Gaming-PC. Keybinds mit Ziel „🛰 Satellite“ werden dann dort gedrückt statt auf diesem PC.'),
      h('div', { class: 'opt-row' }, toggle(sat.enabled, setEnabled, 'Satellite-Zugang'), h('span', {}, 'Satellite-Zugang erlauben')),
      status,
      sat.enabled ? h('div', { class: 'sub' }, 'EINRICHTEN') : null,
      sat.enabled
        ? h('ol', { class: 'sat-steps' },
          h('li', {}, 'Adresse dieses PCs im Heimnetz: ',
            sat.addresses.length > 1
              ? h('select', { class: 'inline-select', onchange: (e) => { address = e.target.value; } },
                ...sat.addresses.map((a) => h('option', { value: a, selected: a === address }, a)))
              : h('code', {}, address),
            sat.addresses.length ? null : h('span', { class: 'warn-note' }, ' (keine Netzwerkadresse gefunden – ist der PC im Netzwerk?)')),
          h('li', {}, h('button', { class: 'btn primary small', onclick: downloadScript }, '⬇ Satellite-Datei herunterladen')),
          h('li', {}, 'Die Datei auf den Gaming-PC kopieren, z.B. per USB-Stick oder Netzwerkordner.'),
          h('li', {}, 'Auf dem Gaming-PC doppelklicken. Ein Fenster zeigt „Verbunden!“, das Fenster offen lassen.'),
          h('li', {}, 'Im Keybind-Editor bei „Ausführen auf“ den ', h('b', {}, '🛰 Satellite'), ' wählen.'))
        : null,
      sat.enabled
        ? h('div', { class: 'kb-tips' },
          h('div', {}, '🔥 Beim ersten Einschalten fragt Windows auf diesem PC evtl., ob die Suite im Netzwerk erreichbar sein darf: „Private Netzwerke“ erlauben. Sonst kommt der Satellite nicht durch.'),
          h('div', {}, '🔑 Die Datei enthält einen geheimen Schlüssel. Nicht öffentlich teilen (z.B. nicht in Discord posten).'),
          h('div', {}, '⚠ Läuft das Spiel als Administrator, muss auch der Satellite als Administrator laufen (Rechtsklick → Als Administrator ausführen).'))
        : null,
      sat.enabled ? h('button', { class: 'btn small', onclick: regenerate }, '🔑 Neuen Schlüssel erzeugen') : null,
    );
  }

  renderBody();
  modal('🛰 Satellite', [body], [h('button', { class: 'btn', onclick: () => { $('#modal-host').replaceChildren(); load(); } }, 'Schließen')]);
  poll = setInterval(refresh, 2000);
}

function openKeybindEditor(reward) {
  const existing = state.keybinds.binds[reward.id];
  const bind = structuredClone(existing ?? { enabled: true, steps: [], games: [], target: 'local' });
  bind.target ??= 'local';
  const editor = window.KeyUI.stepsEditor(bind.steps);
  const gamesBox = h('div', { class: 'kb-games' });

  function renderGames() {
    gamesBox.replaceChildren(
      ...bind.games.map((g) => h('span', { class: 'game-chip' }, g.name,
        h('button', { class: 'chip-x', title: 'Entfernen', onclick: () => { bind.games = bind.games.filter((x) => x.id !== g.id); renderGames(); } }, '✕'))),
      h('button', {
        class: 'btn small',
        onclick: () => gamePicker('Spiel für diesen Keybind', 'Der Keybind wird nur ausgeführt, wenn du eines dieser Spiele spielst.', (game) => {
          if (!bind.games.some((g) => g.id === game.id)) bind.games.push(game);
          renderGames();
        }),
      }, '＋ Spiel'),
      bind.games.length ? null : h('span', { class: 'note' }, 'Kein Spiel gewählt: wird immer ausgeführt.'));
  }

  const test = async () => {
    editor.stop();
    const steps = editor.clean();
    if (!steps.length) return toast('Erst eine Taste aufnehmen.', 'err');
    try {
      await api(`${BASE}/keybinds/test`, { steps, waitMs: 3000, target: bind.target });
    } catch (err) {
      return toast(err.message, 'err');
    }
    toast(bind.target === 'satellite'
      ? 'In 3 Sekunden werden die Tasten auf dem Satellite-PC gedrückt.'
      : 'In 3 Sekunden werden die Tasten gedrückt, wechsle jetzt ins Ziel-Fenster…');
  };

  const save = async (remove = false) => {
    editor.stop();
    const payload = remove ? null : { enabled: bind.enabled, steps: editor.clean(), games: bind.games, target: bind.target };
    if (payload && !payload.steps.length) return toast('Erst eine Taste aufnehmen.', 'err');
    try {
      await api(`${BASE}/keybinds/save`, { rewardId: reward.id, title: reward.title, bind: payload });
    } catch (err) {
      return toast(err.message, 'err');
    }
    toast(remove ? 'Keybind entfernt' : 'Keybind gespeichert', 'ok');
    close();
    await load();
  };

  renderGames();
  const close = modal(`⌨ Keybind: ${reward.title}`, [
    h('div', { class: 'opt-row' }, toggle(bind.enabled, (on) => { bind.enabled = on; }, 'Aktiv'), h('span', {}, 'Beim Einlösen Tasten drücken')),
    h('div', { class: 'sub' }, 'AUSFÜHREN AUF'),
    window.KeyUI.targetPicker(bind, state.satellite, openSatellite),
    h('div', { class: 'sub' }, 'TASTENFOLGE'),
    editor.el,
    h('div', { class: 'sub' }, 'NUR BEI SPIEL'),
    gamesBox,
    window.KeyUI.tips(),
  ], [
    existing ? h('button', { class: 'btn', onclick: () => save(true) }, '🗑 Entfernen') : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: test }, '▶ Testen (3 s)'),
    h('button', { class: 'btn', onclick: () => { editor.stop(); close(); } }, 'Abbrechen'),
    h('button', { class: 'btn primary', onclick: () => save(false) }, 'Speichern'),
  ].filter(Boolean));
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
      h('span', { class: 'no-i18n' }, item.label),
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
