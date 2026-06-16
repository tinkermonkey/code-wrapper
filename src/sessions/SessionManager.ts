import { createSessionStore } from './SessionStore.js';
import type { ISessionStore } from './SessionStore.js';
import type { Session } from './types.js';

export interface SessionManagerOptions {
  /** Path to the sessions JSON file. Omit for in-memory only. */
  persistPath?: string;
  /** Optional prefix applied to all keys — useful for multi-tenant apps */
  namespace?: string;
}

/**
 * Manages conversation sessions for one or more concurrent callers.
 *
 * The containing application owns threading — SessionManager does not impose
 * a conversation model. It provides helpers to start, continue, and inspect
 * sessions while keeping the CLI-level session ID in sync.
 */
export class SessionManager {
  private readonly store: ISessionStore;
  private readonly ns: string;

  constructor(options: SessionManagerOptions = {}) {
    this.ns = options.namespace ? `${options.namespace}:` : '';
    this.store = createSessionStore(options.persistPath);
  }

  /**
   * Start a fresh conversation for key.
   * Overwrites any existing session — call resumeSession() first if you want
   * to continue an existing one.
   */
  newSession(key: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      key: this.ns + key,
      createdAt: now,
      lastActiveAt: now,
      isFirst: true,
    };
    this.store.set(session);
    return session;
  }

  /**
   * Look up an existing session.
   * Returns undefined if no session exists — call newSession() in that case.
   */
  resumeSession(key: string): Session | undefined {
    return this.store.get(this.ns + key);
  }

  /** All sessions sorted by most-recently-active first */
  listSessions(): Session[] {
    return this.store.all();
  }

  /**
   * Store the CLI-assigned session ID from the 'done' event and mark
   * isFirst = false. Must be called after each successful turn so that
   * the next turn uses --resume instead of --session-id.
   */
  recordCliSessionId(key: string, cliSessionId: string): void {
    const session = this.store.get(this.ns + key);
    if (!session) return;
    session.cliSessionId = cliSessionId;
    session.isFirst = false;
    session.lastActiveAt = new Date().toISOString();
    this.store.set(session);
  }

  /** Update lastActiveAt — call after each completed turn */
  touch(key: string): void {
    const session = this.store.get(this.ns + key);
    if (!session) return;
    session.lastActiveAt = new Date().toISOString();
    this.store.set(session);
  }

  /**
   * Remove a session. Call this after receiving a 'stale_session' error so
   * the next call starts fresh instead of retrying the dead session ID.
   */
  clearSession(key: string): void {
    this.store.delete(this.ns + key);
  }
}
