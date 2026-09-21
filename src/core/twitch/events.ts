/**
 * Einheitliche Event-Typen der Suite. EventSub liefert je Event-Art ein
 * anderes Format – hier wird alles in eine einfache, gleiche Form gebracht,
 * damit Addons sich nicht um Twitch-Details kümmern müssen.
 */

export interface TwitchUserRef {
  id: string;
  login: string;
  name: string;
}

export interface RewardRef {
  id: string;
  title: string;
  cost: number;
}

type EventData =
  | { type: 'redemption'; redemptionId: string; user: TwitchUserRef; reward: RewardRef; input: string }
  | { type: 'follow'; user: TwitchUserRef }
  | { type: 'sub'; user: TwitchUserRef; tier: string; isGift: boolean }
  | { type: 'resub'; user: TwitchUserRef; tier: string; months: number; message: string }
  | { type: 'giftsub'; user: TwitchUserRef | null; tier: string; count: number }
  | { type: 'cheer'; user: TwitchUserRef | null; bits: number; message: string }
  | { type: 'raid'; user: TwitchUserRef; viewers: number }
  | { type: 'chat'; messageId: string; user: TwitchUserRef; message: string; badges: string[] }
  /** Titel oder Kategorie (Spiel) des Kanals wurde geändert */
  | { type: 'channelupdate'; title: string; categoryId: string; categoryName: string };

/** `test: true` bei Events, die über einen Test-Button ausgelöst wurden. */
export type StreamEvent = EventData & { test?: boolean };
export type StreamEventType = StreamEvent['type'];
export type EventOfType<T extends StreamEventType> = Extract<StreamEvent, { type: T }>;

export const EVENT_TYPES: StreamEventType[] = ['redemption', 'follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'chat', 'channelupdate'];

function userRef(id?: string | null, login?: string | null, name?: string | null): TwitchUserRef | null {
  if (!id) return null;
  return { id, login: login ?? '', name: name ?? login ?? '' };
}

/** Wandelt ein rohes EventSub-Event in ein StreamEvent um (oder null, wenn unbekannt). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeEvent(subscriptionType: string, e: any): StreamEvent | null {
  switch (subscriptionType) {
    case 'channel.channel_points_custom_reward_redemption.add':
      return {
        type: 'redemption',
        redemptionId: e.id,
        user: userRef(e.user_id, e.user_login, e.user_name)!,
        reward: { id: e.reward.id, title: e.reward.title, cost: e.reward.cost },
        input: e.user_input ?? '',
      };
    case 'channel.follow':
      return { type: 'follow', user: userRef(e.user_id, e.user_login, e.user_name)! };
    case 'channel.subscribe':
      return { type: 'sub', user: userRef(e.user_id, e.user_login, e.user_name)!, tier: e.tier, isGift: !!e.is_gift };
    case 'channel.subscription.message':
      return {
        type: 'resub',
        user: userRef(e.user_id, e.user_login, e.user_name)!,
        tier: e.tier,
        months: e.cumulative_months ?? 0,
        message: e.message?.text ?? '',
      };
    case 'channel.subscription.gift':
      return {
        type: 'giftsub',
        user: e.is_anonymous ? null : userRef(e.user_id, e.user_login, e.user_name),
        tier: e.tier,
        count: e.total ?? 1,
      };
    case 'channel.cheer':
      return {
        type: 'cheer',
        user: e.is_anonymous ? null : userRef(e.user_id, e.user_login, e.user_name),
        bits: e.bits,
        message: e.message ?? '',
      };
    case 'channel.raid':
      return {
        type: 'raid',
        user: userRef(e.from_broadcaster_user_id, e.from_broadcaster_user_login, e.from_broadcaster_user_name)!,
        viewers: e.viewers,
      };
    case 'channel.chat.message':
      return {
        type: 'chat',
        messageId: e.message_id,
        user: userRef(e.chatter_user_id, e.chatter_user_login, e.chatter_user_name)!,
        message: e.message?.text ?? '',
        badges: (e.badges ?? []).map((b: { set_id: string }) => b.set_id),
      };
    case 'channel.update':
      return { type: 'channelupdate', title: e.title ?? '', categoryId: e.category_id ?? '', categoryName: e.category_name ?? '' };
    default:
      return null;
  }
}

const TEST_USER: TwitchUserRef = { id: '0', login: 'testuser', name: 'TestUser' };

/** Erzeugt ein Fake-Event zum Testen. Optional mit einer echten Belohnung. */
export function makeTestEvent(type: StreamEventType, reward?: Partial<RewardRef>): StreamEvent {
  const base = { test: true as const };
  switch (type) {
    case 'redemption':
      return {
        ...base,
        type,
        redemptionId: 'test',
        user: TEST_USER,
        reward: {
          id: String(reward?.id ?? 'test-reward'),
          title: String(reward?.title ?? 'Test-Belohnung'),
          cost: Number(reward?.cost) || 100,
        },
        input: '',
      };
    case 'follow':
      return { ...base, type, user: TEST_USER };
    case 'sub':
      return { ...base, type, user: TEST_USER, tier: '1000', isGift: false };
    case 'resub':
      return { ...base, type, user: TEST_USER, tier: '1000', months: 12, message: 'Schon ein Jahr dabei!' };
    case 'giftsub':
      return { ...base, type, user: TEST_USER, tier: '1000', count: 5 };
    case 'cheer':
      return { ...base, type, user: TEST_USER, bits: 500, message: 'Cheer500 GG!' };
    case 'raid':
      return { ...base, type, user: TEST_USER, viewers: 42 };
    case 'chat':
      return { ...base, type, messageId: 'test', user: TEST_USER, message: '!test', badges: [] };
    case 'channelupdate':
      return { ...base, type, title: 'Test-Stream', categoryId: '27471', categoryName: 'Minecraft' };
  }
}
