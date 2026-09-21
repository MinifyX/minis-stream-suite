// Gemeinsame Bausteine für Keybinds (Tastenfolgen): Beschriftung, Aufnahme-Editor, Ziel-Auswahl.
// Wird von den Addons „Kanalpunkte“ und „Chat-Commands“ benutzt. Braucht window.UI (ui.js).
window.KeyUI = (() => {
  const { h } = window.UI;

  const KEY_NAMES = {
    ControlLeft: 'Strg', ControlRight: 'Strg rechts', ShiftLeft: 'Shift', ShiftRight: 'Shift rechts',
    AltLeft: 'Alt', AltRight: 'AltGr', MetaLeft: 'Win', MetaRight: 'Win rechts', ContextMenu: 'Menü',
    Space: 'Leertaste', Enter: 'Enter', NumpadEnter: 'Num Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Rücktaste',
    CapsLock: 'Feststell', Delete: 'Entf', Insert: 'Einfg', Home: 'Pos1', End: 'Ende', PageUp: 'Bild ↑', PageDown: 'Bild ↓',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PrintScreen: 'Druck', ScrollLock: 'Rollen',
    NumpadMultiply: 'Num *', NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadDecimal: 'Num ,', NumpadDivide: 'Num /',
    MediaPlayPause: '⏯ Play/Pause', MediaTrackNext: '⏭ Nächster Titel', MediaTrackPrevious: '⏮ Voriger Titel', MediaStop: '⏹ Stopp',
    AudioVolumeMute: '🔇 Stumm', AudioVolumeDown: '🔉 Leiser', AudioVolumeUp: '🔊 Lauter',
  };
  const SPECIAL_KEYS = [
    ...Array.from({ length: 12 }, (_, i) => `F${13 + i}`),
    'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaStop', 'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp',
    'MetaLeft', 'PrintScreen', 'ContextMenu',
  ];
  const MODIFIER_CODES = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

  // Beschriftung passend zum eigenen Tastaturlayout (z.B. QWERTZ: KeyY = „Z“)
  let layoutMap = null;
  const layoutListeners = [];
  navigator.keyboard?.getLayoutMap?.()
    .then((map) => {
      layoutMap = map;
      layoutListeners.forEach((fn) => fn());
    })
    .catch(() => {});

  /** Funktion aufrufen, sobald die Tastenbeschriftungen des Layouts bekannt sind */
  const onLayoutReady = (fn) => layoutListeners.push(fn);

  function keyLabel(code) {
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
    const fromLayout = layoutMap?.get(code);
    if (fromLayout) return fromLayout.toUpperCase();
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    return code;
  }

  const comboLabel = (keys) => keys.map(keyLabel).join(' + ');
  const stepsLabel = (steps) => steps.map((s) => comboLabel(s.keys)).join(' → ');

  /**
   * Editor für eine Tastenfolge. Bearbeitet das übergebene Array direkt.
   * Rückgabe: { el, stop() – Aufnahme beenden, clean() – Schritte ohne Taste entfernt }
   */
  function stepsEditor(steps) {
    if (!steps.length) steps.push({ keys: [], holdMs: 50, delayMs: 0 });
    const list = h('div', { class: 'kb-steps' });
    let recording = null; // { step, pressed: Set, el }

    const detach = () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      recording = null;
    };
    const stop = () => {
      if (!recording) return;
      detach();
      render();
    };
    function onKeyDown(e) {
      // Dialog wurde geschlossen (z.B. Klick daneben) → Aufnahme beenden, Tasten nicht mehr abfangen
      if (!list.isConnected) return detach();
      e.preventDefault();
      e.stopPropagation();
      if (!recording || e.repeat) return;
      recording.pressed.add(e.code);
      recording.el.textContent = comboLabel([...recording.pressed]) || '…';
    }
    function onKeyUp(e) {
      if (!list.isConnected) return detach();
      e.preventDefault();
      e.stopPropagation();
      if (!recording || !recording.pressed.size) return;
      // Sobald die erste Taste losgelassen wird, ist die Kombination fertig
      recording.step.keys = [...recording.pressed].sort((a, b) => Number(MODIFIER_CODES.includes(b)) - Number(MODIFIER_CODES.includes(a)));
      stop();
    }
    const start = (step, el) => {
      stop();
      recording = { step, pressed: new Set(), el };
      el.textContent = 'Drück die Taste(n)…';
      el.classList.add('recording');
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);
    };

    const num = (value, onchange, title) => h('input', {
      type: 'number', min: 0, max: 30000, step: 10, value, title,
      onchange: (e) => onchange(Math.max(0, Math.min(30000, Math.round(Number(e.target.value) || 0)))),
    });

    function render() {
      list.replaceChildren(...steps.map((step, i) => {
        const comboEl = h('button', {
          class: `kb-combo${step.keys.length ? '' : ' kb-combo-empty'}`,
          title: 'Klicken und Taste(n) drücken',
          onclick: (e) => start(step, e.currentTarget),
        }, step.keys.length ? comboLabel(step.keys) : '⏺ Aufnehmen');
        const special = h('select', {
          class: 'kb-special',
          title: 'Tasten, die man nicht direkt drücken kann',
          onchange: (e) => {
            if (!e.target.value) return;
            // Modifier behalten (z.B. Strg + F13), Rest ersetzen
            step.keys = [...step.keys.filter((k) => MODIFIER_CODES.includes(k) && k !== e.target.value), e.target.value];
            render();
          },
        }, h('option', { value: '' }, '＋ Sondertaste'), ...SPECIAL_KEYS.map((k) => h('option', { value: k }, keyLabel(k))));
        const modToggle = (code, label) => h('button', {
          class: `kb-mod${step.keys.includes(code) ? ' on' : ''}`,
          onclick: () => {
            step.keys = step.keys.includes(code) ? step.keys.filter((k) => k !== code) : [code, ...step.keys];
            render();
          },
        }, label);

        return h('div', { class: 'kb-step' },
          h('div', { class: 'kb-step-head' },
            h('span', { class: 'kb-num' }, i + 1),
            comboEl,
            steps.length > 1 ? h('button', { class: 'icon-btn', title: 'Schritt entfernen', onclick: () => { steps.splice(i, 1); render(); } }, '✕') : null),
          h('div', { class: 'kb-step-opts' },
            modToggle('ControlLeft', 'Strg'), modToggle('ShiftLeft', 'Shift'), modToggle('AltLeft', 'Alt'),
            special,
            h('label', {}, 'halten', num(step.holdMs, (v) => { step.holdMs = v; }, 'Wie lange die Tasten gedrückt bleiben'), 'ms'),
            h('label', {}, 'Pause davor', num(step.delayMs, (v) => { step.delayMs = v; }, 'Wartezeit vor diesem Schritt'), 'ms')));
      }));
    }

    render();
    onLayoutReady(render);
    const el = h('div', { class: 'kb-editor' },
      list,
      h('button', { class: 'btn small', onclick: () => { steps.push({ keys: [], holdMs: 50, delayMs: 0 }); render(); } }, '＋ Schritt'));
    return { el, stop, clean: () => steps.filter((s) => s.keys.length) };
  }

  /**
   * Auswahl „Dieser PC“ / „🛰 Satellite“. `holder.target` wird direkt geändert.
   * satellite = Status von /api/core/satellite (oder null), onSetup = Klick auf „Satellite einrichten“
   */
  function targetPicker(holder, satellite, onSetup) {
    const box = h('div', { class: 'kb-target' });
    const render = () => {
      const sat = satellite;
      box.replaceChildren(...[
        h('div', { class: 'choice-row' },
          h('button', { class: holder.target === 'satellite' ? '' : 'selected', onclick: () => { holder.target = 'local'; render(); } }, '🖥 Dieser PC'),
          h('button', { class: holder.target === 'satellite' ? 'selected' : '', onclick: () => { holder.target = 'satellite'; render(); } },
            sat?.connected ? `🛰 Satellite (${sat.name})` : '🛰 Satellite')),
        holder.target === 'satellite' && !sat?.connected
          ? h('div', { class: 'warn-note' }, sat?.enabled
            ? 'Gerade ist kein Satellite verbunden. Starte die Satellite-Datei auf dem anderen PC.'
            : h('span', {}, 'Der Satellite-Zugang ist aus. ',
              onSetup ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); onSetup(); } }, 'Satellite einrichten') : 'Einrichten unter Kanalpunkte → 🛰 Satellite.'))
          : null,
      ].filter(Boolean));
    };
    render();
    return box;
  }

  /** Hinweise, die unter jedem Keybind-Editor stehen */
  const tips = () => h('div', { class: 'kb-tips' },
    h('div', {}, '💡 Die Tasten gehen an das Fenster, das gerade im Vordergrund ist, meist also dein Spiel.'),
    h('div', {}, '💡 Für OBS: Leg in OBS einen Hotkey auf F13–F24 (hier als Sondertaste) und nimm denselben hier. Die Tasten kollidieren nie mit dem Spiel.'),
    h('div', {}, '⚠ Läuft das Spiel als Administrator, muss die Suite (bzw. der Satellite) auch als Administrator laufen, sonst blockiert Windows die Tasten.'),
    h('div', {}, '⚠ Manche Spiele mit Anti-Cheat ignorieren simulierte Tasten oder sehen sie nicht gern. Im Zweifel lieber OBS-Hotkeys nutzen.'));

  return { keyLabel, comboLabel, stepsLabel, stepsEditor, targetPicker, tips, onLayoutReady };
})();
