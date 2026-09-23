const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/goals';
const { fmt } = GoalRender;

/** Art des Ziels → [Name, Erklärung] */
const TYPES = {
  followers: ['👥 Follower gesamt',
    'Alle Follower deines Kanals. Der Stand kommt von Twitch und zählt live mit jedem Follow hoch. Alle 5 Minuten gleicht die Suite mit Twitch ab (z.B. wegen Entfolgungen).'],
  followersSince: ['👋 Neue Follower seit Reset',
    'Follower seit dem Zurücksetzen: Twitch-Gesamtzahl minus Startwert, dazwischen live gezählt. Mit „bei Stream-Start zurücksetzen“ ein schönes Tagesziel.'],
  subs: ['⭐ Abos gesamt',
    'Anzahl deiner Abonnenten laut Twitch. Gezählt werden Personen, nicht Abo-Punkte: ein Tier-3-Abo zählt 1 (bei Punkten wären es 6). So verstehen es Zuschauer am besten. Neue und verschenkte Abos zählen live mit, abgelaufene merkt die Suite beim nächsten Abgleich mit Twitch.'],
  subsSince: ['🎉 Abos seit Reset',
    'Neue und verschenkte Abos seit dem Zurücksetzen, auf Wunsch auch Verlängerungen (Resubs). Gezählt wird live, solange die Suite läuft.'],
  bits: ['💎 Bits seit Reset',
    'Alle gecheerten Bits seit dem Zurücksetzen. Gezählt wird live, solange die Suite läuft.'],
  redemptions: ['✨ Kanalpunkte-Einlösungen',
    'Wie oft eine bestimmte Belohnung eingelöst wurde. Zurückerstattete Einlösungen werden wieder abgezogen.'],
  custom: ['✏️ Eigener Zähler',
    'Zählt nur, wenn du auf + oder − klickst. Z.B. für Siege, Tode, Liegestütze, Spenden …'],
};
const TWITCH_TOTALS = ['followers', 'subs'];

const LAYOUTS = [['bar', '▬ Balken'], ['slim', '▭ Schmal'], ['ring', '◯ Kreis']];
const RECENT_LAYOUTS = [['bar', '↔ Leiste'], ['list', '↕ Liste'], ['ticker', '🔁 Laufband']];
const PREVIEW_BGS = [['checker', 'Transparent'], ['game', 'Spiel-Szene'], ['black', 'Schwarz'], ['white', 'Weiß'], ['green', 'Greenscreen']];
const KIND_NAMES = {
  follow: 'Letzter Follower',
  sub: 'Letztes Abo (neu oder verlängert)',
  giftsub: 'Letztes Geschenk-Abo (wer verschenkt hat)',
  cheer: 'Letzter Cheer',
  raid: 'Letzter Raid',
  topcheer: 'Top-Cheerer des Streams',
};
/** Für die Vorschau, solange noch nichts passiert ist */
const SAMPLE_RECENT = {
  follow: { name: 'NeuerFan', amount: 0, months: 0, at: 0 },
  sub: { name: 'Luna', amount: 0, months: 7, at: 0 },
  giftsub: { name: 'Geschenkeonkel', amount: 5, months: 0, at: 0 },
  cheer: { name: 'maxart', amount: 500, months: 0, at: 0 },
  raid: { name: 'CoolerStreamer', amount: 42, months: 0, at: 0 },
  topcheer: { name: 'maxart', amount: 1200, months: 0, at: 0 },
};

let state = null;
let goals = [];
let selectedId = null;
/** null = noch nicht geladen, Array = geladen, String = Fehlermeldung */
let rewards = null;
let goalBg = 'game';
let recentBg = 'game';
let goalView = null;
let previewGoalId = null;
let recentView = null;
/** Test-Stand pro Ziel (vom Server, während ein Test läuft) */
let testGoals = {};
let testRecent = null;

const selected = () => goals.find((g) => g.id === selectedId) || null;
const goalUrl = (id) => `${location.origin}/addons/goals/overlay.html?goal=${encodeURIComponent(id)}`;

// ============================================================ Speichern

let saveTimer = null;
const pendingGoals = new Set();
let pendingRecent = false;

/** Etwas wurde geändert: what = Ziel-ID oder "recent" */
function changed(what) {
  if (what === 'recent') pendingRecent = true;
  else pendingGoals.add(what);
  $('#save-state').textContent = 'Nicht gespeichert…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  if (what === 'recent') renderRecentPreview();
  else {
    renderGoalPreview();
    renderGoalList();
  }
}

/** Nur die Felder, die man im Formular bearbeitet – der Stand gehört dem Server */
const editable = (g) => ({
  id: g.id, title: g.title, type: g.type, rewardId: g.rewardId, rewardTitle: g.rewardTitle, startTarget: g.startTarget,
  autoNext: g.autoNext, step: g.step, countResubs: g.countResubs, resetOnStream: g.resetOnStream, style: g.style,
});

/** Stand vom Server übernehmen (ohne die Formular-Objekte auszutauschen) */
function applyServer(g, s) {
  for (const key of ['value', 'count', 'offset', 'target', 'startTarget', 'baseline', 'resetAt']) g[key] = s[key];
}

async function save() {
  saveTimer = null;
  const ids = [...pendingGoals];
  pendingGoals.clear();
  const recent = pendingRecent;
  pendingRecent = false;
  try {
    for (const id of ids) {
      const g = goals.find((x) => x.id === id);
      if (!g) continue;
      applyServer(g, await api(`${BASE}/goals/save`, { goal: editable(g) }));
    }
    if (recent) await api(`${BASE}/recent/style`, { style: state.recentStyle });
    $('#save-state').textContent = 'Gespeichert ✓';
    updateValues();
  } catch (err) {
    $('#save-state').textContent = 'Fehler beim Speichern';
    toast(err.message, 'err');
  }
}

/** Offene Änderungen sofort speichern (vor Aktionen wie Test oder Zurücksetzen) */
async function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  await save();
}

// ============================================================ Formular-Bausteine

const field = (label, ...controls) => h('div', { class: 'f' }, h('label', {}, label), ...controls);
const group = (title, ...children) => h('div', { class: 'group' }, h('h2', {}, title), ...children.filter(Boolean));
const note = (text) => h('p', { class: 'note' }, text);

/** Eingabefelder, die bei Änderung onChange() aufrufen */
function makeForm(onChange) {
  const check = (label, obj, key, after) =>
    h('div', { class: 'check' }, toggle(obj[key], (on) => { obj[key] = on; onChange(); after?.(); }, label), h('span', {}, label));

  const select = (obj, key, options, after) => {
    const el = h('select', { onchange: (e) => { obj[key] = e.target.value; onChange(); after?.(); } },
      ...options.map(([v, l]) => h('option', { value: v }, l)));
    el.value = String(obj[key]);
    return el;
  };

  const number = (obj, key, min, max, after) => h('input', {
    type: 'number', min, max, value: obj[key],
    onchange: (e) => {
      const v = Math.max(min, Math.min(max, Math.round(Number(e.target.value) || 0)));
      e.target.value = v;
      obj[key] = v;
      after?.();
      onChange();
    },
  });

  const text = (obj, key, maxlength, placeholder) => h('input', {
    type: 'text', value: obj[key], maxlength, placeholder,
    oninput: (e) => { obj[key] = e.target.value; onChange(); },
  });

  const color = (obj, key) => {
    const picker = h('input', { type: 'color', value: obj[key] });
    const input = h('input', { type: 'text', value: obj[key], maxlength: 7 });
    picker.oninput = () => { input.value = picker.value.toUpperCase(); obj[key] = input.value; onChange(); };
    input.onchange = () => {
      const v = input.value.startsWith('#') ? input.value : `#${input.value}`;
      if (/^#[0-9a-f]{6}$/i.test(v)) {
        obj[key] = v.toUpperCase();
        picker.value = v;
        onChange();
      } else input.value = obj[key];
    };
    return h('div', { class: 'color' }, picker, input);
  };

  const seg = (obj, key, options, after) => {
    const box = h('div', { class: 'seg' });
    const render = () => box.replaceChildren(...options.map(([v, l]) =>
      h('button', { class: obj[key] === v ? 'on' : '', onclick: () => { obj[key] = v; render(); after?.(); onChange(); } }, l)));
    render();
    return box;
  };

  return { check, select, number, text, color, seg };
}

const fontOptions = () => Object.keys(GoalRender.FONTS).map((f) => [f, f]);

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('URL kopiert', 'ok');
  } catch {
    toast('Kopieren nicht möglich', 'err');
  }
}

function swatches(target, current, onPick) {
  target.replaceChildren(...PREVIEW_BGS.map(([id, label]) =>
    h('button', { class: `swatch bg-${id}${current === id ? ' selected' : ''}`, title: label, onclick: () => onPick(id) })));
}

// ============================================================ Ziele: Liste

function renderGoalList() {
  const list = $('#goal-list');
  if (!goals.length) {
    list.replaceChildren(h('div', { class: 'empty' }, 'Noch keine Ziele. Leg mit „+ Neues Ziel“ dein erstes an.'));
    return;
  }
  list.replaceChildren(...goals.map((g, i) => {
    const pct = Math.min(100, (g.value / Math.max(1, g.target)) * 100);
    const move = (direction) => async (e) => {
      e.stopPropagation();
      try {
        await api(`${BASE}/goals/move`, { id: g.id, direction });
        const j = i + (direction === 'up' ? -1 : 1);
        [goals[i], goals[j]] = [goals[j], goals[i]];
        renderGoalList();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    return h('div', { class: `goal-row${g.id === selectedId ? ' selected' : ''}`, onclick: () => selectGoal(g.id) },
      h('div', {},
        h('div', { class: 'g-name no-i18n' }, g.title || '(ohne Titel)'),
        h('div', { class: 'g-type' }, TYPES[g.type][0], g.type === 'redemptions' && g.rewardTitle ? h('span', { class: 'no-i18n' }, `: ${g.rewardTitle}`) : null)),
      h('div', { class: 'mini-bar' }, h('div', { style: { width: `${pct}%` } })),
      h('span', { class: 'g-num' }, `${fmt(g.value)} / ${fmt(g.target)}`),
      h('div', { class: 'row-btns' },
        h('button', { class: 'icon-btn', title: 'Nach oben', disabled: i === 0, onclick: move('up') }, '▲'),
        h('button', { class: 'icon-btn', title: 'Nach unten', disabled: i === goals.length - 1, onclick: move('down') }, '▼')));
  }));
}

function renderTypePicker() {
  $('#type-picker').replaceChildren(...Object.entries(TYPES).map(([type, [label]]) =>
    h('button', { onclick: () => createGoal(type) }, label)));
}

async function createGoal(type) {
  try {
    const goal = await api(`${BASE}/goals/create`, { type });
    goals.push(goal);
    $('#type-picker').hidden = true;
    selectGoal(goal.id);
    toast('Ziel angelegt', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function selectGoal(id) {
  selectedId = id;
  renderGoalList();
  renderGoalForm();
}

// ============================================================ Ziele: Bearbeiten

async function loadRewards() {
  try {
    rewards = await api(`${BASE}/rewards`);
  } catch (err) {
    rewards = err.message;
  }
  if (selected()?.type === 'redemptions') renderGoalForm();
}

function rewardField(g, F) {
  if (rewards === null) {
    void loadRewards();
    return field('Belohnung', note('Belohnungen werden geladen …'));
  }
  if (typeof rewards === 'string') {
    return field('Belohnung',
      note(`Belohnungen konnten nicht geladen werden: ${rewards}`),
      g.rewardTitle ? note(`Gewählt: ${g.rewardTitle}`) : null,
      h('div', {}, h('button', { class: 'btn small', onclick: () => { rewards = null; renderGoalForm(); } }, '↻ Nochmal versuchen')));
  }
  const options = [['', '– Belohnung wählen –'], ...rewards.map((r) => [r.id, `${r.title} (${fmt(r.cost)})`])];
  if (g.rewardId && !rewards.some((r) => r.id === g.rewardId)) options.push([g.rewardId, `${g.rewardTitle || g.rewardId} (nicht mehr vorhanden)`]);
  const sel = F.select(g, 'rewardId', options, () => {
    g.rewardTitle = rewards.find((r) => r.id === g.rewardId)?.title ?? '';
  });
  sel.classList.add('no-i18n');
  return field('Belohnung', sel, note('Beim Wechsel der Belohnung fängt das Zählen von vorne an.'));
}

function renderGoalForm() {
  const g = selected();
  $('#goal-split').hidden = !g;
  if (!g) return;
  const F = makeForm(() => changed(g.id));
  const s = g.style;
  const isTotal = TWITCH_TOTALS.includes(g.type);
  const step = g.type === 'bits' ? 100 : 1;

  // ------------------------------------------------ Ziel
  const titleInput = F.text(g, 'title', 80, 'z.B. Follower-Ziel');
  titleInput.classList.add('no-i18n');
  const typeSelect = F.select(g, 'type', Object.entries(TYPES).map(([k, [label]]) => [k, label]), () => {
    // Neue Art → Server fängt neu an zu zählen; Formular passend neu aufbauen
    renderGoalForm();
  });

  const goalGroup = group('📝 Ziel',
    h('div', { class: 'row2' }, field('Titel (steht über dem Balken)', titleInput), field('Was wird gezählt?', typeSelect)),
    h('p', { class: 'type-info' }, TYPES[g.type][1]),
    g.type === 'redemptions' ? rewardField(g, F) : null,
    h('div', { class: 'row2' },
      field('Ziel', F.number(g, 'startTarget', 1, 1_000_000_000, () => { g.target = g.startTarget; })),
      g.autoNext ? field('Danach jeweils + …', F.number(g, 'step', 1, 1_000_000_000)) : h('div')),
    F.check('Automatisch nächstes Ziel, wenn erreicht (Ziel + Schritt)', g, 'autoNext', renderGoalForm),
    g.autoNext && g.target !== g.startTarget ? note(`Aktuelles Ziel: ${fmt(g.target)} (nach dem Zurücksetzen wieder ${fmt(g.startTarget)})`) : null,
    g.type === 'subsSince' ? F.check('Verlängerungen (Resubs) mitzählen', g, 'countResubs') : null,
    !isTotal ? F.check('Beim Stream-Start automatisch zurücksetzen', g, 'resetOnStream') : null);

  // ------------------------------------------------ Stand
  const setInput = h('input', { type: 'number', min: 0, placeholder: 'Neuer Wert' });
  const doSet = () => {
    if (setInput.value === '') return;
    adjust(g, { value: Number(setInput.value) });
    setInput.value = '';
  };
  setInput.onkeydown = (e) => { if (e.key === 'Enter') doSet(); };

  const valueGroup = group('🔢 Stand',
    h('div', { class: 'value-box' },
      h('div', { class: 'big-value', id: 'big-value' }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => adjust(g, { delta: -step }) }, `−${step}`),
        h('button', { class: 'btn', onclick: () => adjust(g, { delta: step }) }, `+${step}`))),
    h('div', { class: 'set-row' }, setInput, h('button', { class: 'btn small', onclick: doSet }, 'Wert setzen')),
    h('p', { class: 'note', id: 'value-info' }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => resetGoal(g) }, isTotal ? '↻ Korrektur löschen & neu von Twitch laden' : '⟲ Zurücksetzen (auf 0)'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => deleteGoal(g) }, '🗑 Ziel löschen')));

  // ------------------------------------------------ Aussehen
  const layoutChanged = () => {
    // Kreis braucht eine andere Größe als ein Balken
    if (s.layout === 'ring' && s.width > 450) s.width = 260;
    if (s.layout !== 'ring' && s.width < 300) s.width = 600;
    renderGoalForm();
  };
  const styleGroup = group('🎨 Aussehen',
    F.seg(s, 'layout', LAYOUTS, layoutChanged),
    h('div', { class: 'row3' },
      field('Schriftart', F.select(s, 'font', fontOptions())),
      field('Schriftgröße (px)', F.number(s, 'fontSize', 10, 120)),
      field(s.layout === 'ring' ? 'Durchmesser (px)' : 'Breite (px)', F.number(s, 'width', 80, 1920))),
    h('div', { class: 'row3' },
      field('Balken', F.color(s, 'barColor')),
      field('Verlauf bis', F.color(s, 'barColor2')),
      field('Textfarbe', F.color(s, 'textColor'))),
    h('div', { class: 'row2' },
      field('Hintergrund des Balkens', F.color(s, 'trackColor')),
      field('Deckkraft Hintergrund (%)', F.number(s, 'trackOpacity', 0, 100))),
    note('Einfarbig: „Balken“ und „Verlauf bis“ auf dieselbe Farbe stellen.'),
    h('div', { class: 'row2' },
      h('div', { class: 'f' },
        F.check('Titel anzeigen', s, 'showTitle'),
        F.check('Zahlen anzeigen (12 / 50)', s, 'showNumbers'),
        F.check('Prozent anzeigen', s, 'showPercent')),
      h('div', { class: 'f' },
        F.check('Abgerundet', s, 'rounded'),
        F.check('Textschatten', s, 'textShadow'))),
    F.check('Feier mit Konfetti, wenn das Ziel erreicht ist', s, 'celebrate', renderGoalForm),
    s.celebrate ? field('Text bei der Feier (ersetzt kurz den Titel)', F.text(s, 'celebrateText', 80, 'Ziel erreicht! 🎉')) : null,
    goals.length > 1 ? h('div', {}, h('button', { class: 'btn small', onclick: () => copyStyle(g) }, '🎨 Dieses Aussehen für alle Ziele übernehmen')) : null);

  $('#goal-form').replaceChildren(goalGroup, valueGroup, styleGroup);
  $('#goal-url').value = goalUrl(g.id);
  $('#goal-test-step').textContent = `🧪 +${step}${g.type === 'bits' ? ' Bits' : ''} testen`;
  updateValues();
  renderGoalPreview();
}

/** Zahlen im Formular und in der Liste aktualisieren (ohne das Formular neu zu bauen) */
function updateValues() {
  renderGoalList();
  const g = selected();
  const big = $('#big-value');
  if (!g || !big) return;
  big.replaceChildren(fmt(g.value), h('small', {}, ` / ${fmt(g.target)}`));
  let info = '';
  if (TWITCH_TOTALS.includes(g.type)) {
    info = 'Stand von Twitch, live weitergezählt.';
    if (g.offset) info += ` Deine Korrektur: ${g.offset > 0 ? '+' : ''}${fmt(g.offset)}.`;
  } else if (g.type !== 'custom') {
    info = `Gezählt seit ${new Date(g.resetAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}.`;
    if (g.offset) info += ` Davon von Hand korrigiert: ${g.offset > 0 ? '+' : ''}${fmt(g.offset)}.`;
  }
  $('#value-info').textContent = info;
}

async function adjust(g, body) {
  await flush();
  try {
    applyServer(g, await api(`${BASE}/goals/adjust`, { id: g.id, ...body }));
    updateValues();
    renderGoalPreview();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function resetGoal(g) {
  if (!TWITCH_TOTALS.includes(g.type) && !confirm(`„${g.title}“ wirklich auf 0 zurücksetzen?`)) return;
  await flush();
  try {
    applyServer(g, await api(`${BASE}/goals/reset`, { id: g.id }));
    renderGoalForm();
    toast('Zurückgesetzt', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteGoal(g) {
  if (!confirm(`Ziel „${g.title}“ löschen? Das Overlay dazu zeigt danach nichts mehr an.`)) return;
  pendingGoals.delete(g.id);
  try {
    await api(`${BASE}/goals/delete`, { id: g.id });
    goals = goals.filter((x) => x.id !== g.id);
    selectGoal(goals[0]?.id ?? null);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function copyStyle(g) {
  if (!confirm('Das Aussehen dieses Ziels auf alle anderen Ziele übertragen?')) return;
  await flush();
  try {
    const list = await api(`${BASE}/goals/copy-style`, { id: g.id });
    for (const other of goals) {
      if (other.id !== g.id) other.style = list.find((x) => x.id === other.id)?.style ?? other.style;
    }
    toast('Aussehen übernommen', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function testGoal(celebrate) {
  const g = selected();
  if (!g) return;
  await flush();
  try {
    await api(`${BASE}/goals/test`, { id: g.id, celebrate });
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================ Ziele: Vorschau

function renderGoalPreview(reachedTarget = null) {
  const g = selected();
  if (!g) return;
  if (previewGoalId !== g.id) {
    const root = h('div');
    $('#goal-zoom').replaceChildren(root);
    goalView = GoalRender.mountGoal(root, { confettiHost: $('#goal-stage') });
    previewGoalId = g.id;
  }
  const test = testGoals[g.id];
  goalView.update({
    title: g.title,
    value: test ? test.value : g.value,
    target: test ? test.target : g.target,
    style: g.style,
  }, reachedTarget);

  const stage = $('#goal-stage');
  stage.className = `preview-stage no-i18n bg-${goalBg}`;
  const available = stage.clientWidth - 32;
  $('#goal-zoom').style.zoom = available > 0 ? Math.min(1, available / g.style.width) : 1;
  const w = g.style.width + 40;
  const hgt = g.style.layout === 'ring' ? g.style.width + g.style.fontSize * 2 + 40 : Math.round(g.style.fontSize * 4) + 40;
  $('#goal-size-hint').textContent = `${w} × ${hgt}`;
}

// ============================================================ Letzte Events

function renderRecentForm() {
  const st = state.recentStyle;
  const F = makeForm(() => changed('recent'));

  const kindRows = GoalRender.RECENT_ORDER.map((k) => {
    const label = F.text(st.labels, k, 40, 'keine Überschrift');
    label.classList.add('no-i18n');
    return h('div', { class: 'kind-row' },
      h('span', { class: 'k-icon' }, GoalRender.ICONS[k]),
      toggle(st.items[k], (on) => { st.items[k] = on; changed('recent'); }, KIND_NAMES[k]),
      field(KIND_NAMES[k], label));
  });

  $('#recent-form').replaceChildren(
    group('📋 Was angezeigt wird',
      note('Einschalten, was in der Leiste stehen soll. Die Überschrift kannst du frei ändern (leer = keine).'),
      ...kindRows,
      note('Top-Cheerer: wer im aktuellen Stream insgesamt die meisten Bits gecheert hat. Wird beim Stream-Start automatisch zurückgesetzt. Die letzten Werte bleiben auch nach einem Neustart der Suite erhalten.')),
    group('🎨 Aussehen',
      F.seg(st, 'layout', RECENT_LAYOUTS, renderRecentForm),
      st.layout === 'ticker' ? field('Laufband: Sekunden pro Eintrag', F.number(st, 'tickerSeconds', 2, 60)) : null,
      h('div', { class: 'row3' },
        field('Schriftart', F.select(st, 'font', fontOptions())),
        field('Schriftgröße (px)', F.number(st, 'fontSize', 10, 80)),
        field('Breite (px, 0 = automatisch)', F.number(st, 'width', 0, 1920))),
      h('div', { class: 'row2' },
        field('Textfarbe', F.color(st, 'textColor')),
        field('Überschriften', F.color(st, 'labelColor'))),
      h('div', { class: 'row2' },
        field('Hintergrund', F.color(st, 'background')),
        field('Deckkraft Hintergrund (%)', F.number(st, 'backgroundOpacity', 0, 100))),
      F.check('Icons anzeigen', st, 'showIcons'),
      F.check('Abgerundete Ecken', st, 'rounded'),
      F.check('Textschatten', st, 'textShadow')),
    group('🕘 Aktuelle Werte',
      h('div', { id: 'current-values', class: 'form' }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small', onclick: () => clearRecent() }, '🧹 Alle leeren'))),
  );
  renderCurrentValues();
  renderRecentPreview();
}

function renderCurrentValues() {
  const box = $('#current-values');
  if (!box) return;
  box.replaceChildren(...GoalRender.RECENT_ORDER.map((k) => {
    const entry = state.recent[k];
    const { name, detail } = GoalRender.recentText(k, entry);
    return h('div', { class: 'current-row' },
      h('span', { class: 'k-icon' }, GoalRender.ICONS[k]),
      h('span', { class: 'k-label' }, KIND_NAMES[k].replace(/ \(.*\)$/, '')),
      h('span', { class: 'k-value no-i18n' }, detail ? `${name} · ${detail}` : name),
      h('button', { class: 'icon-btn', title: 'Leeren', disabled: !entry, onclick: () => clearRecent(k) }, '✕'));
  }));
}

async function clearRecent(kind) {
  if (!kind && !confirm('Alle letzten Events leeren (auch den Top-Cheerer)?')) return;
  try {
    state.recent = await api(`${BASE}/recent/clear`, kind ? { kind } : {});
    renderCurrentValues();
    renderRecentPreview();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderRecentPreview(changedKinds = []) {
  if (!state) return;
  const st = state.recentStyle;
  if (!recentView) {
    const root = h('div');
    $('#recent-zoom').replaceChildren(root);
    recentView = GoalRender.mountRecent(root);
  }
  const data = testRecent ?? state.recent;
  const empty = GoalRender.RECENT_ORDER.every((k) => !data[k]);
  $('#recent-sample').hidden = !empty;
  // structuredClone, damit render.js nicht dasselbe Objekt vergleicht wie das Formular
  recentView.update(empty ? SAMPLE_RECENT : data, structuredClone(st), changedKinds);

  const stage = $('#recent-stage');
  stage.className = `preview-stage no-i18n bg-${recentBg}`;
  const zoom = $('#recent-zoom');
  zoom.style.zoom = 1;
  const available = stage.clientWidth - 32;
  const width = zoom.firstElementChild?.offsetWidth || 0;
  zoom.style.zoom = available > 0 && width > available ? available / width : 1;
}

// ============================================================ Live-Updates

function onMessage(msg) {
  if (msg.kind === 'goals') {
    if (msg.test) {
      testGoals = Object.fromEntries(msg.goals.map((g) => [g.id, { value: g.value, target: g.target }]));
    } else {
      testGoals = {};
      for (const g of msg.goals) {
        const local = goals.find((x) => x.id === g.id);
        if (local) {
          local.value = g.value;
          local.target = g.target;
        }
      }
      updateValues();
    }
    const reached = (msg.celebrate || []).find((c) => c.id === selectedId);
    renderGoalPreview(reached ? reached.target : null);
  } else if (msg.kind === 'recent') {
    testRecent = msg.test ? msg.recent : null;
    if (!msg.test) {
      state.recent = msg.recent;
      renderCurrentValues();
    }
    renderRecentPreview(msg.changed || []);
  }
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws?channel=goals`);
  ws.onmessage = (m) => {
    try {
      onMessage(JSON.parse(m.data));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

// ============================================================ Start

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  // Vorschau braucht die echte Breite → nach dem Umschalten neu messen
  if (name === 'recent') renderRecentPreview();
  else renderGoalPreview();
}

function renderRefreshInfo() {
  const info = $('#refresh-info');
  if (state.refreshError) info.textContent = `Twitch: ${state.refreshError}`;
  else if (state.lastRefresh) info.textContent = `Stand von Twitch: ${new Date(state.lastRefresh).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  else info.textContent = '';
}

async function refreshFromTwitch() {
  await flush();
  try {
    const res = await api(`${BASE}/refresh`, {});
    for (const s of res.goals) {
      const g = goals.find((x) => x.id === s.id);
      if (g) applyServer(g, s);
    }
    state.lastRefresh = res.lastRefresh;
    state.refreshError = null;
    renderRefreshInfo();
    updateValues();
    renderGoalPreview();
    toast('Von Twitch aktualisiert', 'ok');
  } catch (err) {
    state.refreshError = err.message;
    renderRefreshInfo();
    toast(err.message, 'err');
  }
}

(async () => {
  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  $('#add-goal').onclick = () => { $('#type-picker').hidden = !$('#type-picker').hidden; };
  $('#refresh').onclick = refreshFromTwitch;
  $('#goal-copy').onclick = () => copyText($('#goal-url').value);
  $('#goal-test-step').onclick = () => testGoal(false);
  $('#goal-test-celebrate').onclick = () => testGoal(true);
  const recentUrl = `${location.origin}/addons/goals/recent.html`;
  $('#recent-url').value = recentUrl;
  $('#recent-copy').onclick = () => copyText(recentUrl);
  $('#recent-test').onclick = () => api(`${BASE}/recent/test`, {}).catch((err) => toast(err.message, 'err'));

  const pickGoalBg = (id) => { goalBg = id; swatches($('#goal-swatches'), goalBg, pickGoalBg); renderGoalPreview(); };
  const pickRecentBg = (id) => { recentBg = id; swatches($('#recent-swatches'), recentBg, pickRecentBg); renderRecentPreview(); };
  swatches($('#goal-swatches'), goalBg, pickGoalBg);
  swatches($('#recent-swatches'), recentBg, pickRecentBg);
  renderTypePicker();

  try {
    state = await api(`${BASE}/state`);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  goals = state.goals;
  $('#login-note').hidden = state.loggedIn;
  renderRefreshInfo();
  selectGoal(goals[0]?.id ?? null);
  renderRecentForm();
  if (location.hash === '#recent') showTab('recent');
  window.addEventListener('resize', () => {
    renderGoalPreview();
    renderRecentPreview();
  });
  connect();
})();
