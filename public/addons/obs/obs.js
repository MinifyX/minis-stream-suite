const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/obs';

const ROLES = [
  ['everyone', 'Alle'],
  ['subscriber', 'Subs'],
  ['vip', 'VIPs'],
  ['moderator', 'Mods'],
  ['broadcaster', 'Nur du'],
];
const roleLabel = (r) => ROLES.find(([v]) => v === r)?.[1] ?? r;

const TRIGGERS = [
  ['reward', '🎯 Kanalpunkte-Belohnung'],
  ['command', '💬 Chat-Command'],
  ['follow', '💜 Follow'],
  ['sub', '⭐ Sub (neu, Resub, Geschenk)'],
  ['cheer', '💎 Cheer (Bits)'],
  ['raid', '🚀 Raid'],
  ['manual', '🖐 Nur per Test-Knopf'],
];

const STEP_TYPES = {
  scene: '🎬 Szene wechseln',
  source: '👁 Quelle ein/aus',
  filter: '✨ Filter ein/aus',
  wait: '⏱ Warten',
};

const state = {
  /** Antwort von /state */
  s: null,
  /** Szenen/Quellen/Filter aus OBS (oder null) */
  obs: null,
  obsVersion: -1,
  rewards: null,
};

// ============================================================ Laden

async function load() {
  try {
    state.s = await api(`${BASE}/state`);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  if (state.s.dataVersion !== state.obsVersion) await loadObs(false);
  render();
}

async function loadObs(refresh) {
  try {
    const res = await api(`${BASE}/obs${refresh ? '?refresh=1' : ''}`);
    if (res.data) state.obs = res.data;
    state.obsVersion = res.dataVersion;
    return true;
  } catch (err) {
    toast(err.message, 'err');
    return false;
  }
}

async function loadRewards() {
  try {
    state.rewards = await api(`${BASE}/rewards`);
  } catch (err) {
    state.rewards = null;
    toast(err.message, 'err');
  }
}

// ============================================================ Kopf

function renderHead() {
  const { status, actionsEnabled, running } = state.s;
  const pill = $('#status-pill');
  if (status.state === 'connected') {
    pill.className = 'status-pill ok';
    pill.replaceChildren(h('span', { class: 'dot ok' }), status.currentScene ? `Verbunden · Szene: ${status.currentScene}` : 'Verbunden');
  } else if (status.state === 'connecting') {
    pill.className = 'status-pill warn';
    pill.replaceChildren(h('span', { class: 'dot warn' }), 'Verbinde…');
  } else {
    pill.className = 'status-pill';
    pill.replaceChildren(h('span', { class: 'dot' }), 'Nicht verbunden');
  }

  $('#kill-switch').replaceChildren(h('span', { class: `kill-switch${actionsEnabled ? '' : ' off'}`, title: 'Not-Aus: stoppt alles und ignoriert alle Auslöser' },
    toggle(actionsEnabled, async (on) => {
      try {
        state.s = await api(`${BASE}/settings`, { actionsEnabled: on });
        toast(on ? 'Aktionen an' : 'Not-Aus: alle Aktionen gestoppt und aus', on ? 'ok' : 'info');
      } catch (err) {
        toast(err.message, 'err');
      }
      render();
    }, 'Aktionen an/aus (Not-Aus)'),
    actionsEnabled ? '🎬 Aktionen an' : '⛔ Not-Aus – alles aus'));

  $('#stop-all').hidden = !Object.keys(running).length;

  $('#settings-row').replaceChildren(
    h('label', {},
      toggle(state.s.reactToTests, async (on) => {
        try {
          state.s = await api(`${BASE}/settings`, { reactToTests: on });
        } catch (err) {
          toast(err.message, 'err');
        }
      }, 'Auch auf Test-Events reagieren'),
      'Auch auf Test-Events reagieren (Test-Knöpfe in der Übersicht)'));
}

// ============================================================ Verbindung

function renderConnStatus() {
  const { status } = state.s;
  const box = $('#conn-status');
  const version = [status.obsVersion && `OBS ${status.obsVersion}`, status.wsVersion && `WebSocket ${status.wsVersion}`].filter(Boolean).join(', ');
  const [dot, text] = status.state === 'connected'
    ? ['ok', `Verbunden mit ${status.address}${version ? ` (${version})` : ''}`]
    : status.state === 'connecting' ? ['warn', `Verbinde mit ${status.address}…`] : ['', 'Nicht verbunden'];
  box.replaceChildren(h('div', { class: 'line' }, h('span', { class: `dot ${dot}` }), text));
  if (status.error && status.state !== 'connected') box.append(h('div', { class: 'err-text' }, status.error));
  const btn = $('#conn-toggle');
  if (btn) btn.textContent = status.state === 'disconnected' ? 'Verbinden' : 'Trennen';
}

/** Formular nur einmal bauen, damit Eingaben beim Aktualisieren nicht verloren gehen */
function renderConnForm() {
  const c = state.s.connection;
  const host = h('input', { type: 'text', value: c.host, placeholder: '127.0.0.1' });
  const port = h('input', { type: 'number', min: 1, max: 65535, value: c.port });
  const password = h('input', {
    type: 'password',
    autocomplete: 'off',
    placeholder: c.hasPassword ? '•••••• gespeichert – leer lassen zum Behalten' : 'Passwort aus OBS',
  });
  let autoConnect = c.autoConnect;

  const save = async (extra = {}) => {
    try {
      state.s = await api(`${BASE}/connection`, { host: host.value, port: Number(port.value), password: password.value, autoConnect, ...extra });
      password.value = '';
      toast('Gespeichert', 'ok');
      render();
      renderConnForm();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  $('#conn-form').replaceChildren(h('div', { class: 'conn-form' },
    h('div', { class: 'host-row' },
      h('div', { class: 'field' }, h('label', {}, 'Adresse'), host),
      h('div', { class: 'field' }, h('label', {}, 'Port'), port)),
    h('div', { class: 'field' }, h('label', {}, 'Passwort'), password,
      c.hasPassword ? h('button', { class: 'link-btn', onclick: () => { if (confirm('Gespeichertes Passwort löschen?')) save({ clearPassword: true }); } }, 'Gespeichertes Passwort entfernen') : null),
    h('p', { class: 'note' }, 'Das Passwort wird nur lokal auf diesem PC in den Einstellungen der Suite gespeichert.'),
    h('div', { class: 'opt-row' }, toggle(autoConnect, (on) => { autoConnect = on; }, 'Automatisch verbinden'), h('span', {}, 'Beim Start automatisch verbinden')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: () => save() }, 'Speichern & verbinden'),
      h('button', {
        class: 'btn',
        id: 'conn-toggle',
        onclick: async () => {
          try {
            state.s = await api(`${BASE}/${state.s.status.state === 'disconnected' ? 'connect' : 'disconnect'}`, {});
            render();
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }, 'Verbinden'))));
  $('#howto').open = !c.hasPassword && state.s.status.state !== 'connected';
}

// ============================================================ Aktionen (Liste)

function triggerBadges(t) {
  switch (t.type) {
    case 'reward':
      return [h('span', { class: 'badge accent' }, `🎯 ${t.rewardTitle || 'Belohnung'}`)];
    case 'command':
      return [
        h('span', { class: 'badge accent' }, `💬 ${t.command}`),
        t.role !== 'everyone' ? h('span', { class: 'badge warn' }, `🔒 ${roleLabel(t.role)}`) : null,
        t.cooldown ? h('span', { class: 'badge', title: 'Cooldown' }, `⏱ ${t.cooldown} s`) : null,
      ];
    case 'follow':
      return [h('span', { class: 'badge accent' }, '💜 Follow')];
    case 'sub':
      return [h('span', { class: 'badge accent' }, '⭐ Sub')];
    case 'cheer':
      return [h('span', { class: 'badge accent' }, `💎 ab ${t.minBits} Bits`)];
    case 'raid':
      return [h('span', { class: 'badge accent' }, `🚀 Raid ab ${t.minViewers} Zuschauern`)];
    default:
      return [h('span', { class: 'badge' }, '🖐 Nur per Test')];
  }
}

function stepLabel(step) {
  const back = step.revertAfter ? ` (↩ ${step.revertAfter} s)` : '';
  switch (step.type) {
    case 'scene':
      return `🎬 ${step.scene}${back}`;
    case 'source':
      return `👁 ${step.source} ${{ show: 'an', hide: 'aus', toggle: 'umschalten' }[step.mode]}${back}`;
    case 'filter':
      return `✨ ${step.filter} ${{ on: 'an', off: 'aus', toggle: 'umschalten' }[step.mode]}${back}`;
    case 'wait':
      return `⏱ ${step.ms / 1000} s`;
    default:
      return '?';
  }
}

function renderActions() {
  const box = $('#actions');
  const { actions, running } = state.s;
  if (!actions.length) {
    box.replaceChildren(h('div', { class: 'act-empty' },
      h('p', {}, 'Noch keine Aktionen. Zum Beispiel: „Kamera groß“ für 500 Kanalpunkte – wechselt 15 Sekunden auf die Kamera-Szene und dann zurück.'),
      h('button', { class: 'btn primary', onclick: () => openEditor(null) }, '＋ Erste Aktion anlegen')));
    return;
  }
  box.replaceChildren(h('div', { class: 'act-list' }, ...actions.map((a) => {
    const runs = running[a.id] ?? 0;
    return h('div', { class: `act${a.enabled ? '' : ' off'}${runs ? ' running' : ''}` },
      toggle(a.enabled, async (on) => {
        try {
          state.s = await api(`${BASE}/actions/toggle`, { id: a.id, enabled: on });
          render();
        } catch (err) {
          toast(err.message, 'err');
        }
      }, `${a.name} an/aus`),
      h('div', { class: 'act-main' },
        h('div', { class: 'act-name no-i18n' }, a.name),
        h('div', { class: 'act-meta' },
          ...triggerBadges(a.trigger),
          a.overlap === 'skip' ? h('span', { class: 'badge', title: 'Wird übersprungen, solange die Aktion noch läuft' }, '⏭ überspringen') : null,
          runs ? h('span', { class: 'badge ok' }, runs > 1 ? `▶ läuft (+${runs - 1} wartend)` : '▶ läuft') : null),
        h('div', { class: 'act-steps no-i18n', title: a.steps.map(stepLabel).join('\n') }, a.steps.map(stepLabel).join('  →  '))),
      h('div', { class: 'act-actions' },
        h('button', { class: 'btn small', title: 'Jetzt ausführen', onclick: () => testAction({ id: a.id }) }, '▶ Test'),
        h('button', { class: 'icon-btn', title: 'Bearbeiten', onclick: () => openEditor(a) }, '✎'),
        h('button', { class: 'icon-btn', title: 'Duplizieren', onclick: () => openEditor({ ...structuredClone(a), id: null, name: `${a.name} (Kopie)` }) }, '⧉'),
        h('button', { class: 'icon-btn', title: 'Löschen', onclick: () => deleteAction(a) }, '🗑')));
  })));
}

async function testAction(body) {
  try {
    const { result } = await api(`${BASE}/actions/test`, body);
    toast({ started: 'Läuft…', queued: 'Läuft noch – in die Warteschlange gestellt', skipped: 'Läuft noch – übersprungen' }[result] ?? 'OK', result === 'skipped' ? 'info' : 'ok');
    setTimeout(load, 300);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteAction(a) {
  if (!confirm(`Aktion „${a.name}“ löschen?`)) return;
  try {
    state.s = await api(`${BASE}/actions/delete`, { id: a.id });
    toast('Gelöscht', 'ok');
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================ Verlauf

const LOG_ICONS = { ok: '✅', info: 'ℹ️', warn: '⚠️', err: '❌' };

function renderLog() {
  const box = $('#log');
  const { log } = state.s;
  if (!log.length) {
    box.replaceChildren(h('div', { class: 'note' }, 'Noch nichts passiert, seit die Suite läuft.'));
    return;
  }
  box.replaceChildren(...log.slice(0, 60).map((e) =>
    h('div', { class: `l-row ${e.level}` },
      h('span', { class: 'l-time' }, new Date(e.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      h('span', {}, LOG_ICONS[e.level] ?? '•'),
      h('span', { class: 'l-text' }, e.action ? h('b', { class: 'no-i18n' }, `${e.action}: `) : null, e.message))));
}

// ============================================================ Dialog

function modal(title, body, footer) {
  const host = $('#modal-host');
  const close = () => host.replaceChildren();
  host.replaceChildren(h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Schließen', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, ...body.filter(Boolean)),
      footer ? h('div', { class: 'modal-foot' }, ...footer.filter(Boolean)) : null)));
  return close;
}

const field = (label, ...controls) => h('div', { class: 'field' }, h('label', {}, label), ...controls);

/**
 * Auswahlliste – oder ein Textfeld, wenn (noch) keine Liste aus OBS da ist.
 * Ein gespeicherter Wert, den es in OBS nicht (mehr) gibt, bleibt sichtbar.
 */
function picker(options, value, onchange, placeholder, missingLabel = (v) => `${v} (nicht in OBS gefunden)`) {
  if (!options.length) {
    const input = h('input', { type: 'text', value: value ?? '', placeholder });
    input.oninput = () => onchange(input.value);
    return input;
  }
  const select = h('select', {},
    h('option', { value: '' }, '– auswählen –'),
    ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  if (value && !options.some((o) => o.value === value)) {
    select.append(h('option', { value, selected: true }, missingLabel(value)));
  }
  select.onchange = () => onchange(select.value);
  return select;
}

const numberInput = (value, attrs, onchange) => {
  const input = h('input', { type: 'number', value, ...attrs });
  input.oninput = () => onchange(Number(input.value));
  return input;
};

function newStep(type) {
  switch (type) {
    case 'scene': return { type, scene: '', revertAfter: 0 };
    case 'source': return { type, scene: state.obs?.scenes[0]?.name ?? '', group: '', source: '', mode: 'toggle', revertAfter: 0 };
    case 'filter': return { type, source: '', filter: '', mode: 'toggle', revertAfter: 0 };
    default: return { type: 'wait', ms: 1000 };
  }
}

function openEditor(action) {
  const isNew = !action?.id;
  const a = structuredClone(action ?? {
    name: '', enabled: true, overlap: 'queue', trigger: { type: 'reward', rewardId: '', rewardTitle: '' }, steps: [],
  });
  // Werte aller Auslöser-Arten merken, damit beim Umschalten nichts verloren geht
  const t = {
    type: a.trigger.type,
    rewardId: '', rewardTitle: '', command: '!', role: 'everyone', cooldown: 30, minBits: 100, minViewers: 5,
    ...a.trigger,
  };
  const steps = a.steps;

  const name = h('input', { type: 'text', value: a.name, maxlength: 60, placeholder: 'z.B. Kamera groß' });
  const triggerType = h('select', {}, ...TRIGGERS.map(([v, l]) => h('option', { value: v, selected: v === t.type }, l)));
  const triggerBox = h('div', { class: 'box' });
  const overlap = h('select', {},
    h('option', { value: 'queue', selected: a.overlap !== 'skip' }, 'In die Warteschlange (nacheinander ausführen)'),
    h('option', { value: 'skip', selected: a.overlap === 'skip' }, 'Überspringen (nicht ausführen)'));

  // -------------------------------------------------- Auslöser
  const renderTrigger = () => {
    t.type = triggerType.value;
    const parts = [];
    if (t.type === 'reward') {
      const rewards = state.rewards;
      const select = rewards?.length
        ? picker(
          rewards.map((r) => ({ value: r.id, label: `${r.title} (${r.cost})${r.enabled ? '' : ' – ausgeschaltet'}` })),
          t.rewardId,
          (id) => {
            t.rewardId = id;
            t.rewardTitle = rewards.find((r) => r.id === id)?.title ?? '';
          },
          '',
          () => `${t.rewardTitle || t.rewardId} (nicht mehr auf Twitch?)`)
        : h('input', {
          type: 'text',
          disabled: true,
          value: t.rewardTitle,
          placeholder: rewards ? 'Keine Belohnungen gefunden' : 'Belohnungen werden geladen…',
        });
      parts.push(
        field('Belohnung', h('div', { class: 'pick-row' }, select,
          h('button', { class: 'btn small', title: 'Liste neu laden', onclick: async () => { await loadRewards(); renderTrigger(); } }, '↻'))),
        h('p', { class: 'note' }, 'Es gehen alle Belohnungen deines Kanals, auch welche, die du im Twitch-Dashboard oder mit einer anderen App angelegt hast.'));
    } else if (t.type === 'command') {
      const cmd = h('input', { type: 'text', value: t.command, maxlength: 32, placeholder: '!kamera' });
      cmd.oninput = () => { t.command = cmd.value; };
      const role = h('select', {}, ...ROLES.map(([v, l]) => h('option', { value: v, selected: v === t.role }, l)));
      role.onchange = () => { t.role = role.value; };
      parts.push(
        h('div', { class: 'f-row3' },
          field('Command', cmd),
          field('Wer darf ihn benutzen?', role),
          field('Cooldown (Sekunden)', numberInput(t.cooldown, { min: 0, max: 86400 }, (v) => { t.cooldown = v; }))),
        h('p', { class: 'note' }, 'Der Cooldown gilt für alle außer dich. Gibt es im Chat-Commands-Addon denselben Command, passiert beides.'));
    } else if (t.type === 'cheer') {
      parts.push(field('Ab wie vielen Bits?', numberInput(t.minBits, { min: 1 }, (v) => { t.minBits = v; })));
    } else if (t.type === 'raid') {
      parts.push(field('Ab wie vielen Zuschauern?', numberInput(t.minViewers, { min: 1 }, (v) => { t.minViewers = v; })));
    } else if (t.type === 'sub') {
      parts.push(h('p', { class: 'note' }, 'Reagiert auf neue Subs, Resubs und Geschenk-Subs. Bei mehreren verschenkten Subs auf einmal nur einmal.'));
    } else if (t.type === 'follow') {
      parts.push(h('p', { class: 'note' }, 'Reagiert auf jeden neuen Follow. Tipp: Bei Follow-Bots lieber „Überspringen“ wählen.'));
    } else {
      parts.push(h('p', { class: 'note' }, 'Die Aktion läuft nur, wenn du auf „▶ Test“ klickst.'));
    }
    triggerBox.hidden = !parts.length;
    triggerBox.replaceChildren(...parts);
  };
  triggerType.onchange = () => {
    renderTrigger();
    if (triggerType.value === 'reward' && !state.rewards) loadRewards().then(renderTrigger);
  };
  renderTrigger();
  if (t.type === 'reward' && !state.rewards) loadRewards().then(renderTrigger);

  // -------------------------------------------------- Schritte
  const stepsBox = h('div', { class: 'steps' });
  const obsNote = h('p', { class: 'warn-note' });

  const scenes = () => (state.obs?.scenes ?? []).map((s) => ({ value: s.name, label: s.name }));

  const revertRow = (step) => h('label', { class: 'revert-row' },
    '↩ Nach', numberInput(step.revertAfter, { min: 0, max: 3600 }, (v) => { step.revertAfter = v; }), 'Sekunden zurücksetzen (0 = nie)');

  const stepFields = (step) => {
    if (step.type === 'scene') {
      return [
        h('div', { class: 'step-fields' }, picker(scenes(), step.scene, (v) => { step.scene = v; }, 'Name der Szene')),
        revertRow(step),
      ];
    }
    if (step.type === 'source') {
      const items = state.obs?.scenes.find((s) => s.name === step.scene)?.items ?? [];
      const sourceSelect = picker(
        items.map((i) => ({
          value: `${i.group}\u001f${i.source}`,
          label: i.group ? `${i.group} › ${i.source}` : i.isGroup ? `${i.source} (Gruppe)` : i.source,
        })),
        step.source ? `${step.group}\u001f${step.source}` : '',
        (v) => {
          const [group, source] = v.includes('\u001f') ? v.split('\u001f') : ['', v];
          step.group = group;
          step.source = source;
        },
        'Name der Quelle',
        () => `${step.group ? `${step.group} › ` : ''}${step.source} (nicht in OBS gefunden)`);
      // Ohne OBS-Liste zeigt das Textfeld nur den Namen
      if (sourceSelect.tagName === 'INPUT') sourceSelect.value = step.source;
      const mode = h('select', {},
        h('option', { value: 'show', selected: step.mode === 'show' }, 'einblenden'),
        h('option', { value: 'hide', selected: step.mode === 'hide' }, 'ausblenden'),
        h('option', { value: 'toggle', selected: step.mode === 'toggle' }, 'umschalten'));
      mode.onchange = () => { step.mode = mode.value; };
      return [
        h('div', { class: 'step-fields' },
          picker(scenes(), step.scene, (v) => { step.scene = v; step.group = ''; step.source = ''; renderSteps(); }, 'Szene'),
          sourceSelect,
          mode),
        revertRow(step),
      ];
    }
    if (step.type === 'filter') {
      const sources = state.obs?.filters ?? [];
      const filters = sources.find((s) => s.source === step.source)?.filters ?? [];
      const mode = h('select', {},
        h('option', { value: 'on', selected: step.mode === 'on' }, 'einschalten'),
        h('option', { value: 'off', selected: step.mode === 'off' }, 'ausschalten'),
        h('option', { value: 'toggle', selected: step.mode === 'toggle' }, 'umschalten'));
      mode.onchange = () => { step.mode = mode.value; };
      return [
        h('div', { class: 'step-fields' },
          picker(sources.map((s) => ({ value: s.source, label: `${s.source} (${s.filters.length})` })), step.source,
            (v) => { step.source = v; step.filter = ''; renderSteps(); }, 'Quelle oder Szene mit dem Filter'),
          picker(filters.map((f) => ({ value: f, label: f })), step.filter, (v) => { step.filter = v; }, 'Name des Filters'),
          mode),
        state.obs && !sources.length ? h('p', { class: 'note' }, 'In OBS gibt es noch keine Quelle mit Filtern.') : null,
        revertRow(step),
      ];
    }
    // Warten
    return [h('div', { class: 'step-fields' },
      h('label', { class: 'revert-row' },
        numberInput(step.ms / 1000, { min: 0.1, max: 600, step: 0.1 }, (v) => { step.ms = Math.round(v * 1000); }),
        'Sekunden warten, dann geht es mit dem nächsten Schritt weiter'))];
  };

  const move = (index, delta) => {
    const [step] = steps.splice(index, 1);
    steps.splice(index + delta, 0, step);
    renderSteps();
  };

  function renderSteps() {
    obsNote.textContent = state.obs
      ? ''
      : 'Noch keine Liste aus OBS – verbinde dich mit OBS und klick auf „Liste aus OBS laden“. Bis dahin kannst du die Namen auch eintippen (genau wie in OBS).';
    obsNote.hidden = !obsNote.textContent;
    if (!steps.length) {
      stepsBox.replaceChildren(h('div', { class: 'steps-empty' }, 'Noch keine Schritte. Füg unten einen hinzu – sie laufen nacheinander ab.'));
      return;
    }
    stepsBox.replaceChildren(...steps.map((step, i) =>
      h('div', { class: 'step' },
        h('span', { class: 'step-no' }, i + 1),
        h('div', { class: 'step-body' }, h('div', { class: 'step-title' }, STEP_TYPES[step.type]), ...stepFields(step).filter(Boolean)),
        h('div', { class: 'step-tools' },
          h('button', { class: 'icon-btn', title: 'Nach oben', disabled: i === 0, onclick: () => move(i, -1) }, '▲'),
          h('button', { class: 'icon-btn', title: 'Nach unten', disabled: i === steps.length - 1, onclick: () => move(i, 1) }, '▼'),
          h('button', { class: 'icon-btn', title: 'Entfernen', onclick: () => { steps.splice(i, 1); renderSteps(); } }, '🗑')))));
  }
  renderSteps();

  const addRow = h('div', { class: 'add-row' },
    ...Object.entries(STEP_TYPES).map(([type, label]) =>
      h('button', { class: 'btn small', onclick: () => { steps.push(newStep(type)); renderSteps(); } }, `＋ ${label}`)),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn small',
      title: 'Szenen, Quellen und Filter neu aus OBS holen',
      onclick: async () => {
        if (await loadObs(true)) {
          toast(state.obs ? 'Liste aus OBS geladen' : 'OBS ist nicht verbunden', state.obs ? 'ok' : 'err');
          renderSteps();
        }
      },
    }, '↻ Liste aus OBS laden'));

  // -------------------------------------------------- Speichern / Testen
  const collect = () => {
    const trigger = { type: t.type };
    if (t.type === 'reward') Object.assign(trigger, { rewardId: t.rewardId, rewardTitle: t.rewardTitle });
    if (t.type === 'command') Object.assign(trigger, { command: t.command, role: t.role, cooldown: t.cooldown });
    if (t.type === 'cheer') trigger.minBits = t.minBits;
    if (t.type === 'raid') trigger.minViewers = t.minViewers;
    return { id: a.id, name: name.value, enabled: a.enabled, overlap: overlap.value, trigger, steps };
  };

  const save = async () => {
    try {
      const saved = await api(`${BASE}/actions/save`, { action: collect() });
      a.id = saved.id;
    } catch (err) {
      return toast(err.message, 'err');
    }
    toast(isNew ? 'Aktion angelegt' : 'Gespeichert', 'ok');
    close();
    await load();
  };

  const close = modal(isNew ? 'Neue OBS-Aktion' : `„${a.name}“ bearbeiten`, [
    field('Name', name),
    field('Auslöser', triggerType),
    triggerBox,
    h('div', { class: 'sub' }, 'SCHRITTE (LAUFEN NACHEINANDER AB)'),
    obsNote,
    stepsBox,
    addRow,
    field('Wenn die Aktion ausgelöst wird, während sie noch läuft', overlap),
  ], [
    h('button', { class: 'btn', title: 'Führt die Schritte jetzt in OBS aus (ohne zu speichern)', onclick: () => testAction({ action: collect() }) }, '▶ Jetzt testen'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', { class: 'btn primary', onclick: save }, isNew ? 'Anlegen' : 'Speichern'),
  ]);
  setTimeout(() => name.focus(), 0);
}

// ============================================================ Start

function render() {
  if (!state.s) return;
  renderHead();
  renderConnStatus();
  renderActions();
  renderLog();
}

(async () => {
  $('#new-action').onclick = () => openEditor(null);
  $('#stop-all').onclick = async () => {
    try {
      state.s = await api(`${BASE}/actions/stop`, {});
      toast('Alles gestoppt', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#log-clear').onclick = async () => {
    try {
      state.s = await api(`${BASE}/log/clear`, {});
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  await load();
  if (state.s) renderConnForm();
  render();
  // Status, Verlauf und laufende Aktionen regelmäßig aktualisieren
  setInterval(async () => {
    try {
      state.s = await api(`${BASE}/state`);
    } catch {
      return;
    }
    if (state.s.dataVersion !== state.obsVersion) await loadObs(false);
    renderHead();
    renderConnStatus();
    renderLog();
    // Liste nicht neu bauen, während der Dialog offen ist
    if (!$('#modal-host').childElementCount) renderActions();
  }, 2000);
})();
