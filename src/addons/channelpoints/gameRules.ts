/**
 * Spiel-Regeln der Kanalpunkte (ohne Twitch-Zugriff, damit man sie testen kann):
 * Welche Belohnung soll beim aktuellen Spiel aktiv sein, welche ausgeblendet oder pausiert?
 */

export interface Game {
  id: string;
  name: string;
}

export interface GameRule {
  games: Game[];
  /** Was bei anderen Spielen passiert: ausblenden (Zuschauer sehen sie nicht) oder pausieren (sichtbar, aber gesperrt) */
  mode: 'hide' | 'pause';
}

/** Was eine Gruppe für die Spiel-Regeln mitbringen muss */
export interface RuleGroup {
  rewardIds: string[];
  gameRule?: GameRule | null;
}

export interface WantedState {
  active: boolean;
  mode: GameRule['mode'];
}

/**
 * Was jede Belohnung mit Spiel-Regel gerade sein soll.
 * Eine eigene Regel der Belohnung gewinnt. Sonst: Liegt sie in mehreren Gruppen mit Regel,
 * ist sie aktiv, sobald eine davon passt.
 * Belohnungen ohne Regel (weder eigene noch über eine Gruppe) fehlen in der Map.
 */
export function wantedStates(groups: RuleGroup[], rewardRules: Record<string, GameRule>, game: Game): Map<string, WantedState> {
  const wanted = new Map<string, WantedState>();
  for (const group of groups) {
    const rule = group.gameRule;
    if (!rule?.games.length) continue;
    const matches = rule.games.some((g) => g.id === game.id);
    for (const id of group.rewardIds) {
      const prev = wanted.get(id);
      wanted.set(id, {
        active: (prev?.active ?? false) || matches,
        // "Ausblenden" gewinnt, wenn sich Gruppen widersprechen
        mode: prev?.mode === 'hide' || rule.mode === 'hide' ? 'hide' : 'pause',
      });
    }
  }
  for (const [id, rule] of Object.entries(rewardRules)) {
    if (rule.games.length) wanted.set(id, { active: rule.games.some((g) => g.id === game.id), mode: rule.mode });
  }
  return wanted;
}
