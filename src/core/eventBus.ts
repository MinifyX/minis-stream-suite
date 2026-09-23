import { createLogger } from './log';
import type { EventOfType, StreamEvent, StreamEventType } from './twitch/events';

type AnyHandler = (event: StreamEvent) => unknown;

function describe(event: StreamEvent): string {
  if (event.type === 'channelupdate') return `${event.test ? '[Test] ' : ''}Kanal geändert: „${event.categoryName}“ – ${event.title}`;
  if (event.type === 'streamonline') return `${event.test ? '[Test] ' : ''}Stream ist live 🔴`;
  if (event.type === 'streamoffline') return `${event.test ? '[Test] ' : ''}Stream beendet`;
  if (event.type === 'redemptionupdate') return `${event.test ? '[Test] ' : ''}Einlösung ${event.status === 'canceled' ? 'zurückerstattet' : 'erledigt'}`;
  if (event.type === 'hypetrain') return `${event.test ? '[Test] ' : ''}Hype Train ${event.phase === 'begin' ? 'gestartet' : event.phase === 'end' ? `beendet (Level ${event.level})` : `Level ${event.level}`}`;
  if (event.type === 'prediction') return `${event.test ? '[Test] ' : ''}Vorhersage ${{ begin: 'gestartet', progress: 'läuft', lock: 'gesperrt', end: 'beendet' }[event.phase]}: „${event.title}“`;
  if (event.type === 'adbreak') return `${event.test ? '[Test] ' : ''}Werbepause: ${event.durationSeconds} Sek.`;
  if (event.type === 'shoutout') return `${event.test ? '[Test] ' : ''}Shoutout an ${event.to.name}`;
  if (event.type === 'poll') return `${event.test ? '[Test] ' : ''}Twitch-Umfrage ${event.phase === 'begin' ? 'gestartet' : 'beendet'}: „${event.title}“`;
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
    // Chat-Nachrichten, Löschungen und Zwischenstände von Umfragen nicht ins Log schreiben (zu viele)
    const quiet = ['chat', 'chatdelete', 'chatclear'].includes(event.type)
      || ((event.type === 'poll' || event.type === 'prediction') && event.phase === 'progress');
    if (!quiet) this.log.info(describe(event));
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
