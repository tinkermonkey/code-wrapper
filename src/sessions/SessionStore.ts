import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session } from './types.js';

export interface ISessionStore {
  get(key: string): Session | undefined;
  set(session: Session): void;
  delete(key: string): void;
  all(): Session[];
}

const byLastActive = (a: Session, b: Session): number =>
  new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();

class MemoryStore implements ISessionStore {
  private readonly data = new Map<string, Session>();
  get(key: string) { return this.data.get(key); }
  set(session: Session) { this.data.set(session.key, session); }
  delete(key: string) { this.data.delete(key); }
  all(): Session[] { return [...this.data.values()].sort(byLastActive); }
}

class FileStore implements ISessionStore {
  private data: Record<string, Session> = {};

  constructor(private readonly path: string) {
    this.load();
  }

  get(key: string): Session | undefined {
    return this.data[key];
  }

  set(session: Session): void {
    this.data[session.key] = session;
    this.flush();
  }

  delete(key: string): void {
    delete this.data[key];
    this.flush();
  }

  all(): Session[] {
    return Object.values(this.data).sort(byLastActive);
  }

  private load(): void {
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, Session>;
    } catch {
      // File does not exist yet (first use) or is unreadable — start empty.
      this.data = {};
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    renameSync(tmp, this.path); // atomic on POSIX
  }
}

/** Returns a file-backed store if persistPath is given, otherwise in-memory */
export function createSessionStore(persistPath?: string): ISessionStore {
  return persistPath ? new FileStore(persistPath) : new MemoryStore();
}
