import { createLogger } from './log';
import type { EventOfType, StreamEvent, StreamEventType } from './twitch/events';

type AnyHandler = (event: StreamEvent) => unknown;

function describe(event: StreamEvent): string {
  if (event.type === 'channelupdate') return `${event.test ? '[Test] ' : ''}Kanal geändert: „${event.categoryName}“ – ${event.title}`;
  const who = 'user' in event && event.user ? event.user.name : 'Anonym';
  const extra = event.type === 'redemption' ? ` („${event.reward.title}“)` : '';
  return `${event.test ? '[Test] ' : ''}${event.type} von ${who}${extra}`;
}

/**
 * Zentrale Verteilstelle: EventSub (oder ein Test-Button) schickt Events rein,
 * alle Addons, die sich dafür angemeldet haben, bekommen sie.
 */
export class EventBus {
  private handlers = new Map<StreamEventType | '*', Set<AnyHandler>>();
  private log = createLogger('Events');

  /** Auf eine Event-Art hören. Gibt eine Funktion zum Abmelden zurück. */
  on<T extends StreamEventType>(type: T, handler: (event: EventOfType<T>) => unknown): () => void {
    return this.add(type, handler as AnyHandler);
  }

  /** Auf alle Events hören. */
  onAny(handler: (event: StreamEvent) => unknown): () => void {
    return this.add('*', handler);
  }

  emit(event: StreamEvent): void {
    if (event.type !== 'chat') this.log.info(describe(event));
    for (const key of [event.type, '*'] as const) {
      for (const handler of this.handlers.get(key) ?? []) {
        try {
          const result = handler(event);
          if (result instanceof Promise) result.catch((err) => this.log.error('Fehler in einem Addon:', err));
        } catch (err) {
          this.log.error('Fehler in einem Addon:', err);
        }
      }
    }
  }

  private add(key: StreamEventType | '*', handler: AnyHandler): () => void {
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }
}
