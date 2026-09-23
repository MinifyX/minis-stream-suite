import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { wantedStates, type Game, type GameRule, type RuleGroup } from './gameRules';

const minecraft: Game = { id: '27471', name: 'Minecraft' };
const valorant: Game = { id: '516575', name: 'VALORANT' };
const chatting: Game = { id: '509658', name: 'Just Chatting' };

const rule = (mode: GameRule['mode'], ...games: Game[]): GameRule => ({ games, mode });
const group = (rewardIds: string[], gameRule?: GameRule | null): RuleGroup => ({ rewardIds, gameRule });

describe('Spiel-Regeln: wantedStates', () => {
  test('ohne Regeln ist die Map leer', () => {
    assert.equal(wantedStates([], {}, minecraft).size, 0);
    assert.equal(wantedStates([group(['a', 'b'])], {}, minecraft).size, 0);
    assert.equal(wantedStates([group(['a'], null)], {}, minecraft).size, 0);
  });

  test('Regel ohne Spiele zählt nicht', () => {
    const wanted = wantedStates([group(['a'], rule('hide'))], { b: rule('pause') }, minecraft);
    assert.equal(wanted.size, 0);
  });

  test('Gruppe mit passendem Spiel → aktiv', () => {
    const wanted = wantedStates([group(['a', 'b'], rule('hide', minecraft, valorant))], {}, minecraft);
    assert.deepEqual(wanted.get('a'), { active: true, mode: 'hide' });
    assert.deepEqual(wanted.get('b'), { active: true, mode: 'hide' });
  });

  test('Gruppe mit anderem Spiel → inaktiv mit dem Modus der Gruppe', () => {
    assert.deepEqual(wantedStates([group(['a'], rule('hide', minecraft))], {}, chatting).get('a'), { active: false, mode: 'hide' });
    assert.deepEqual(wantedStates([group(['a'], rule('pause', minecraft))], {}, chatting).get('a'), { active: false, mode: 'pause' });
  });

  test('Spiele werden über die ID verglichen, nicht über den Namen', () => {
    const renamed: Game = { id: minecraft.id, name: 'Anderer Name' };
    const sameName: Game = { id: '1', name: minecraft.name };
    assert.equal(wantedStates([group(['a'], rule('hide', minecraft))], {}, renamed).get('a')?.active, true);
    assert.equal(wantedStates([group(['a'], rule('hide', minecraft))], {}, sameName).get('a')?.active, false);
  });

  test('mehrere Gruppen: aktiv, sobald eine passt (egal in welcher Reihenfolge)', () => {
    const passt = group(['a'], rule('pause', minecraft));
    const passtNicht = group(['a'], rule('pause', valorant));
    assert.equal(wantedStates([passt, passtNicht], {}, minecraft).get('a')?.active, true);
    assert.equal(wantedStates([passtNicht, passt], {}, minecraft).get('a')?.active, true);
    assert.equal(wantedStates([passtNicht, passtNicht], {}, minecraft).get('a')?.active, false);
  });

  test('mehrere Gruppen: "ausblenden" gewinnt gegen "pausieren" (egal in welcher Reihenfolge)', () => {
    const hide = group(['a'], rule('hide', valorant));
    const pause = group(['a'], rule('pause', valorant));
    assert.deepEqual(wantedStates([hide, pause], {}, minecraft).get('a'), { active: false, mode: 'hide' });
    assert.deepEqual(wantedStates([pause, hide], {}, minecraft).get('a'), { active: false, mode: 'hide' });
    assert.deepEqual(wantedStates([pause, pause], {}, minecraft).get('a'), { active: false, mode: 'pause' });
  });

  test('Gruppen ohne Regel stören nicht', () => {
    const wanted = wantedStates([group(['a']), group(['a'], rule('pause', minecraft)), group(['a'], null)], {}, chatting);
    assert.deepEqual(wanted.get('a'), { active: false, mode: 'pause' });
  });

  test('nur Belohnungen aus Gruppen mit Regel landen in der Map', () => {
    const wanted = wantedStates([group(['a'], rule('hide', minecraft)), group(['b'])], {}, minecraft);
    assert.deepEqual([...wanted.keys()], ['a']);
  });

  test('eigene Regel ohne Gruppe', () => {
    assert.deepEqual(wantedStates([], { x: rule('pause', valorant) }, valorant).get('x'), { active: true, mode: 'pause' });
    assert.deepEqual(wantedStates([], { x: rule('pause', valorant) }, minecraft).get('x'), { active: false, mode: 'pause' });
  });

  test('eigene Regel gewinnt gegen die Gruppe – in beide Richtungen', () => {
    const groups = [group(['a'], rule('hide', minecraft))];
    // Gruppe sagt aktiv, eigene Regel sagt pausieren
    assert.deepEqual(wantedStates(groups, { a: rule('pause', valorant) }, minecraft).get('a'), { active: false, mode: 'pause' });
    // Gruppe sagt ausblenden, eigene Regel sagt aktiv
    assert.deepEqual(wantedStates(groups, { a: rule('pause', valorant) }, valorant).get('a'), { active: true, mode: 'pause' });
  });

  test('eigene Regel ohne Spiele → die Gruppe entscheidet', () => {
    const groups = [group(['a'], rule('hide', minecraft))];
    assert.deepEqual(wantedStates(groups, { a: rule('pause') }, chatting).get('a'), { active: false, mode: 'hide' });
  });

  test('eigene Regel betrifft nur die eigene Belohnung', () => {
    const groups = [group(['a', 'b'], rule('hide', minecraft))];
    const wanted = wantedStates(groups, { a: rule('pause', chatting) }, chatting);
    assert.deepEqual(wanted.get('a'), { active: true, mode: 'pause' });
    assert.deepEqual(wanted.get('b'), { active: false, mode: 'hide' });
  });
});
