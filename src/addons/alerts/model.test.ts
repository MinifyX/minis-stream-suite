import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { EVENT_TYPES, makeTestEvent, type StreamEvent, type TwitchUserRef } from '../../core/twitch/events';
import {
  CATEGORY_IDS,
  DEFAULT_CATEGORIES,
  DEFAULT_CONDITIONS,
  DEFAULT_DESIGN,
  DEFAULT_SETTINGS,
  categoryOf,
  describeEvent,
  fillPlain,
  matches,
  pickVariant,
  rewardAllowed,
  sanitizeCategories,
  sanitizeVariant,
  type AlertSettings,
  type CategoryId,
  type Variant,
  type VariantConditions,
} from './model';

// Diese Tests hängen absichtlich nicht an der Liste der Kategorien – neue Kategorien sollen sie nicht kaputt machen.

// ------------------------------------------------------------------ Test-Helfer

const USER: TwitchUserRef = { id: '1', login: 'zuschauer', name: 'Zuschauer' };

const variant = (id: string, conditions: Partial<VariantConditions> = {}, enabled = true): Variant =>
  sanitizeVariant({ id, name: id, enabled, conditions });

/** Einstellungen mit eigenen Varianten für eine Kategorie (Rest = Standard) */
function settingsWith(category: CategoryId, variants: Variant[], extra: Partial<AlertSettings> = {}, randomize = false): AlertSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    categories: { ...structuredClone(DEFAULT_SETTINGS.categories), [category]: { randomize, variants } },
    ...extra,
  };
}

const follow: StreamEvent = { type: 'follow', user: USER };
const sub = (tier = '1000', isGift = false): StreamEvent => ({ type: 'sub', user: USER, tier, isGift });
const resub = (months: number, tier = '1000'): StreamEvent => ({ type: 'resub', user: USER, tier, months, message: 'Hi' });
const giftsub = (count: number): StreamEvent => ({ type: 'giftsub', user: USER, tier: '1000', count });
const cheer = (bits: number): StreamEvent => ({ type: 'cheer', user: USER, bits, message: '' });
const raid = (viewers: number): StreamEvent => ({ type: 'raid', user: USER, viewers });
const redemption = (rewardId: string): StreamEvent => ({
  type: 'redemption',
  redemptionId: 'r1',
  user: USER,
  reward: { id: rewardId, title: 'Hydrate', cost: 100 },
  input: 'Text',
  status: 'unfulfilled',
});

afterEach(() => mock.restoreAll());

// ------------------------------------------------------------------ categoryOf

describe('categoryOf', () => {
  test('Alert-Events landen in ihrer Kategorie', () => {
    assert.equal(categoryOf(follow), 'follow');
    assert.equal(categoryOf(sub()), 'sub');
    assert.equal(categoryOf(giftsub(3)), 'giftsub');
    assert.equal(categoryOf(cheer(100)), 'cheer');
    assert.equal(categoryOf(raid(5)), 'raid');
    assert.equal(categoryOf(redemption('x')), 'redemption');
  });

  test('Resub gehört zu den Abos', () => {
    assert.equal(categoryOf(resub(3)), 'sub');
  });

  test('Events ohne Alert → null', () => {
    for (const type of ['chat', 'chatdelete', 'chatclear', 'redemptionupdate', 'channelupdate', 'streamonline', 'streamoffline', 'poll'] as const) {
      assert.equal(categoryOf(makeTestEvent(type)), null, type);
    }
  });

  test('jede Kategorie ist eine bekannte Kategorie', () => {
    for (const type of EVENT_TYPES) {
      const category = categoryOf(makeTestEvent(type));
      assert.ok(category === null || (CATEGORY_IDS as readonly string[]).includes(category), `${type} → ${category}`);
    }
  });
});

// ------------------------------------------------------------------ matches

describe('matches', () => {
  test('Follow passt immer', () => {
    assert.equal(matches(variant('v'), follow), true);
  });

  test('Abo: neu / Verlängerung / egal', () => {
    assert.equal(matches(variant('v', { subKind: 'new' }), sub()), true);
    assert.equal(matches(variant('v', { subKind: 'new' }), resub(3)), false);
    assert.equal(matches(variant('v', { subKind: 'resub' }), sub()), false);
    assert.equal(matches(variant('v', { subKind: 'resub' }), resub(3)), true);
    assert.equal(matches(variant('v', { subKind: 'any' }), sub()), true);
    assert.equal(matches(variant('v', { subKind: 'any' }), resub(3)), true);
  });

  test('Abo: Stufe', () => {
    assert.equal(matches(variant('v', { tier: '3000' }), sub('3000')), true);
    assert.equal(matches(variant('v', { tier: '3000' }), sub('1000')), false);
    assert.equal(matches(variant('v', { tier: '2000' }), resub(5, '2000')), true);
    assert.equal(matches(variant('v', { tier: 'any' }), sub('2000')), true);
  });

  test('Abo: Mindest-Monate (neues Abo zählt als 1 Monat)', () => {
    assert.equal(matches(variant('v', { minMonths: 12 }), resub(12)), true);
    assert.equal(matches(variant('v', { minMonths: 12 }), resub(11)), false);
    assert.equal(matches(variant('v', { minMonths: 1 }), sub()), true);
    assert.equal(matches(variant('v', { minMonths: 2 }), sub()), false);
  });

  test('Mindestwerte bei Gift-Abos, Bits und Raids (Grenze zählt mit)', () => {
    assert.equal(matches(variant('v', { minCount: 5 }), giftsub(5)), true);
    assert.equal(matches(variant('v', { minCount: 5 }), giftsub(4)), false);
    assert.equal(matches(variant('v', { minBits: 100 }), cheer(100)), true);
    assert.equal(matches(variant('v', { minBits: 100 }), cheer(99)), false);
    assert.equal(matches(variant('v', { minViewers: 10 }), raid(10)), true);
    assert.equal(matches(variant('v', { minViewers: 10 }), raid(9)), false);
  });

  test('Belohnungen: alle oder nur ausgewählte', () => {
    assert.equal(matches(variant('v', { rewardMode: 'all' }), redemption('a')), true);
    assert.equal(matches(variant('v', { rewardMode: 'some', rewardIds: ['a', 'b'] }), redemption('b')), true);
    assert.equal(matches(variant('v', { rewardMode: 'some', rewardIds: ['a', 'b'] }), redemption('c')), false);
    assert.equal(matches(variant('v', { rewardMode: 'some', rewardIds: [] }), redemption('a')), false);
  });

  test('Events ohne Alert passen nie', () => {
    assert.equal(matches(variant('v'), makeTestEvent('chat')), false);
    assert.equal(matches(variant('v'), makeTestEvent('poll')), false);
  });
});

// ------------------------------------------------------------------ rewardAllowed

describe('rewardAllowed', () => {
  const base = (extra: Partial<AlertSettings>): AlertSettings => ({ ...structuredClone(DEFAULT_SETTINGS), ...extra });

  test('eigene Einstellung gewinnt – auch gegen stumme Gruppe und Standard', () => {
    const settings = base({ rewards: { a: { alert: true, title: 'A' }, b: { alert: false, title: 'B' } }, mutedGroups: ['g'], newRewardDefault: false });
    assert.equal(rewardAllowed(settings, 'a', ['g']), true);
    assert.equal(rewardAllowed({ ...settings, newRewardDefault: true }, 'b', []), false);
  });

  test('stumme Gruppe (eine reicht)', () => {
    const settings = base({ mutedGroups: ['hudfx'], newRewardDefault: true });
    assert.equal(rewardAllowed(settings, 'x', ['andere', 'hudfx']), false);
    assert.equal(rewardAllowed(settings, 'x', ['andere']), true);
  });

  test('sonst der Standard für neue Belohnungen', () => {
    assert.equal(rewardAllowed(base({ newRewardDefault: true }), 'x', []), true);
    assert.equal(rewardAllowed(base({ newRewardDefault: false }), 'x', []), false);
  });
});

// ------------------------------------------------------------------ pickVariant

describe('pickVariant', () => {
  test('die erste passende Variante gewinnt (Reihenfolge = Priorität)', () => {
    const settings = settingsWith('sub', [variant('nur-resub', { subKind: 'resub' }), variant('alle'), variant('auch-alle')]);
    assert.equal(pickVariant(settings, sub())?.variant.id, 'alle');
    assert.equal(pickVariant(settings, resub(2))?.variant.id, 'nur-resub');
    assert.equal(pickVariant(settings, resub(2))?.category, 'sub');
  });

  test('ausgeschaltete Varianten werden übersprungen', () => {
    const settings = settingsWith('follow', [variant('aus', {}, false), variant('an')]);
    assert.equal(pickVariant(settings, follow)?.variant.id, 'an');
  });

  test('keine passende Variante → kein Alert', () => {
    assert.equal(pickVariant(settingsWith('cheer', [variant('gross', { minBits: 1000 })]), cheer(10)), null);
    assert.equal(pickVariant(settingsWith('follow', []), follow), null);
    assert.equal(pickVariant(settingsWith('follow', [variant('aus', {}, false)]), follow), null);
  });

  test('Zufall: nur unter den passenden Varianten', (t) => {
    const settings = settingsWith('cheer', [variant('klein'), variant('gross', { minBits: 1000 }), variant('mittel', { minBits: 50 })], {}, true);
    const random = t.mock.method(Math, 'random', () => 0);
    assert.equal(pickVariant(settings, cheer(100))?.variant.id, 'klein');
    random.mock.mockImplementation(() => 0.99);
    assert.equal(pickVariant(settings, cheer(100))?.variant.id, 'mittel');
    assert.equal(pickVariant(settings, cheer(5000))?.variant.id, 'mittel');
    random.mock.mockImplementation(() => 0.5);
    assert.equal(pickVariant(settings, cheer(5000))?.variant.id, 'gross');
  });

  test('Zufall aus: Math.random wird nicht gebraucht', (t) => {
    const random = t.mock.method(Math, 'random', () => 0.99);
    const settings = settingsWith('follow', [variant('erste'), variant('zweite')]);
    assert.equal(pickVariant(settings, follow)?.variant.id, 'erste');
    assert.equal(random.mock.callCount(), 0);
  });

  test('Empfänger verschenkter Abos lösen keinen Abo-Alert aus', () => {
    const settings = settingsWith('sub', [variant('alle')]);
    assert.equal(pickVariant(settings, sub('1000', true)), null);
    assert.equal(pickVariant(settings, sub('1000', false))?.variant.id, 'alle');
  });

  test('Belohnungs-Filter: eigene Einstellung, stumme Gruppe, Standard', () => {
    const variants = [variant('alle')];
    const groupsOf = (rewardId: string) => (rewardId === 'hud-1' ? ['hudfx'] : []);

    const muted = settingsWith('redemption', variants, { mutedGroups: ['hudfx'] });
    assert.equal(pickVariant(muted, redemption('hud-1'), groupsOf), null);
    assert.equal(pickVariant(muted, redemption('normal'), groupsOf)?.variant.id, 'alle');

    const own = settingsWith('redemption', variants, { mutedGroups: ['hudfx'], rewards: { 'hud-1': { alert: true, title: 'HUD' } } });
    assert.equal(pickVariant(own, redemption('hud-1'), groupsOf)?.variant.id, 'alle');

    const off = settingsWith('redemption', variants, { rewards: { normal: { alert: false, title: 'Normal' } } });
    assert.equal(pickVariant(off, redemption('normal'), groupsOf), null);

    const defaultOff = settingsWith('redemption', variants, { newRewardDefault: false });
    assert.equal(pickVariant(defaultOff, redemption('neu')), null);
  });

  test('groupsOf wird mit der Reward-ID gefragt', () => {
    const asked: string[] = [];
    pickVariant(settingsWith('redemption', [variant('alle')]), redemption('abc'), (id) => {
      asked.push(id);
      return [];
    });
    assert.deepEqual(asked, ['abc']);
  });

  test('Belohnungs-Filter und Varianten-Auswahl zusammen', () => {
    const settings = settingsWith('redemption', [variant('nur-a', { rewardMode: 'some', rewardIds: ['a'] }), variant('rest')]);
    assert.equal(pickVariant(settings, redemption('a'))?.variant.id, 'nur-a');
    assert.equal(pickVariant(settings, redemption('b'))?.variant.id, 'rest');
  });

  test('Events ohne Alert → null', () => {
    for (const type of ['chat', 'poll', 'channelupdate', 'redemptionupdate'] as const) {
      assert.equal(pickVariant(DEFAULT_SETTINGS, makeTestEvent(type)), null, type);
    }
  });
});

// ------------------------------------------------------------------ sanitizeCategories

describe('sanitizeCategories', () => {
  test('Unsinn als Eingabe → Standard für alle Kategorien', () => {
    for (const input of [undefined, null, 'kaputt', 42, [], [1, 2]]) {
      assert.deepEqual(sanitizeCategories(input), DEFAULT_CATEGORIES);
    }
  });

  test('Ergebnis ist eine Kopie – der Standard bleibt unverändert', () => {
    const result = sanitizeCategories({});
    const first = CATEGORY_IDS[0];
    result[first].variants[0].name = 'geändert';
    result[first].variants.push(variant('neu'));
    assert.notEqual(DEFAULT_CATEGORIES[first].variants[0].name, 'geändert');
    assert.deepEqual(sanitizeCategories({}), DEFAULT_CATEGORIES);
  });

  test('jede Kategorie ist immer da, fehlende bekommen den Standard', () => {
    const [first, ...rest] = CATEGORY_IDS;
    const result = sanitizeCategories({ [first]: { randomize: true, variants: [] }, unbekannt: { variants: [] } });
    assert.deepEqual(Object.keys(result).sort(), [...CATEGORY_IDS].sort());
    assert.deepEqual(result[first], { randomize: true, variants: [] });
    for (const id of rest) assert.deepEqual(result[id], DEFAULT_CATEGORIES[id]);
  });

  test('kaputte Kategorie → Standard, kaputte Variantenliste → leer', () => {
    const [a, b] = CATEGORY_IDS;
    const result = sanitizeCategories({ [a]: 'kaputt', [b]: { randomize: 'true', variants: 'keine Liste' } });
    assert.deepEqual(result[a], DEFAULT_CATEGORIES[a]);
    assert.deepEqual(result[b], { randomize: false, variants: [] });
  });

  test('kaputte Variante → vollständige Variante mit Standardwerten', () => {
    const [id] = CATEGORY_IDS;
    const [v] = sanitizeCategories({ [id]: { variants: [null] } })[id].variants;
    assert.equal(typeof v.id, 'string');
    assert.ok(v.id.length > 0);
    assert.equal(v.name, 'Variante');
    assert.equal(v.enabled, true);
    assert.deepEqual(v.conditions, DEFAULT_CONDITIONS);
    assert.deepEqual(v.design, DEFAULT_DESIGN);
  });

  test('alte Variante ohne neue Felder wird mit Standardwerten ergänzt', () => {
    const [id] = CATEGORY_IDS;
    const old = { id: 'alt', name: 'Alt', conditions: { minBits: 500 }, design: { message: 'Danke {user}!', tts: { enabled: true } } };
    const [v] = sanitizeCategories({ [id]: { variants: [old] } })[id].variants;
    assert.equal(v.id, 'alt');
    assert.deepEqual(v.conditions, { ...DEFAULT_CONDITIONS, minBits: 500 });
    assert.equal(v.design.message, 'Danke {user}!');
    assert.deepEqual(v.design.tts, { ...DEFAULT_DESIGN.tts, enabled: true });
    assert.deepEqual(v.design.celebration, DEFAULT_DESIGN.celebration);
  });

  test('falsche Typen fallen auf den Standard zurück, unbekannte Felder fliegen raus', () => {
    const v = sanitizeVariant({
      id: '',
      name: 'x'.repeat(200),
      enabled: false,
      evil: '<script>',
      conditions: { minBits: '500', rewardIds: [1, 'b'], subKind: 'resub' },
      design: { durationMs: '9999', fontSize: 20, rounded: 'ja', tts: 'kaputt', hack: true },
    });
    assert.notEqual(v.id, '');
    assert.equal(v.name.length, 80);
    assert.equal(v.enabled, false);
    assert.equal('evil' in v, false);
    assert.equal(v.conditions.minBits, DEFAULT_CONDITIONS.minBits);
    assert.deepEqual(v.conditions.rewardIds, ['1', 'b']);
    assert.equal(v.conditions.subKind, 'resub');
    assert.equal(v.design.durationMs, DEFAULT_DESIGN.durationMs);
    assert.equal(v.design.fontSize, 20);
    assert.equal(v.design.rounded, DEFAULT_DESIGN.rounded);
    assert.deepEqual(v.design.tts, DEFAULT_DESIGN.tts);
    assert.equal('hack' in v.design, false);
  });

  test('rewardIds, die keine Liste sind → leer', () => {
    assert.deepEqual(sanitizeVariant({ conditions: { rewardIds: 'a,b' } }).conditions.rewardIds, []);
  });

  test('Medien: nur gültige Bilder/Sounds, keine Pfade', () => {
    const media = (image: unknown, sound: unknown = null) => sanitizeVariant({ design: { image, sound } }).design;
    assert.deepEqual(media({ source: 'file', id: 'abc-1.png', name: 'Bild', kind: 'image' }).image, { source: 'file', id: 'abc-1.png', name: 'Bild', kind: 'image' });
    assert.deepEqual(media({ source: 'file', id: 'clip.webm', kind: 'video' }).image, { source: 'file', id: 'clip.webm', name: 'clip.webm', kind: 'video' });
    assert.deepEqual(media({ source: 'builtin', id: 'heart', name: 'Herzen', kind: 'image' }).image?.id, 'heart');
    // Pfade und fremde Quellen
    assert.equal(media({ source: 'file', id: '../../geheim.png', kind: 'image' }).image, null);
    assert.equal(media({ source: 'file', id: 'C:\\x.png', kind: 'image' }).image, null);
    assert.equal(media({ source: 'http', id: 'x.png', kind: 'image' }).image, null);
    assert.equal(media('heart.png').image, null);
    // falsche Art: Sound als Bild und umgekehrt
    assert.equal(media({ source: 'builtin', id: 'chime', kind: 'audio' }).image, null);
    assert.equal(media(null, { source: 'builtin', id: 'star', kind: 'image' }).sound, null);
    assert.deepEqual(media(null, { source: 'builtin', id: 'chime', name: 'Glocke', kind: 'audio' }).sound, { source: 'builtin', id: 'chime', name: 'Glocke', kind: 'audio' });
  });
});

// ------------------------------------------------------------------ Platzhalter

describe('fillPlain', () => {
  test('setzt bekannte Werte ein, lässt den Rest stehen', () => {
    assert.equal(fillPlain('{user} cheert {bits} Bits!', { user: 'Mini', bits: 500 }), 'Mini cheert 500 Bits!');
    assert.equal(fillPlain('{user} und {unbekannt}', { user: 'Mini' }), 'Mini und {unbekannt}');
    assert.equal(fillPlain('{user}{user}', { user: 'A' }), 'AA');
    assert.equal(fillPlain('{count}', { count: 0 }), '0');
    assert.equal(fillPlain('{user:x} {} { user }', { user: 'A' }), '{user:x} {} { user }');
    assert.equal(fillPlain('ohne Platzhalter', {}), 'ohne Platzhalter');
  });

  test('Groß-/Kleinschreibung zählt', () => {
    assert.equal(fillPlain('{User}', { user: 'Mini' }), '{User}');
  });
});

describe('describeEvent', () => {
  test('Werte für die Platzhalter', () => {
    assert.deepEqual(describeEvent(redemption('a')), { values: { user: 'Zuschauer', reward: 'Hydrate', cost: 100 }, userMessage: 'Text' });
    assert.deepEqual(describeEvent(resub(7, '2000')).values, { user: 'Zuschauer', tier: '2', months: 7 });
    assert.deepEqual(describeEvent(sub('3000')).values, { user: 'Zuschauer', tier: '3', months: 1 });
    assert.deepEqual(describeEvent(raid(12)).values, { user: 'Zuschauer', viewers: 12 });
  });

  test('anonym → "Anonym"', () => {
    assert.equal(describeEvent({ type: 'cheer', user: null, bits: 1, message: '' }).values.user, 'Anonym');
    assert.equal(describeEvent({ type: 'giftsub', user: null, tier: '1000', count: 5 }).values.user, 'Anonym');
  });

  test('Standard-Nachrichten lassen sich vollständig füllen', () => {
    const events: StreamEvent[] = [follow, giftsub(5), cheer(100), raid(3), redemption('a')];
    for (const event of events) {
      const category = categoryOf(event)!;
      const { values } = describeEvent(event);
      for (const v of DEFAULT_CATEGORIES[category].variants) {
        assert.doesNotMatch(fillPlain(v.design.message, values), /\{\w+\}/, `${category}/${v.id}`);
      }
    }
  });
});
