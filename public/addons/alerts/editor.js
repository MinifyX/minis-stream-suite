const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/alerts';

// ============================================================ Stammdaten

const CATEGORIES = {
  follow: { icon: '💜', name: 'Follows', vars: ['user'], sample: { user: 'maxart' }, userMessage: '' },
  sub: { icon: '⭐', name: 'Abos', vars: ['user', 'tier', 'months'], sample: { user: 'maxart', tier: '1', months: 12 }, userMessage: 'Schon ein Jahr dabei!' },
  giftsub: { icon: '🎁', name: 'Verschenkte Abos', vars: ['user', 'tier', 'count'], sample: { user: 'maxart', tier: '1', count: 5 }, userMessage: '' },
  cheer: { icon: '💎', name: 'Bits', vars: ['user', 'bits'], sample: { user: 'maxart', bits: 500 }, userMessage: 'Cheer500 GG!' },
  raid: { icon: '🚀', name: 'Raids', vars: ['user', 'viewers'], sample: { user: 'maxart', viewers: 42 }, userMessage: '' },
  hypetrain: { icon: '🚂', name: 'Hype Train', vars: ['level', 'total', 'top', 'type'], sample: { user: 'maxart', level: 3, total: 4200, top: 'maxart', type: 'Hype Train' }, userMessage: '' },
  redemption: { icon: '✨', name: 'Kanalpunkte', vars: ['user', 'reward', 'cost'], sample: { user: 'maxart', reward: 'Hydrate!', cost: 500 }, userMessage: 'Text vom Zuschauer' },
};
const HAS_USER_MESSAGE = ['sub', 'cheer', 'redemption'];

const ANIM_IN = [['pop', 'Aufploppen'], ['fade', 'Einblenden'], ['slide-down', 'Von oben'], ['slide-up', 'Von unten'], ['zoom', 'Heranzoomen'], ['bounce', 'Hüpfen'], ['none', 'Keine']];
const ANIM_OUT = [['fade', 'Ausblenden'], ['slide-up', 'Nach oben'], ['slide-down', 'Nach unten'], ['zoom', 'Wegzoomen'], ['none', 'Keine']];
const WEIGHTS = [[400, 'Normal'], [500, 'Medium'], [600, 'Halbfett'], [700, 'Fett'], [800, 'Extrafett'], [900, 'Black']];

// Kleine Symbole für Layout und Ausrichtung
const icon = (inner, vb = '0 0 40 28') => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${inner}</svg>`;
const IMG = (x, y, w, hh) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="2"/><path d="M${x + 2} ${y + hh - 2} l${w * 0.3} ${-hh * 0.45} l${w * 0.25} ${hh * 0.3} l${w * 0.15} ${-hh * 0.15} l${w * 0.3 - 4} ${hh * 0.3}" stroke-width="1.5"/>`;
const LINES = (x, y, w, n) => Array.from({ length: n }, (_, i) => `<line x1="${x}" y1="${y + i * 5}" x2="${x + w - (i % 2) * 5}" y2="${y + i * 5}"/>`).join('');
const LAYOUTS = [
  ['image-left', 'Bild links', icon(IMG(3, 7, 14, 14) + LINES(21, 10, 16, 3))],
  ['image-right', 'Bild rechts', icon(IMG(23, 7, 14, 14) + LINES(3, 10, 16, 3))],
  ['image-top', 'Bild oben', icon(IMG(13, 2, 14, 13) + LINES(9, 20, 22, 2))],
  ['image-bottom', 'Bild unten', icon(LINES(9, 4, 22, 2) + IMG(13, 13, 14, 13))],
  ['overlay', 'Text auf Bild', icon(IMG(6, 2, 28, 24) + LINES(12, 11, 16, 2))],
];
const ALIGN_LINES = {
  left: '<line x1="3" y1="4" x2="19" y2="4"/><line x1="3" y1="9" x2="13" y2="9"/><line x1="3" y1="14" x2="17" y2="14"/>',
  center: '<line x1="3" y1="4" x2="19" y2="4"/><line x1="6" y1="9" x2="16" y2="9"/><line x1="4" y1="14" x2="18" y2="14"/>',
  right: '<line x1="3" y1="4" x2="19" y2="4"/><line x1="9" y1="9" x2="19" y2="9"/><line x1="5" y1="14" x2="19" y2="14"/>',
  justify: '<line x1="3" y1="4" x2="19" y2="4"/><line x1="3" y1="9" x2="19" y2="9"/><line x1="3" y1="14" x2="19" y2="14"/>',
};
const ALIGNS = [['left', 'Links'], ['center', 'Mitte'], ['right', 'Rechts'], ['justify', 'Blocksatz']].map(([v, l]) => [v, l, icon(ALIGN_LINES[v], '0 0 22 18')]);
const TRAIN_PHASES = [['any', 'Immer (Start, Level-Aufstieg, Ende)'], ['start', 'Start'], ['levelup', 'Level-Aufstieg'], ['end', 'Ende']];
const PREVIEW_BGS = [['checker', 'Transparent'], ['black', 'Schwarz'], ['white', 'Weiß'], ['green', 'Greenscreen']];

// ============================================================ Zustand

const state = {
  s: null, // Einstellungen vom Server
  defaults: null,
  cat: 'follow',
  variantId: null,
  view: 'variant', // 'variant' | 'rewards' | 'history'
  history: null,
  historyError: '',
  historyHideMuted: false,
  openCats: new Set(['follow']),
  openSections: new Set(['general', 'layout', 'text', 'media']),
  rewards: null,
  rewardsError: '',
  rewardSearch: '',
  media: [],
  voices: null,
  autoplay: true,
  previewBg: 'checker',
};

let preview = null;
let dragInfo = null;

const category = () => state.s.categories[state.cat];
const variant = () => category()?.variants.find((v) => v.id === state.variantId) ?? null;
const rewardById = (id) => state.rewards?.find((r) => r.id === id);

function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem('alerts-editor') || '{}');
    if (typeof prefs.autoplay === 'boolean') state.autoplay = prefs.autoplay;
    if (PREVIEW_BGS.some(([id]) => id === prefs.previewBg)) state.previewBg = prefs.previewBg;
  } catch {
    // egal
  }
}
function savePrefs() {
  try {
    localStorage.setItem('alerts-editor', JSON.stringify({ autoplay: state.autoplay, previewBg: state.previewBg }));
  } catch {
    // egal
  }
}

// ============================================================ Speichern

let saveTimer = null;
let savePending = false;

function markDirty({ sidebar = false, props = false, previewUpdate = true } = {}) {
  savePending = true;
  $('#save-state').textContent = 'Nicht gespeichert…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
  if (sidebar) renderSidebar();
  if (props) renderProps();
  if (previewUpdate) schedulePreview();
}

async function save() {
  clearTimeout(saveTimer);
  if (!savePending) return;
  savePending = false;
  try {
    await api(`${BASE}/categories`, { categories: state.s.categories });
    $('#save-state').textContent = 'Gespeichert ✓';
  } catch (err) {
    $('#save-state').textContent = 'Fehler beim Speichern';
    toast(err.message, 'err');
  }
}

// ============================================================ Formular-Bausteine

const field = (label, ...controls) => h('div', { class: 'f' }, h('label', {}, label), ...controls);
const row2 = (...children) => h('div', { class: 'f-row' }, ...children);
const subHead = (text) => h('div', { class: 'sub-head' }, text);
const iconSpan = (svg) => {
  const span = h('span');
  span.innerHTML = svg; // nur unsere eigenen, festen SVGs
  return span;
};

function textInput(value, oninput, attrs = {}) {
  return h('input', { type: 'text', value, ...attrs, oninput: (e) => oninput(e.target.value) });
}

function numInput(value, onchange, { min = 0, max = 99999, step = 1 } = {}) {
  return h('input', {
    type: 'number', value, min, max, step,
    onchange: (e) => {
      let v = Number(e.target.value);
      if (!Number.isFinite(v)) v = min;
      v = Math.min(max, Math.max(min, v));
      e.target.value = v;
      onchange(v);
    },
  });
}

function selectInput(options, value, onchange) {
  const el = h('select', { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, l]) => h('option', { value: v }, l)));
  el.value = String(value);
  return el;
}

function colorInput(value, onchange) {
  const picker = h('input', { type: 'color', value: value.slice(0, 7) });
  const text = h('input', { type: 'text', value, maxlength: 7 });
  picker.oninput = () => {
    text.value = picker.value.toUpperCase();
    onchange(text.value);
  };
  text.onchange = () => {
    const v = text.value.startsWith('#') ? text.value : `#${text.value}`;
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      text.value = v.toUpperCase();
      picker.value = v;
      onchange(text.value);
    } else text.value = picker.value.toUpperCase();
  };
  return h('div', { class: 'color' }, picker, text);
}

function slider(value, min, max, oninput, suffix = '%') {
  const out = h('span', { class: 'slider-val' }, `${value}${suffix}`);
  return h('div', { class: 'slider' },
    h('input', { type: 'range', min, max, value, oninput: (e) => { out.textContent = `${e.target.value}${suffix}`; oninput(Number(e.target.value)); } }),
    out);
}

function checkRow(label, value, onchange) {
  return h('div', { class: 'check-row' }, toggle(value, onchange, label), h('span', {}, label));
}

function choice(options, value, onchange, small = false) {
  return h('div', { class: `choice${small ? ' small' : ''}` }, ...options.map(([v, label, svg]) =>
    h('button', { class: v === value ? 'selected' : '', title: label, onclick: () => onchange(v) },
      svg ? iconSpan(svg) : null, svg && small ? null : h('span', {}, label))));
}

// ============================================================ Linke Spalte

function summary(catId, v) {
  const c = v.conditions;
  switch (catId) {
    case 'follow':
      return 'Jeder neue Follow';
    case 'sub': {
      const parts = [{ any: 'Alle Abos', new: 'Nur neue Abos', resub: 'Nur Verlängerungen' }[c.subKind]];
      if (c.tier !== 'any') parts.push(`Tier ${c.tier / 1000}`);
      if (c.minMonths > 1) parts.push(`ab ${c.minMonths} Monaten`);
      return parts.join(' · ');
    }
    case 'giftsub':
      return c.minCount > 1 ? `Ab ${c.minCount} Abos` : 'Alle verschenkten Abos';
    case 'cheer':
      return c.minBits > 1 ? `Ab ${c.minBits} Bits` : 'Alle Cheers';
    case 'raid':
      return c.minViewers > 1 ? `Ab ${c.minViewers} Zuschauern` : 'Alle Raids';
    case 'hypetrain': {
      const parts = [{ any: 'Start, Level-Aufstieg & Ende', start: 'Start', levelup: 'Level-Aufstieg', end: 'Ende' }[c.trainPhase]];
      if (c.trainPhase !== 'start' && c.minLevel > 1) parts.push(`ab Level ${c.minLevel}`);
      if (c.goldenOnly) parts.push('nur Golden Kappa');
      return parts.join(' · ');
    }
    case 'redemption': {
      if (c.rewardMode === 'all') return 'Alle Belohnungen (außer gefilterte)';
      if (!c.rewardIds.length) return '⚠ Keine Belohnung ausgewählt';
      const names = c.rewardIds.map((id) => rewardById(id)?.title ?? state.s.rewards[id]?.title ?? 'Unbekannt');
      return names.length <= 2 ? names.join(', ') : `${names[0]}, ${names[1]} +${names.length - 2}`;
    }
  }
  return '';
}

function renderSidebar() {
  $('#history-btn').classList.toggle('selected', state.view === 'history');
  $('#categories').replaceChildren(...Object.entries(CATEGORIES).map(([catId, meta]) => {
    const cat = state.s.categories[catId];
    const open = state.openCats.has(catId);
    const active = cat.variants.filter((v) => v.enabled).length;
    const head = h('button', {
      class: 'cat-head',
      onclick: () => {
        if (open) state.openCats.delete(catId);
        else state.openCats.add(catId);
        renderSidebar();
      },
    },
    h('span', { class: 'cat-icon' }, meta.icon),
    h('span', { class: 'cat-name' }, meta.name),
    h('span', { class: `badge${active ? ' ok' : ''}`, title: 'aktive / alle Varianten' }, `${active}/${cat.variants.length}`),
    h('span', { class: 'chev' }, open ? '▲' : '▼'));

    if (!open) return h('div', { class: 'cat' }, head);

    return h('div', { class: 'cat' }, head, h('div', { class: 'cat-body' },
      h('div', { class: 'cat-row' },
        toggle(cat.randomize, (on) => { cat.randomize = on; markDirty({ previewUpdate: false }); }, 'Zufällig'),
        h('span', {}, 'Zufällig abwechseln'),
        h('span', { class: 'hint', title: 'An: Aus allen passenden aktiven Varianten wird zufällig eine gewählt.\nAus: Die oberste passende Variante gewinnt.' }, 'ⓘ')),
      h('button', { class: 'cat-add', onclick: () => addVariant(catId) }, '＋ Neue Variante'),
      h('div', { class: 'variant-list' }, ...cat.variants.map((v, i) => variantItem(catId, v, i))),
      catId === 'redemption'
        ? h('button', { class: `variant-item filter-item${state.view === 'rewards' ? ' selected' : ''}`, onclick: showRewards },
          h('span', { class: 'v-num' }, '🔕'),
          h('span', { class: 'v-text' }, h('strong', {}, 'Belohnungs-Filter'), h('small', {}, 'Belohnungen, die nie einen Alert auslösen')))
        : null));
  }));
}

function variantItem(catId, v, index) {
  const selected = state.view === 'variant' && state.cat === catId && state.variantId === v.id;
  const el = h('div', {
    class: `variant-item${selected ? ' selected' : ''}${v.enabled ? '' : ' disabled'}`,
    draggable: 'true',
    onclick: (e) => {
      if (!e.target.closest('.switch')) selectVariant(catId, v.id);
    },
  },
  h('span', { class: 'v-handle', title: 'Ziehen zum Sortieren' }, '⠿'),
  h('span', { class: 'v-num' }, index + 1),
  h('span', { class: 'v-text' }, h('strong', { class: v.name ? 'no-i18n' : null }, v.name || 'Ohne Namen'), h('small', {}, summary(catId, v))),
  toggle(v.enabled, (on) => { v.enabled = on; markDirty({ sidebar: true, previewUpdate: false }); }, `${v.name} aktiv`));

  el.addEventListener('dragstart', (e) => {
    dragInfo = { catId, index };
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => {
    if (dragInfo?.catId !== catId) return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragInfo?.catId !== catId) return;
    const list = state.s.categories[catId].variants;
    const [moved] = list.splice(dragInfo.index, 1);
    list.splice(index, 0, moved);
    dragInfo = null;
    markDirty({ sidebar: true, previewUpdate: false });
  });
  return el;
}

function selectVariant(catId, id) {
  state.view = 'variant';
  state.cat = catId;
  state.variantId = id;
  state.openCats.add(catId);
  renderAll();
}

function addVariant(catId) {
  const list = state.s.categories[catId].variants;
  const base = (state.cat === catId && variant()) || list[0];
  const v = {
    id: crypto.randomUUID(),
    name: `Variante ${list.length + 1}`,
    enabled: true,
    conditions: structuredClone(state.defaults.conditions),
    design: structuredClone(base ? base.design : state.defaults.design),
  };
  list.push(v);
  markDirty({ previewUpdate: false });
  selectVariant(catId, v.id);
}

function duplicateVariant() {
  const v = variant();
  const list = category().variants;
  const copy = { ...structuredClone(v), id: crypto.randomUUID(), name: `${v.name} (Kopie)` };
  list.splice(list.indexOf(v) + 1, 0, copy);
  markDirty({ previewUpdate: false });
  selectVariant(state.cat, copy.id);
}

function deleteVariant() {
  const v = variant();
  if (!confirm(`Variante „${v.name}“ wirklich löschen?`)) return;
  const list = category().variants;
  list.splice(list.indexOf(v), 1);
  state.variantId = list[0]?.id ?? null;
  markDirty({ previewUpdate: false });
  renderAll();
}

// ============================================================ Rechte Spalte

function section(id, emoji, title, body) {
  const open = state.openSections.has(id);
  return h('div', { class: 'sec' },
    h('button', {
      class: 'sec-head',
      onclick: () => {
        if (open) state.openSections.delete(id);
        else state.openSections.add(id);
        renderProps();
      },
    }, h('span', {}, emoji), h('span', { class: 'sec-title' }, title), h('span', { class: 'chev' }, open ? '▲' : '▼')),
    open ? h('div', { class: 'sec-body' }, ...body().filter(Boolean)) : null);
}

function renderProps() {
  const box = $('#props');
  const scroll = box.scrollTop;
  if (state.view === 'history') {
    box.replaceChildren(h('div', { class: 'props-empty' },
      h('p', {}, h('b', {}, 'Verlauf')),
      h('p', {}, 'Hier landen alle Follows, Abos, Bits, Raids, Hype Trains (Start, Level-Aufstieg, Ende) und Einlösungen, auch die ohne Alert (z.B. stumme HudFX-Belohnungen).'),
      h('p', {}, '„▶ Nochmal“ schickt den Alert erneut ans Overlay, mit deinen aktuellen Varianten. Praktisch, wenn ein Alert nicht durchkam oder OBS gerade zu war.'),
      h('p', {}, 'Die letzten 200 Events werden gespeichert.')));
    return;
  }
  if (state.view === 'rewards') {
    box.replaceChildren(h('div', { class: 'props-empty' },
      h('p', {}, h('b', {}, 'Belohnungs-Filter')),
      h('p', {}, 'Belohnungen, die hier ausgeschaltet sind, lösen nie einen Alert aus, egal welche Variante passen würde. Perfekt für HudFX & Co.'),
      h('p', {}, 'Welche Variante bei den übrigen Belohnungen erscheint, legst du links unter „Kanalpunkte“ fest.')));
    return;
  }
  const v = variant();
  if (!v) {
    box.replaceChildren(h('div', { class: 'props-empty' }, 'Wähle links eine Variante aus oder lege eine neue an.'));
    return;
  }
  box.replaceChildren(
    section('general', '⚙️', 'Allgemein', () => generalSection(v)),
    section('layout', '🔲', 'Layout', () => layoutSection(v.design)),
    section('text', '🔤', 'Text & Sprache', () => textSection(v.design)),
    section('media', '🖼️', 'Bild & Sound', () => mediaSection(v.design)),
    section('fx', '🎉', 'Effekte', () => fxSection(v.design)),
    section('variant', '🗂️', 'Variante', () => [
      h('button', { class: 'btn block', onclick: duplicateVariant }, '⧉ Variante duplizieren'),
      h('button', { class: 'btn danger block', onclick: deleteVariant }, '🗑 Variante löschen'),
    ]),
  );
  box.scrollTop = scroll;
}

function generalSection(v) {
  const d = v.design;
  return [
    field('Name', textInput(v.name, (val) => { v.name = val; markDirty({ sidebar: true, previewUpdate: false }); })),
    subHead('WANN KOMMT DIESE VARIANTE?'),
    ...conditionFields(v),
    subHead('ANZEIGE'),
    field('Anzeigedauer (Sekunden)', numInput(d.durationMs / 1000, (val) => { d.durationMs = Math.round(val * 1000); markDirty(); }, { min: 1, max: 60, step: 0.5 })),
    row2(
      field('Animation rein', selectInput(ANIM_IN, d.animationIn, (val) => { d.animationIn = val; markDirty(); })),
      field('Animation raus', selectInput(ANIM_OUT, d.animationOut, (val) => { d.animationOut = val; markDirty(); }))),
  ];
}

function conditionFields(v) {
  const c = v.conditions;
  const changed = () => markDirty({ sidebar: true });
  switch (state.cat) {
    case 'follow':
      return [h('div', { class: 'note' }, 'Bei jedem neuen Follow.')];
    case 'sub':
      return [
        row2(
          field('Art', selectInput([['any', 'Alle'], ['new', 'Nur neue'], ['resub', 'Nur Verlängerungen']], c.subKind, (val) => { c.subKind = val; changed(); })),
          field('Stufe', selectInput([['any', 'Alle'], ['1000', 'Tier 1 / Prime'], ['2000', 'Tier 2'], ['3000', 'Tier 3']], c.tier, (val) => { c.tier = val; changed(); }))),
        field('Ab wie vielen Monaten', numInput(c.minMonths, (val) => { c.minMonths = val; changed(); }, { min: 0, max: 240 })),
      ];
    case 'giftsub':
      return [field('Ab wie vielen verschenkten Abos', numInput(c.minCount, (val) => { c.minCount = val; changed(); }, { min: 1, max: 1000 }))];
    case 'cheer':
      return [field('Ab wie vielen Bits', numInput(c.minBits, (val) => { c.minBits = val; changed(); }, { min: 1, max: 1000000 }))];
    case 'raid':
      return [field('Ab wie vielen Zuschauern', numInput(c.minViewers, (val) => { c.minViewers = val; changed(); }, { min: 1, max: 1000000 }))];
    case 'hypetrain':
      return [
        field('Wann', selectInput(TRAIN_PHASES, c.trainPhase, (val) => { c.trainPhase = val; markDirty({ sidebar: true, props: true }); })),
        c.trainPhase !== 'start'
          ? field(c.trainPhase === 'end' ? 'Ab welchem erreichten Level' : 'Ab welchem Level', numInput(c.minLevel, (val) => { c.minLevel = val; changed(); }, { min: 1, max: 100 }))
          : null,
        c.trainPhase === 'any' && c.minLevel > 1 ? h('div', { class: 'note' }, 'Beim Start ist das Level immer 1, der Start-Alert kommt trotzdem.') : null,
        checkRow('Nur beim Golden Kappa Train', c.goldenOnly, (on) => { c.goldenOnly = on; changed(); }),
      ];
    case 'redemption':
      return rewardConditionFields(c);
  }
  return [];
}

function rewardConditionFields(c) {
  const fields = [
    field('Für welche Belohnungen', selectInput([['all', 'Alle Belohnungen'], ['some', 'Nur ausgewählte']], c.rewardMode, (val) => {
      c.rewardMode = val;
      markDirty({ sidebar: true, props: true });
    })),
  ];
  if (c.rewardMode === 'all') {
    fields.push(h('div', { class: 'note' }, 'Tipp: Varianten mit ausgewählten Belohnungen nach oben ziehen. Diese allgemeine Variante fängt dann den Rest auf.'));
    return fields;
  }
  if (!state.rewards) {
    fields.push(h('div', { class: 'warn-note' }, state.rewardsError || 'Lade Belohnungen…'));
    return fields;
  }
  const list = h('div', { class: 'reward-pick' });
  const renderList = () => {
    const q = state.rewardSearch.toLowerCase();
    list.replaceChildren(...state.rewards.filter((r) => r.title.toLowerCase().includes(q)).map((r) =>
      h('label', {},
        h('input', {
          type: 'checkbox',
          checked: c.rewardIds.includes(r.id),
          onchange: (e) => {
            c.rewardIds = e.target.checked ? [...c.rewardIds, r.id] : c.rewardIds.filter((id) => id !== r.id);
            markDirty({ sidebar: true });
          },
        }),
        h('span', {}, r.title),
        r.alert ? null : h('span', { title: 'Im Belohnungs-Filter ausgeschaltet – kommt nie' }, '🔕'),
        h('span', { class: 'cost' }, r.cost.toLocaleString('de-DE')))));
  };
  renderList();
  fields.push(
    h('input', { type: 'search', placeholder: 'Belohnung suchen…', value: state.rewardSearch, oninput: (e) => { state.rewardSearch = e.target.value; renderList(); } }),
    list,
    h('div', { class: 'note' }, `${c.rewardIds.length} ausgewählt`));
  return fields;
}

function layoutSection(d) {
  return [
    choice(LAYOUTS, d.layout, (val) => { d.layout = val; markDirty({ props: true }); }),
    row2(
      field('Hintergrund', colorInput(d.background, (val) => { d.background = val; markDirty(); })),
      field('Deckkraft (%)', numInput(d.backgroundOpacity, (val) => { d.backgroundOpacity = val; markDirty(); }, { min: 0, max: 100 }))),
    row2(
      field('Innenabstand (px)', numInput(d.padding, (val) => { d.padding = val; markDirty(); }, { max: 200 })),
      field('Abstand Bild/Text (px)', numInput(d.gap, (val) => { d.gap = val; markDirty(); }, { max: 200 }))),
    checkRow('Abgerundete Ecken', d.rounded, (on) => { d.rounded = on; markDirty(); }),
    checkRow('Schlagschatten', d.shadow, (on) => { d.shadow = on; markDirty(); }),
    d.backgroundOpacity === 0 && (d.rounded || d.shadow) ? h('div', { class: 'note' }, 'Ecken und Schatten sieht man erst mit Hintergrund-Deckkraft über 0.') : null,
  ];
}

function textSection(d) {
  const meta = CATEGORIES[state.cat];
  const message = textInput(d.message, (val) => { d.message = val; markDirty(); });
  const insert = (key) => {
    const pos = message.selectionStart ?? message.value.length;
    const token = `{${key}}`;
    message.value = message.value.slice(0, pos) + token + message.value.slice(message.selectionEnd ?? pos);
    message.focus();
    message.setSelectionRange(pos + token.length, pos + token.length);
    d.message = message.value;
    markDirty();
  };
  const fontOptions = Object.keys(AlertRenderer.FONTS).map((f) => [f, f]);
  const tts = d.tts;

  return [
    field('Nachricht', message,
      h('div', { class: 'chips' }, ...meta.vars.map((key) => h('button', { class: 'chip', title: 'Einfügen', onclick: () => insert(key) }, `{${key}}`)))),
    HAS_USER_MESSAGE.includes(state.cat)
      ? checkRow('Nachricht des Zuschauers anzeigen', d.showUserMessage, (on) => { d.showUserMessage = on; markDirty(); })
      : null,
    row2(
      field('Schrift', selectInput(fontOptions, d.font, (val) => { d.font = val; markDirty(); })),
      field('Stärke', selectInput(WEIGHTS, d.fontWeight, (val) => { d.fontWeight = Number(val); markDirty(); }))),
    row2(
      field('Größe (px)', numInput(d.fontSize, (val) => { d.fontSize = val; markDirty(); }, { min: 8, max: 200 })),
      field('Ausrichtung', choice(ALIGNS, d.align, (val) => { d.align = val; markDirty({ props: true }); }, true))),
    row2(
      field('Textfarbe', colorInput(d.textColor, (val) => { d.textColor = val; markDirty(); })),
      field('Akzentfarbe', colorInput(d.accentColor, (val) => { d.accentColor = val; markDirty(); }))),
    checkRow('Textschatten', d.textShadow, (on) => { d.textShadow = on; markDirty(); }),

    subHead('VORLESEN (TEXT-TO-SPEECH)'),
    checkRow('Alert-Text vorlesen', tts.enabled, (on) => { tts.enabled = on; markDirty({ props: true, previewUpdate: false }); }),
    ...(tts.enabled ? ttsFields(tts) : []),
  ];
}

function ttsFields(tts) {
  const voiceSelect = state.voices
    ? selectInput([['', 'Windows-Standard'], ...state.voices.map((v) => [v.name, `${v.name} (${v.language})`])], tts.voice, (val) => { tts.voice = val; markDirty({ previewUpdate: false }); })
    : h('div', { class: 'note' }, 'Lade Stimmen…');
  if (!state.voices) loadVoices();
  return [
    field('Stimme', voiceSelect),
    field('Tempo', slider(tts.rate, -10, 10, (val) => { tts.rate = val; markDirty({ previewUpdate: false }); }, '')),
    field('Lautstärke', slider(tts.volume, 0, 100, (val) => { tts.volume = val; markDirty({ previewUpdate: false }); })),
    HAS_USER_MESSAGE.includes(state.cat)
      ? checkRow('Nachricht des Zuschauers auch vorlesen', tts.readUserMessage, (on) => { tts.readUserMessage = on; markDirty({ props: true, previewUpdate: false }); })
      : null,
    tts.readUserMessage && HAS_USER_MESSAGE.includes(state.cat)
      ? h('div', { class: 'warn-note' }, 'Achtung: Zuschauer können damit alles vorlesen lassen, was sie schreiben.')
      : null,
    h('button', { class: 'btn small', onclick: testVoice }, '🔊 Stimme testen'),
  ].filter(Boolean);
}

function mediaThumb(ref) {
  const thumb = h('div', { class: 'media-thumb' });
  if (!ref) thumb.textContent = '—';
  else if (ref.source === 'builtin' && ref.kind !== 'audio') thumb.innerHTML = AlertLibrary.images[ref.id]?.svg ?? '';
  else if (ref.kind === 'audio') thumb.textContent = '🎵';
  else if (ref.kind === 'video') thumb.append(h('video', { src: `/addon-data/alerts/media/${encodeURIComponent(ref.id)}`, muted: true, autoplay: true, loop: true }));
  else thumb.append(h('img', { src: `/addon-data/alerts/media/${encodeURIComponent(ref.id)}`, alt: '' }));
  return thumb;
}

function mediaSection(d) {
  const imageCard = h('div', { class: 'media-card' },
    mediaThumb(d.image),
    h('span', { class: 'media-name' }, d.image ? d.image.name : 'Kein Bild'),
    d.image ? h('button', { class: 'icon-btn', title: 'Bild entfernen', onclick: () => { d.image = null; markDirty({ props: true }); } }, '✕') : null);

  const soundCard = h('div', { class: 'media-card' },
    mediaThumb(d.sound),
    h('span', { class: 'media-name' }, d.sound ? d.sound.name : 'Kein Sound'),
    d.sound ? h('button', { class: 'icon-btn', title: 'Anhören', onclick: () => playSoundRef(d.sound, d.soundVolume) }, '▶') : null,
    d.sound ? h('button', { class: 'icon-btn', title: 'Sound entfernen', onclick: () => { d.sound = null; markDirty({ props: true, previewUpdate: false }); } }, '✕') : null);

  return [
    subHead('BILD / VIDEO'),
    imageCard,
    row2(
      h('button', { class: 'btn small block', onclick: () => uploadInto(d, 'image') }, '⬆ Hochladen'),
      h('button', { class: 'btn small block', onclick: () => openLibrary(d, 'image') }, '📚 Bibliothek')),
    field('Größe (% der Höhe)', slider(d.imageSize, 5, 100, (val) => { d.imageSize = val; markDirty(); })),
    d.image?.kind === 'video' ? field('Video-Lautstärke', slider(d.imageVolume, 0, 100, (val) => { d.imageVolume = val; markDirty({ previewUpdate: false }); })) : null,
    subHead('SOUND'),
    soundCard,
    row2(
      h('button', { class: 'btn small block', onclick: () => uploadInto(d, 'sound') }, '⬆ Hochladen'),
      h('button', { class: 'btn small block', onclick: () => openLibrary(d, 'sound') }, '📚 Bibliothek')),
    field('Lautstärke', slider(d.soundVolume, 0, 100, (val) => { d.soundVolume = val; markDirty({ previewUpdate: false }); })),
    h('div', { class: 'note' }, 'Bilder: PNG, JPG, GIF, WebP · Videos: WebM (mit Transparenz), MP4 · Sounds: MP3, WAV, OGG. Deine Dateien bleiben auf deinem PC.'),
  ];
}

function fxSection(d) {
  const c = d.celebration;
  return [
    checkRow('Effekte anzeigen', c.enabled, (on) => { c.enabled = on; markDirty({ props: true }); }),
    ...(c.enabled
      ? [
        row2(
          field('Effekt', selectInput([['confetti', 'Konfetti'], ['fireworks', 'Feuerwerk'], ['hearts', 'Herzen'], ['stars', 'Sterne']], c.effect, (val) => { c.effect = val; markDirty(); })),
          field('Stärke', selectInput([['light', 'Leicht'], ['medium', 'Mittel'], ['heavy', 'Stark']], c.intensity, (val) => { c.intensity = val; markDirty(); }))),
        field('Bereich', choice([['full', 'Ganze Fläche'], ['alert', 'Um den Alert']], c.area, (val) => { c.area = val; markDirty({ props: true }); })),
      ]
      : []),
  ];
}

// ============================================================ Medien: Upload + Bibliothek

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

async function uploadFile(kind) {
  const file = await pickFile(kind === 'image' ? 'image/png,image/jpeg,image/gif,image/webp,video/webm,video/mp4' : 'audio/mpeg,audio/wav,audio/ogg,.mp3,.wav,.ogg');
  if (!file) return null;
  if (file.size > 60 * 1024 * 1024) {
    toast('Datei ist zu groß (max. 60 MB)', 'err');
    return null;
  }
  toast(`Lade „${file.name}“ hoch…`);
  try {
    const res = await fetch(`/api/${BASE}/media?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Suite-Upload': '1' },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.media.push(data);
    toast('Hochgeladen', 'ok');
    return data;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

const fileRef = (f) => ({ source: 'file', id: f.id, name: f.name, kind: f.kind });

async function uploadInto(d, slot) {
  const file = await uploadFile(slot);
  if (!file) return;
  if (slot === 'image' && file.kind === 'audio') return toast('Das ist ein Sound – bitte unter „Sound“ hochladen.', 'err');
  if (slot === 'sound' && file.kind !== 'audio') return toast('Das ist kein Sound.', 'err');
  d[slot] = fileRef(file);
  markDirty({ props: true, previewUpdate: slot === 'image' });
}

function playSoundRef(ref, volume) {
  if (ref.source === 'builtin') AlertLibrary.playSound(ref.id, volume);
  else {
    const audio = new Audio(`/addon-data/alerts/media/${encodeURIComponent(ref.id)}`);
    audio.volume = volume / 100;
    audio.play().catch(() => {});
  }
}

function openLibrary(d, slot) {
  const host = $('#modal-host');
  const close = () => host.replaceChildren();
  const isImage = slot === 'image';
  const current = d[slot];
  const choose = (ref) => {
    d[slot] = ref;
    close();
    markDirty({ props: true, previewUpdate: isImage });
  };
  const isCurrent = (source, id) => current?.source === source && current?.id === id;

  const render = () => {
    const builtins = Object.entries(isImage ? AlertLibrary.images : AlertLibrary.sounds).map(([id, item]) => {
      const ref = { source: 'builtin', id, name: item.name, kind: isImage ? 'image' : 'audio' };
      const previewBox = h('div', { class: 'lib-preview' });
      if (isImage) previewBox.innerHTML = item.svg;
      else previewBox.append(h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); AlertLibrary.playSound(id, d.soundVolume); } }, '▶ Anhören'));
      return h('div', { class: `lib-tile${isCurrent('builtin', id) ? ' selected' : ''}`, onclick: () => choose(ref) }, previewBox, h('span', { class: 'lib-name' }, item.name));
    });

    const files = state.media.filter((f) => (isImage ? f.kind !== 'audio' : f.kind === 'audio')).map((f) =>
      h('div', { class: `lib-tile${isCurrent('file', f.id) ? ' selected' : ''}`, onclick: () => choose(fileRef(f)) },
        h('button', {
          class: 'icon-btn', title: 'Datei löschen',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`„${f.name}“ löschen? Varianten, die sie benutzen, zeigen dann nichts mehr an.`)) return;
            try {
              await api(`${BASE}/media/delete`, { id: f.id });
              state.media = state.media.filter((m) => m.id !== f.id);
              render();
            } catch (err) {
              toast(err.message, 'err');
            }
          },
        }, '🗑'),
        h('div', { class: 'lib-preview' },
          isImage ? mediaThumb(fileRef(f)).firstChild ?? '' : h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); playSoundRef(fileRef(f), d.soundVolume); } }, '▶ Anhören')),
        h('span', { class: 'lib-name', title: f.name }, f.name)));

    host.replaceChildren(h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
      h('div', { class: 'modal' },
        h('div', { class: 'modal-head' },
          h('h2', {}, isImage ? '📚 Bild-Bibliothek' : '📚 Sound-Bibliothek'),
          h('button', {
            class: 'btn small',
            onclick: async () => {
              const file = await uploadFile(slot);
              if (file) render();
            },
          }, '⬆ Hochladen'),
          h('button', { class: 'icon-btn', title: 'Schließen', onclick: close }, '✕')),
        h('div', { class: 'modal-body' },
          subHead('EINGEBAUT'),
          h('div', { class: 'lib-grid' }, ...builtins),
          subHead('DEINE DATEIEN'),
          files.length ? h('div', { class: 'lib-grid' }, ...files) : h('div', { class: 'note' }, 'Noch nichts hochgeladen.')))));
  };
  render();
}

// ============================================================ Vorschau

function sampleAlert() {
  const meta = CATEGORIES[state.cat];
  const v = variant();
  const c = v.conditions;
  const values = { ...meta.sample };
  if (state.cat === 'redemption' && c.rewardMode === 'some') {
    const reward = rewardById(c.rewardIds[0]);
    if (reward) Object.assign(values, { reward: reward.title, cost: reward.cost });
  }
  if (state.cat === 'cheer') values.bits = Math.max(values.bits, c.minBits);
  if (state.cat === 'raid') values.viewers = Math.max(values.viewers, c.minViewers);
  if (state.cat === 'giftsub') values.count = Math.max(values.count, c.minCount);
  if (state.cat === 'hypetrain') {
    values.level = c.trainPhase === 'start' ? 1 : Math.max(values.level, c.minLevel);
    if (c.goldenOnly) values.type = 'Golden Kappa Train';
  }
  if (state.cat === 'sub') {
    if (c.tier !== 'any') values.tier = String(c.tier / 1000);
    values.months = c.subKind === 'new' ? 1 : Math.max(values.months, c.minMonths);
  }
  const userMessage = v.design.showUserMessage && HAS_USER_MESSAGE.includes(state.cat) ? meta.userMessage : '';
  return { id: 'preview', category: state.cat, design: v.design, values, userMessage, ttsUrl: null };
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => renderPreview(state.autoplay ? 'muted' : 'static'), 350);
}

function renderPreview(mode) {
  clearTimeout(previewTimer);
  const stage = $('#stage');
  preview?.stop();
  preview = null;
  stage.replaceChildren();
  if (!variant()) {
    stage.append(h('div', { class: 'stage-empty' }, 'Keine Variante ausgewählt'));
    return;
  }
  const handle = AlertRenderer.play(stage, sampleAlert(), {
    mode,
    onDone: () => {
      if (preview !== handle) return;
      preview = null;
      // Nach dem Abspielen bleibt der Alert zum Bearbeiten stehen
      setTimeout(() => { if (!preview) renderPreview('static'); }, 300);
    },
  });
  preview = handle;
}

async function playPreview() {
  const v = variant();
  if (!v) return;
  const alert = sampleAlert();
  if (v.design.tts.enabled) {
    let text = AlertRenderer.fillPlain(v.design.message, alert.values);
    if (v.design.tts.readUserMessage && alert.userMessage) text += `. ${alert.userMessage}`;
    try {
      alert.ttsUrl = (await api(`${BASE}/tts`, { text, voice: v.design.tts.voice, rate: v.design.tts.rate })).url;
    } catch (err) {
      toast(`Sprachausgabe: ${err.message}`, 'err');
    }
  }
  const stage = $('#stage');
  preview?.stop();
  stage.replaceChildren();
  const handle = AlertRenderer.play(stage, alert, {
    mode: 'live',
    onDone: () => {
      if (preview !== handle) return;
      preview = null;
      setTimeout(() => { if (!preview) renderPreview('static'); }, 300);
    },
  });
  preview = handle;
}

async function testVoice() {
  const v = variant();
  const text = AlertRenderer.fillPlain(v.design.message, sampleAlert().values);
  try {
    const { url } = await api(`${BASE}/tts`, { text, voice: v.design.tts.voice, rate: v.design.tts.rate });
    const audio = new Audio(url);
    audio.volume = v.design.tts.volume / 100;
    audio.play();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function sendTest() {
  const v = variant();
  if (!v) return;
  await save();
  const c = v.conditions;
  const reward = state.cat === 'redemption' && c.rewardMode === 'some' ? rewardById(c.rewardIds[0]) : null;
  try {
    await api(`${BASE}/test`, { category: state.cat, variantId: v.id, reward: reward ? { id: reward.id, title: reward.title, cost: reward.cost } : undefined });
    toast(`„${v.name}“ an das Overlay geschickt`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** Vorschaufläche passend skalieren */
function fitStage() {
  if (!state.s) return;
  const wrap = $('#stage-wrap');
  const stage = $('#stage');
  const { width, height } = state.s.canvas;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  const scale = Math.min((wrap.clientWidth - 40) / width, (wrap.clientHeight - 40) / height, 1);
  stage.style.transform = `translate(-50%, -50%) scale(${Math.max(scale, 0.05)})`;
}

function renderPreviewOptions() {
  $('#autoplay-toggle').replaceChildren(toggle(state.autoplay, (on) => {
    state.autoplay = on;
    savePrefs();
    renderPreview(on ? 'muted' : 'static');
  }, 'Autoplay'));
  $('#canvas-w').value = state.s.canvas.width;
  $('#canvas-h').value = state.s.canvas.height;
  $('#bg-swatches').replaceChildren(...PREVIEW_BGS.map(([id, label]) =>
    h('button', {
      class: `swatch bg-${id}${state.previewBg === id ? ' selected' : ''}`,
      title: label,
      onclick: () => {
        state.previewBg = id;
        savePrefs();
        applyPreviewBg();
        renderPreviewOptions();
      },
    })));
  applyPreviewBg();
}

function applyPreviewBg() {
  $('#stage').className = `ed-stage no-i18n bg-${state.previewBg}`;
}

async function saveCanvas() {
  const width = Number($('#canvas-w').value);
  const height = Number($('#canvas-h').value);
  try {
    state.s = { ...state.s, canvas: (await api(`${BASE}/settings`, { canvas: { width, height } })).canvas };
    fitStage();
    renderPreview('static');
  } catch (err) {
    toast(err.message, 'err');
    renderPreviewOptions();
  }
}

// ============================================================ Belohnungs-Filter (Mitte)

function showRewards() {
  state.view = 'rewards';
  state.cat = 'redemption';
  renderAll();
}

function renderRewardsView() {
  const box = $('#rewards-view');
  const search = h('input', { type: 'search', placeholder: 'Belohnung suchen…', value: state.rewardSearch });
  const list = h('div');
  const groups = state.rewardGroups ?? [];
  const groupById = (id) => groups.find((g) => g.id === id);
  const muted = new Set(state.s.mutedGroups ?? []);
  const visible = () => (state.rewards ?? []).filter((r) =>
    r.title.toLowerCase().includes(state.rewardSearch.toLowerCase())
    && (!state.rewardGroupFilter || r.groups.includes(state.rewardGroupFilter)));

  const setGroupMuted = async (groupId, isMuted) => {
    const next = isMuted ? [...muted, groupId] : [...muted].filter((id) => id !== groupId);
    try {
      state.s.mutedGroups = (await api(`${BASE}/settings`, { mutedGroups: next })).mutedGroups;
      await loadRewards();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  /** Warum kommt (k)ein Alert? */
  const reasonBadge = (r) => {
    if (r.custom) return h('span', { class: 'badge accent' }, 'eigene Einstellung');
    const mutedBy = r.groups.map(groupById).find((g) => g && muted.has(g.id));
    if (mutedBy) return h('span', { class: 'badge warn' }, `stumm über Gruppe ${mutedBy.icon} ${mutedBy.name}`);
    return h('span', { class: 'badge' }, 'Standard');
  };

  const groupSection = () => {
    if (state.rewardGroups === undefined) return null;
    if (state.rewardGroups === null) {
      return h('p', { class: 'note' }, 'Tipp: Mit dem Addon „Kanalpunkte“ kannst du Belohnungen in Gruppen sortieren (z.B. HudFX) und hier eine ganze Gruppe auf einmal stummschalten.');
    }
    if (!groups.length) {
      return h('p', { class: 'note' }, 'Noch keine Gruppen. Lege im Addon „Kanalpunkte“ welche an, z.B. „HudFX“. Dann kannst du sie hier auf einmal stummschalten.');
    }
    return h('div', { class: 'group-mute' },
      h('div', { class: 'sub-head' }, 'GRUPPEN'),
      ...groups.map((g) => h('div', { class: 'group-mute-row' },
        h('span', { class: 'group-dot', style: { background: g.color } }),
        h('span', { class: 'group-mute-name no-i18n' }, `${g.icon} ${g.name}`),
        h('span', { class: 'muted' }, muted.has(g.id) ? 'kein Alert' : 'Alert wie Standard'),
        toggle(!muted.has(g.id), (on) => setGroupMuted(g.id, !on), `Alerts für Gruppe ${g.name}`))),
      h('div', { class: 'note' }, 'Eine eigene Einstellung bei einer einzelnen Belohnung geht immer vor.'));
  };

  const groupFilterChips = () => groups.length
    ? h('div', { class: 'chips group-chips' },
      h('button', { class: `chip${state.rewardGroupFilter ? '' : ' active'}`, onclick: () => { state.rewardGroupFilter = null; renderRewardsView(); } }, 'Alle'),
      ...groups.map((g) => h('button', {
        class: `chip no-i18n${state.rewardGroupFilter === g.id ? ' active' : ''}`,
        onclick: () => { state.rewardGroupFilter = g.id; renderRewardsView(); },
      }, `${g.icon} ${g.name}`)))
    : null;

  const renderList = () => {
    if (!state.rewards) {
      list.replaceChildren(h('p', { class: state.rewardsError ? 'error-text' : 'muted' }, state.rewardsError || 'Lade Belohnungen von Twitch…'));
      return;
    }
    if (!state.rewards.length) {
      list.replaceChildren(h('p', { class: 'muted' }, 'Keine Belohnungen gefunden.'));
      return;
    }
    list.replaceChildren(...visible().map((r) =>
      h('div', { class: `reward-row${r.alert ? '' : ' silent'}` },
        h('div', { class: 'reward-img', style: { background: r.color } }, r.image ? h('img', { src: r.image, alt: '' }) : null),
        h('div', { class: 'reward-info' },
          h('strong', { class: 'no-i18n' }, r.title),
          h('div', { class: 'reward-meta' },
            h('span', { class: 'muted' }, `${r.cost.toLocaleString('de-DE')} Punkte`),
            !r.enabled ? h('span', { class: 'badge' }, 'deaktiviert') : null,
            r.paused ? h('span', { class: 'badge warn' }, 'pausiert') : null,
            ...r.groups.map(groupById).filter(Boolean).map((g) => h('span', { class: 'badge no-i18n', style: { background: `${g.color}33`, color: '#fff' } }, `${g.icon} ${g.name}`)),
            reasonBadge(r))),
        h('div', { class: 'reward-actions' },
          r.custom ? h('button', { class: 'btn small', title: 'Auf Standard zurücksetzen', onclick: () => setRewardFilter({ [r.id]: null }) }, '↺') : null,
          h('button', { class: 'btn small', title: 'Prüft, ob ein Alert käme, und zeigt ihn im Overlay', onclick: () => testReward(r) }, 'Test'),
          h('span', { title: r.alert ? 'Alert an' : 'Kein Alert' }, r.alert ? '🔔' : '🔕'),
          toggle(r.alert, (on) => setRewardFilter({ [r.id]: { alert: on, title: r.title } }), `Alert für ${r.title}`)))));
  };

  const setVisible = (alert) => {
    const rows = visible();
    if (!rows.length) return;
    setRewardFilter(Object.fromEntries(rows.map((r) => [r.id, { alert, title: r.title }])));
    toast(`${rows.length} Belohnung(en): Alert ${alert ? 'an' : 'aus'}`, 'ok');
  };

  search.oninput = () => {
    state.rewardSearch = search.value;
    renderList();
  };

  box.replaceChildren(
    h('h2', {}, '🔕 Belohnungs-Filter'),
    h('p', { class: 'muted' }, 'Hier ausgeschaltete Belohnungen lösen nie einen Alert aus, z.B. HudFX-Belohnungen, damit kein Alert den Jumpscare verrät.'),
    h('div', { class: 'default-row' },
      toggle(state.s.newRewardDefault, async (on) => {
        try {
          state.s.newRewardDefault = (await api(`${BASE}/settings`, { newRewardDefault: on })).newRewardDefault;
          await loadRewards();
        } catch (err) {
          toast(err.message, 'err');
        }
      }, 'Standard'),
      h('div', {},
        h('strong', {}, 'Standard: Alert für Belohnungen ohne eigene Einstellung'),
        h('small', { class: 'muted' }, 'Gilt auch für Belohnungen, die du später neu anlegst.'))),
    // replaceChildren macht aus null den Text „null“ → leeren Text statt null
    groupSection() ?? '',
    h('div', { class: 'sub-head' }, 'EINZELNE BELOHNUNGEN'),
    groupFilterChips() ?? '',
    h('div', { class: 'toolbar' },
      search,
      h('button', { class: 'btn small', onclick: () => setVisible(true) }, 'Angezeigte: Alert an'),
      h('button', { class: 'btn small', onclick: () => setVisible(false) }, 'Angezeigte: Alert aus'),
      h('button', { class: 'btn small', onclick: loadRewards }, '↻')),
    list);
  renderList();
}

async function setRewardFilter(changes) {
  try {
    await api(`${BASE}/rewards`, { changes });
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  // Neu laden, weil beim Zurücksetzen Gruppen mitentscheiden
  await loadRewards();
}

async function testReward(r) {
  try {
    const result = await api(`${BASE}/test`, { category: 'redemption', reward: { id: r.id, title: r.title, cost: r.cost } });
    if (result.shown) toast(`Alert kommt mit Variante „${result.variant}“`, 'ok');
    else toast('Kein Alert für diese Belohnung ✓');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function loadRewards() {
  try {
    const res = await api(`${BASE}/rewards`);
    state.rewards = res.rewards;
    state.rewardGroups = res.groups;
    if (state.rewardGroupFilter && !res.groups?.some((g) => g.id === state.rewardGroupFilter)) state.rewardGroupFilter = null;
    state.rewardsError = '';
  } catch (err) {
    state.rewards = null;
    state.rewardsError = err.message;
  }
  if (state.view === 'rewards') renderRewardsView();
  else if (state.cat === 'redemption') renderProps();
  renderSidebar();
}

async function loadVoices() {
  if (loadVoices.running) return;
  loadVoices.running = true;
  try {
    state.voices = await api(`${BASE}/voices`);
  } catch (err) {
    state.voices = [];
    toast(`Stimmen konnten nicht geladen werden: ${err.message}`, 'err');
  }
  renderProps();
}

// ============================================================ Verlauf (Mitte)

function showHistory() {
  state.view = 'history';
  renderAll();
  loadHistory();
}

async function loadHistory() {
  try {
    state.history = await api(`${BASE}/history`);
    state.historyError = '';
  } catch (err) {
    state.historyError = err.message;
  }
  if (state.view === 'history') renderHistoryView();
}

/** Kurzbeschreibung eines Events für die Liste: [Name, was passiert ist] */
function historyText(e) {
  const user = e.user?.name ?? 'Anonym';
  const quote = (text) => (text ? ` · „${text}“` : '');
  switch (e.type) {
    case 'follow': return [user, 'folgt jetzt'];
    case 'sub': return [user, `hat abonniert (Tier ${Number(e.tier) / 1000 || 1})`];
    case 'resub': return [user, `verlängert: ${e.months} Monate${quote(e.message)}`];
    case 'giftsub': return [user, `verschenkt ${e.count} Abo${e.count === 1 ? '' : 's'}`];
    case 'cheer': return [user, `${e.bits} Bits${quote(e.message)}`];
    case 'raid': return [user, `raidet mit ${e.viewers} Zuschauern`];
    case 'redemption': return [user, `„${e.reward.title}“ (${e.reward.cost.toLocaleString('de-DE')})${quote(e.input)}`];
    case 'hypetrain': {
      const name = e.trainType === 'golden_kappa' ? 'Golden Kappa Train' : e.trainType === 'treasure' ? 'Treasure Train' : 'Hype Train';
      const top = e.topContributions?.length ? ` · Top: ${[...e.topContributions].sort((a, b) => b.total - a.total)[0].user.name}` : '';
      if (e.phase === 'begin') return [name, `fährt los${top}`];
      if (e.phase === 'end') return [name, `vorbei: Level ${e.level}, ${e.total.toLocaleString('de-DE')} Punkte${top}`];
      return [name, `erreicht Level ${e.level}${top}`];
    }
    default: return [user, e.type];
  }
}

function timeAgo(t) {
  const min = Math.floor((Date.now() - t) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  if (min < 24 * 60) return `vor ${Math.floor(min / 60)} Std.`;
  return new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

async function replay(entry, force = false) {
  try {
    const result = await api(`${BASE}/history/replay`, { id: entry.id, force });
    if (result.shown) toast(`Alert „${result.variant}“ ans Overlay geschickt`, 'ok');
    else toast('Keine aktive Variante passt zu diesem Event', 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function clearHistory() {
  if (!confirm('Den ganzen Verlauf löschen?')) return;
  try {
    await api(`${BASE}/history/clear`, {});
  } catch (err) {
    toast(err.message, 'err');
  }
  loadHistory();
}

function historyRow(entry) {
  const [who, what] = historyText(entry.event);
  const status = entry.variant
    ? h('span', { class: 'badge ok', title: 'Diese Variante kam' }, `🔔 ${entry.variant}`)
    : entry.reason === 'muted'
      ? h('span', { class: 'badge', title: 'Belohnung ist im Belohnungs-Filter stumm' }, '🔕 stumm')
      : h('span', { class: 'badge warn', title: 'Keine aktive Variante passte' }, '⚠ kein Alert');
  return h('div', { class: `reward-row${entry.variant ? '' : ' silent'}` },
    h('div', { class: 'reward-img hist-icon' }, CATEGORIES[entry.category]?.icon ?? '•'),
    h('div', { class: 'reward-info' },
      h('strong', { class: 'no-i18n' }, who), ' ', h('span', { class: 'hist-what' }, what),
      h('div', { class: 'reward-meta' },
        h('span', { class: 'muted', title: new Date(entry.at).toLocaleString('de-DE') }, timeAgo(entry.at)),
        entry.event.test ? h('span', { class: 'badge accent' }, '🧪 Test') : null,
        status)),
    h('div', { class: 'reward-actions' },
      entry.reason === 'muted'
        ? h('button', { class: 'btn small', title: 'Die Belohnung ist stumm. Trotzdem mit der ersten passenden Variante zeigen?', onclick: () => replay(entry, true) }, '▶ Trotzdem zeigen')
        : h('button', { class: 'btn small', title: 'Alert nochmal ans Overlay schicken', onclick: () => replay(entry) }, '▶ Nochmal')));
}

function renderHistoryView() {
  const all = state.history ?? [];
  const list = all.filter((e) => !(state.historyHideMuted && e.reason === 'muted'));
  let content;
  if (state.historyError) content = h('p', { class: 'error-text' }, state.historyError);
  else if (!state.history) content = h('p', { class: 'muted' }, 'Lade Verlauf…');
  else if (!list.length) {
    content = h('p', { class: 'muted' }, all.length
      ? 'Im Verlauf sind nur stumme Einlösungen.'
      : 'Noch keine Events. Sobald jemand folgt, abonniert, cheert, raidet, einen Hype Train startet oder etwas einlöst, steht es hier.');
  } else content = h('div', { class: 'hist-list' }, ...list.map(historyRow));

  $('#history-view').replaceChildren(
    h('h2', {}, '🕘 Verlauf'),
    h('p', { class: 'muted' }, 'Die letzten Events mit Alert. Kam ein Alert nicht durch, schick ihn hier nochmal ans Overlay.'),
    h('div', { class: 'toolbar' },
      h('label', { class: 'hist-opt' },
        toggle(state.historyHideMuted, (on) => { state.historyHideMuted = on; renderHistoryView(); }, 'Stumme ausblenden'),
        h('span', {}, 'Stumme Belohnungen ausblenden')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', title: 'Neu laden', onclick: loadHistory }, '↻'),
      h('button', { class: 'btn small', disabled: !all.length, onclick: clearHistory }, '🗑 Leeren')),
    content);
}

// ============================================================ Gesamtansicht

function renderAll() {
  const rewardsMode = state.view === 'rewards';
  const historyMode = state.view === 'history';
  $('#stage-wrap').hidden = rewardsMode || historyMode;
  $('#preview-opts').hidden = rewardsMode || historyMode;
  $('#toolbar').hidden = rewardsMode || historyMode;
  $('#rewards-view').hidden = !rewardsMode;
  $('#history-view').hidden = !historyMode;
  renderSidebar();
  renderProps();
  if (rewardsMode || historyMode) {
    preview?.stop();
    if (rewardsMode) renderRewardsView();
    else renderHistoryView();
  } else {
    fitStage();
    renderPreview(state.autoplay ? 'muted' : 'static');
  }
}

(async () => {
  loadPrefs();
  const overlayUrl = `${location.origin}/addons/alerts/overlay.html`;
  $('#overlay-url').value = overlayUrl;
  $('#copy-url').onclick = async () => {
    await navigator.clipboard.writeText(overlayUrl);
    toast('URL kopiert – in OBS als Browser-Quelle einfügen', 'ok');
  };
  $('#btn-preview').onclick = playPreview;
  $('#btn-test').onclick = sendTest;
  $('#history-btn').onclick = showHistory;
  // Neue Events erscheinen von selbst, solange der Verlauf offen ist
  setInterval(() => { if (state.view === 'history' && !document.hidden) loadHistory(); }, 3000);
  $('#canvas-w').onchange = saveCanvas;
  $('#canvas-h').onchange = saveCanvas;
  new ResizeObserver(fitStage).observe($('#stage-wrap'));
  window.addEventListener('beforeunload', () => { if (savePending) save(); });

  try {
    [state.s, state.defaults, state.media] = await Promise.all([api(`${BASE}/settings`), api(`${BASE}/defaults`), api(`${BASE}/media`)]);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  state.variantId = category().variants[0]?.id ?? null;
  renderPreviewOptions();
  renderAll();
  loadRewards();
})();
