/** Schnittstelle, die das Kanalpunkte-Addon anderen Addons (z.B. Alerts) anbietet. */

export interface GroupInfo {
  id: string;
  name: string;
  icon: string;
  color: string;
}

export interface ChannelPointsService {
  /** Alle Gruppen */
  groups(): GroupInfo[];
  /** Gruppen, in denen eine Belohnung steckt */
  groupsOf(rewardId: string): GroupInfo[];
  /** Gruppe für Weiterleitungen (z.B. UwUClip): „HudFX“ & Co., null = in keiner Gruppe */
  effectOf(rewardId: string): RewardEffect | null;
}

/** In welcher Gruppe eine Belohnung steckt und ob sie einer anderen App gehört (z.B. HudFX) */
export interface RewardEffect {
  group: string;
  foreign: boolean;
}

/**
 * Gruppe einer Belohnung bestimmen. Steckt sie in mehreren Gruppen, gewinnt eine Gruppe namens
 * „HudFX“, dann eine Gruppe mit „andere App“, sonst die erste. foreign = Gruppe oder Belohnung
 * selbst ist als „gehört einer anderen App“ markiert.
 */
export function effectOf(
  groups: { name: string; foreign?: boolean; rewardIds: string[] }[],
  foreignRewards: string[],
  rewardId: string,
): RewardEffect | null {
  const mine = groups.filter((g) => g.rewardIds.includes(rewardId));
  if (!mine.length) return null;
  const group = mine.find((g) => g.name.trim().toLowerCase() === 'hudfx') ?? mine.find((g) => g.foreign) ?? mine[0];
  return { group: group.name, foreign: foreignRewards.includes(rewardId) || mine.some((g) => g.foreign === true) };
}

export const CHANNELPOINTS_SERVICE = 'channelpoints';
