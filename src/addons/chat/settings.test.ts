import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULTS, applyPatch, sanitize } from './settings';

describe('Chat-Einstellungen', () => {
  test('leere Eingabe ergibt die Standardwerte', () => {
    assert.deepEqual(sanitize(undefined), DEFAULTS);
    assert.deepEqual(sanitize({}), DEFAULTS);
  });

  test('alte Einstellungen (bis v0.5) gelten für Overlay und Fenster weiter', () => {
    const old = {
      markdown: { enabled: false, minRole: 'everyone' },
      colors: { enabled: true, minRole: 'vip' },
      respectAlertFilter: false,
      overlay: { fontSize: 30, hiddenUsers: ['Nightbot'] },
      window: { fontSize: 16 },
    };
    const s = sanitize(old);
    assert.equal(s.overlay.markdown.enabled, false);
    assert.equal(s.window.markdown.enabled, false);
    assert.equal(s.overlay.colors.minRole, 'vip');
    assert.equal(s.window.colors.minRole, 'vip');
    assert.equal(s.overlay.respectAlertFilter, false);
    assert.equal(s.overlay.fontSize, 30);
    assert.deepEqual(s.overlay.hiddenUsers, ['nightbot']);
    assert.equal(s.window.fontSize, 16);
    // Neue Werte, die es früher nicht gab, kommen aus den Standardwerten
    assert.deepEqual(s.window.hiddenUsers, []);
    assert.equal(s.window.mutedRewards, 'mark');
    assert.equal(s.overlay.events.hypetrain, true);
  });

  test('eigene Werte von Overlay/Fenster gewinnen gegen die alten gemeinsamen', () => {
    const s = sanitize({
      markdown: { enabled: true, minRole: 'everyone' },
      overlay: { markdown: { enabled: false, minRole: 'moderator' } },
    });
    assert.equal(s.overlay.markdown.enabled, false);
    assert.equal(s.overlay.markdown.minRole, 'moderator');
    assert.equal(s.window.markdown.enabled, true);
  });

  test('Overlay und Fenster sind unabhängig', () => {
    let s = sanitize({});
    s = applyPatch(s, { window: { markdown: { enabled: false }, thirdPartyEmotes: false, hiddenUsers: ['bot1'] } });
    assert.equal(s.window.markdown.enabled, false);
    assert.equal(s.window.thirdPartyEmotes, false);
    assert.deepEqual(s.window.hiddenUsers, ['bot1']);
    assert.equal(s.overlay.markdown.enabled, true);
    assert.equal(s.overlay.thirdPartyEmotes, true);
    assert.deepEqual(s.overlay.hiddenUsers, DEFAULTS.overlay.hiddenUsers);
  });

  test('mehrere Änderungen nacheinander bleiben alle erhalten', () => {
    // Der alte Fehler: nach dem ersten Speichern gingen weitere Änderungen verloren
    let s = sanitize({});
    s = applyPatch(s, { overlay: { fontSize: 30 } });
    s = applyPatch(s, { overlay: { textColor: '#ff0000' } });
    s = applyPatch(s, { overlay: { events: { follow: false } } });
    assert.equal(s.overlay.fontSize, 30);
    assert.equal(s.overlay.textColor, '#FF0000');
    assert.equal(s.overlay.events.follow, false);
    assert.equal(s.overlay.events.raid, true);
  });

  test('Fenster und Einstellungsseite überschreiben sich nicht gegenseitig', () => {
    let s = sanitize({});
    s = applyPatch(s, { overlay: { fontSize: 40 } }); // Einstellungsseite
    s = applyPatch(s, { window: { fontSize: 18 } }); // A+ im Chat-Fenster
    s = applyPatch(s, { overlay: { maxMessages: 5 } }); // wieder die Einstellungsseite
    assert.equal(s.overlay.fontSize, 40);
    assert.equal(s.overlay.maxMessages, 5);
    assert.equal(s.window.fontSize, 18);
  });

  test('Listen werden ersetzt, nicht zusammengeführt', () => {
    let s = sanitize({});
    s = applyPatch(s, { overlay: { hiddenUsers: ['a', 'b'] } });
    s = applyPatch(s, { overlay: { hiddenUsers: ['c'] } });
    assert.deepEqual(s.overlay.hiddenUsers, ['c']);
  });

  test('ungültige Werte werden korrigiert', () => {
    const s = applyPatch(sanitize({}), {
      overlay: { fontSize: 999, font: '<script>', markdown: { minRole: 'admin' }, textColor: 'red', hiddenUsers: ['@Bot', 'bot', 'mit leerzeichen'] },
      window: { fontSize: 2, font: 'Comic Sans', mutedRewards: 'weg', deletedMessages: 'hide' },
    });
    assert.equal(s.overlay.fontSize, 80);
    assert.equal(s.overlay.font, DEFAULTS.overlay.font);
    assert.equal(s.overlay.markdown.minRole, 'everyone');
    assert.equal(s.overlay.textColor, DEFAULTS.overlay.textColor);
    assert.deepEqual(s.overlay.hiddenUsers, ['bot']);
    assert.equal(s.window.fontSize, 10);
    assert.equal(s.window.font, DEFAULTS.window.font);
    assert.equal(s.window.mutedRewards, 'mark');
    assert.equal(s.window.deletedMessages, 'hide');
  });

  test('Zurücksetzen eines Bereichs lässt den anderen in Ruhe', () => {
    let s = applyPatch(sanitize({}), { overlay: { fontSize: 50 }, window: { fontSize: 20 } });
    s = applyPatch(s, { window: structuredClone(DEFAULTS.window) });
    assert.equal(s.window.fontSize, DEFAULTS.window.fontSize);
    assert.equal(s.overlay.fontSize, 50);
  });
});
