import { randomUUID } from 'node:crypto';
import { parseRole, type Role } from '../../core/chat';
import { HttpError } from '../../core/server';

// ------------------------------------------------------------------ Datenmodell

/** Wodurch eine Aktion ausgelöst wird */
export type Trigger =
  /** Nur per Test-Knopf */
  | { type: 'manual' }
  /** Kanalpunkte-Belohnung (auch fremde – wir lesen nur die Einlösungen) */
  | { type: 'reward'; rewardId: string; rewardTitle: string }
  /** Chat-Command inkl. Präfix, z.B. "!kamera" */
  | { type: 'command'; command: string; role: Role; cooldown: number }
  | { type: 'follow' }
  /** Neuer Sub, Resub oder Geschenk-Subs (einmal pro Geschenk) */
  | { type: 'sub' }
  | { type: 'cheer'; minBits: number }
  | { type: 'raid'; minViewers: number };

export type TriggerType = Trigger['type'];

/** Ein Schritt einer Aktion. revertAfter = Sekunden, nach denen der alte Zustand zurückkommt (0 = nie). */
export type Step =
  | { type: 'scene'; scene: string; revertAfter: number }
  | {
    type: 'source';
    scene: string;
    /** Wenn die Quelle in einer Gruppe steckt: Name der Gruppe, sonst "" */
    group: string;
    source: string;
    mode: 'show' | 'hide' | 'toggle';
    revertAfter: number;
  }
  | { type: 'filter'; source: string; filter: string; mode: 'on' | 'off' | 'toggle'; revertAfter: number }
  | { type: 'wait'; ms: number };

export interface ObsAction {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  /** Was passiert, wenn die Aktion ausgelöst wird, während sie noch läuft */
  overlap: 'queue' | 'skip';
  steps: Step[];
}

export interface Settings {
  host: string;
  port: number;
  /** Wird nur lokal in der Einstellungsdatei gespeichert */
  password: string;
  autoConnect: boolean;
  /** false = Not-Aus: keine Auslöser werden ausgeführt */
  actionsEnabled: boolean;
  /** Auch auf Test-Events (Test-Knöpfe in der Übersicht) reagieren */
  reactToTests: boolean;
  actions: ObsAction[];
}

export const DEFAULTS: Settings = {
  host: '127.0.0.1',
  port: 4455,
  password: '',
  autoConnect: true,
  actionsEnabled: true,
  reactToTests: false,
  actions: [],
};

export const MAX_STEPS = 30;
/** Längste Wartezeit in einem Schritt (10 Minuten) */
export const MAX_WAIT_MS = 10 * 60_000;
/** Längstes „nach X Sekunden zurück“ (1 Stunde) */
export const MAX_REVERT_S = 3600;

// ------------------------------------------------------------------ Eingaben prüfen

const str = (value: unknown, max = 256) => String(value ?? '').trim().slice(0, max);
const num = (value: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(value) || 0)));

export function cleanHost(value: unknown): string {
  const host = str(value, 255).replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
  if (!host || /\s/.test(host)) throw new HttpError(400, 'Bitte eine gültige Adresse eintragen, z.B. 127.0.0.1 oder 192.168.0.20.');
  return host;
}

export function cleanPort(value: unknown): number {
  const port = Math.round(Number(value));
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new HttpError(400, 'Der Port muss zwischen 1 und 65535 liegen (Standard: 4455).');
  return port;
}

/** "Kamera" → "!kamera", "?szene" bleibt "?szene" */
export function cleanCommand(value: unknown): string {
  let text = str(value, 40).toLowerCase().split(/\s+/)[0] ?? '';
  if (text && /^[\p{L}\p{N}]/u.test(text)) text = `!${text}`;
  if (!/^[!?#.$%&~][\p{L}\p{N}_-]{1,30}$/u.test(text)) {
    throw new HttpError(400, 'Der Chat-Command braucht ein Präfix und einen Namen aus Buchstaben, Zahlen, _ oder -, z.B. !kamera.');
  }
  return text;
}

function validateTrigger(input: unknown): Trigger {
  const t = (input ?? {}) as Record<string, unknown>;
  switch (t.type) {
    case 'reward': {
      const rewardId = str(t.rewardId, 100);
      if (!rewardId) throw new HttpError(400, 'Bitte eine Kanalpunkte-Belohnung auswählen.');
      return { type: 'reward', rewardId, rewardTitle: str(t.rewardTitle, 45) };
    }
    case 'command':
      return { type: 'command', command: cleanCommand(t.command), role: parseRole(t.role), cooldown: num(t.cooldown, 0, 86_400) };
    case 'follow':
    case 'sub':
      return { type: t.type };
    case 'cheer':
      return { type: 'cheer', minBits: num(t.minBits, 1, 10_000_000) };
    case 'raid':
      return { type: 'raid', minViewers: num(t.minViewers, 1, 10_000_000) };
    default:
      return { type: 'manual' };
  }
}

function validateStep(input: unknown, index: number): Step {
  const s = (input ?? {}) as Record<string, unknown>;
  const where = `Schritt ${index + 1}`;
  const revertAfter = num(s.revertAfter, 0, MAX_REVERT_S);
  switch (s.type) {
    case 'scene': {
      const scene = str(s.scene);
      if (!scene) throw new HttpError(400, `${where}: Bitte eine Szene auswählen.`);
      return { type: 'scene', scene, revertAfter };
    }
    case 'source': {
      const scene = str(s.scene);
      const source = str(s.source);
      if (!scene || !source) throw new HttpError(400, `${where}: Bitte Szene und Quelle auswählen.`);
      const mode = s.mode === 'hide' || s.mode === 'toggle' ? s.mode : 'show';
      return { type: 'source', scene, group: str(s.group), source, mode, revertAfter };
    }
    case 'filter': {
      const source = str(s.source);
      const filter = str(s.filter);
      if (!source || !filter) throw new HttpError(400, `${where}: Bitte Quelle und Filter auswählen.`);
      const mode = s.mode === 'off' || s.mode === 'toggle' ? s.mode : 'on';
      return { type: 'filter', source, filter, mode, revertAfter };
    }
    case 'wait': {
      const ms = num(s.ms, 0, MAX_WAIT_MS);
      if (!ms) throw new HttpError(400, `${where}: Die Wartezeit muss größer als 0 sein.`);
      return { type: 'wait', ms };
    }
    default:
      throw new HttpError(400, `${where}: Unbekannte Art „${String(s.type)}“.`);
  }
}

export function validateAction(input: unknown): ObsAction {
  const a = (input ?? {}) as Record<string, unknown>;
  const name = str(a.name, 60);
  if (!name) throw new HttpError(400, 'Bitte gib der Aktion einen Namen.');
  const rawSteps = Array.isArray(a.steps) ? a.steps : [];
  if (!rawSteps.length) throw new HttpError(400, 'Die Aktion braucht mindestens einen Schritt.');
  if (rawSteps.length > MAX_STEPS) throw new HttpError(400, `Höchstens ${MAX_STEPS} Schritte pro Aktion.`);
  return {
    id: typeof a.id === 'string' && a.id ? a.id : randomUUID(),
    name,
    enabled: a.enabled !== false,
    trigger: validateTrigger(a.trigger),
    overlap: a.overlap === 'skip' ? 'skip' : 'queue',
    steps: rawSteps.map(validateStep),
  };
}

/** Kurze Beschreibung eines Schritts für den Log */
export function describeStep(step: Step): string {
  switch (step.type) {
    case 'scene':
      return `Szene „${step.scene}“`;
    case 'source': {
      const verb = { show: 'einblenden', hide: 'ausblenden', toggle: 'umschalten' }[step.mode];
      return `Quelle „${step.source}“ ${verb}`;
    }
    case 'filter': {
      const verb = { on: 'an', off: 'aus', toggle: 'umschalten' }[step.mode];
      return `Filter „${step.filter}“ auf „${step.source}“ ${verb}`;
    }
    case 'wait':
      return `${step.ms} ms warten`;
  }
}

// ------------------------------------------------------------------ Umbenennen in OBS

/** Szene/Gruppe wurde in OBS umbenannt → in allen Aktionen nachziehen. Gibt true zurück, wenn sich etwas geändert hat. */
export function renameScene(actions: ObsAction[], oldName: string, newName: string): boolean {
  let changed = false;
  for (const action of actions) {
    for (const step of action.steps) {
      if ((step.type === 'scene' || step.type === 'source') && step.scene === oldName) {
        step.scene = newName;
        changed = true;
      }
      if (step.type === 'source' && step.group === oldName) {
        step.group = newName;
        changed = true;
      }
      // Szenen können auch Filter haben
      if (step.type === 'filter' && step.source === oldName) {
        step.source = newName;
        changed = true;
      }
    }
  }
  return changed;
}

/** Quelle wurde umbenannt */
export function renameSource(actions: ObsAction[], oldName: string, newName: string): boolean {
  let changed = false;
  for (const action of actions) {
    for (const step of action.steps) {
      if ((step.type === 'source' || step.type === 'filter') && step.source === oldName) {
        step.source = newName;
        changed = true;
      }
    }
  }
  return changed;
}

/** Filter wurde umbenannt */
export function renameFilter(actions: ObsAction[], sourceName: string, oldName: string, newName: string): boolean {
  let changed = false;
  for (const action of actions) {
    for (const step of action.steps) {
      if (step.type === 'filter' && step.source === sourceName && step.filter === oldName) {
        step.filter = newName;
        changed = true;
      }
    }
  }
  return changed;
}
