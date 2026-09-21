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
}

export const CHANNELPOINTS_SERVICE = 'channelpoints';
