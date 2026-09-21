import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Einfacher JSON-Speicher im AppData-Ordner (%APPDATA%/Mini's Stream Suite).
 * Fehlende Werte werden mit den Standardwerten aufgefüllt – so können neue
 * Einstellungen dazukommen, ohne dass alte Dateien kaputtgehen.
 */
export class ConfigStore<T extends object> {
  readonly file: string;
  private data: T;

  constructor(name: string, private defaults: T) {
    this.file = path.join(app.getPath('userData'), `${name}.json`);
    this.data = this.load();
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.data[key];
  }

  all(): T {
    return structuredClone(this.data);
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    this.data[key] = value;
    this.save();
  }

  update(patch: Partial<T>): void {
    Object.assign(this.data, patch);
    this.save();
  }

  private load(): T {
    let stored: Record<string, unknown> = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // Datei existiert noch nicht (erster Start) → Standardwerte
    }
    const result = structuredClone(this.defaults) as Record<string, unknown>;
    for (const [key, value] of Object.entries(stored)) {
      const fallback = result[key];
      result[key] = isPlainObject(fallback) && isPlainObject(value) ? { ...fallback, ...value } : value;
    }
    return result as T;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
