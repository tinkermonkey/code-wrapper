import { describe, it, expect } from 'vitest';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../sessions/SessionManager.js';
import { createSessionStore } from '../sessions/SessionStore.js';

// --------------------------------------------------------- SessionManager
describe('SessionManager', () => {
  describe('newSession / resumeSession round-trip', () => {
    it('returns a session with isFirst=true and valid timestamps', () => {
      const mgr = new SessionManager();
      const s = mgr.newSession('room-1');
      expect(s.isFirst).toBe(true);
      expect(typeof s.createdAt).toBe('string');
      expect(typeof s.lastActiveAt).toBe('string');
    });

    it('resumeSession returns the stored session', () => {
      const mgr = new SessionManager();
      mgr.newSession('room-2');
      const s = mgr.resumeSession('room-2');
      expect(s).toBeDefined();
      expect(s!.isFirst).toBe(true);
    });

    it('resumeSession returns undefined for an unknown key', () => {
      const mgr = new SessionManager();
      expect(mgr.resumeSession('no-such-key')).toBeUndefined();
    });

    it('newSession overwrites an existing session', () => {
      const mgr = new SessionManager();
      mgr.newSession('room-3');
      mgr.recordCliSessionId('room-3', 'old-cli-id');
      mgr.newSession('room-3'); // reset
      const s = mgr.resumeSession('room-3')!;
      expect(s.isFirst).toBe(true);
      expect(s.cliSessionId).toBeUndefined();
    });
  });

  describe('recordCliSessionId', () => {
    it('sets cliSessionId and marks isFirst = false', () => {
      const mgr = new SessionManager();
      mgr.newSession('room-4');
      mgr.recordCliSessionId('room-4', 'cli-sess-abc');
      const s = mgr.resumeSession('room-4')!;
      expect(s.cliSessionId).toBe('cli-sess-abc');
      expect(s.isFirst).toBe(false);
    });

    it('no-ops when the key does not exist', () => {
      const mgr = new SessionManager();
      expect(() => mgr.recordCliSessionId('ghost', 'x')).not.toThrow();
    });
  });

  describe('clearSession', () => {
    it('removes the session so resumeSession returns undefined', () => {
      const mgr = new SessionManager();
      mgr.newSession('room-5');
      mgr.clearSession('room-5');
      expect(mgr.resumeSession('room-5')).toBeUndefined();
    });

    it('no-ops when the key does not exist', () => {
      const mgr = new SessionManager();
      expect(() => mgr.clearSession('ghost')).not.toThrow();
    });
  });

  describe('listSessions + namespace', () => {
    it('returns only sessions belonging to this namespace', () => {
      // Each SessionManager gets its own in-memory store.
      // Use a shared file store to test cross-namespace isolation.
      const dir = mkdtempSync(join(tmpdir(), 'sm-ns-'));
      const path = join(dir, 'sessions.json');
      try {
        const ns1 = new SessionManager({ namespace: 'ns1', persistPath: path });
        const ns2 = new SessionManager({ namespace: 'ns2', persistPath: path });
        ns1.newSession('a');
        ns1.newSession('b');
        ns2.newSession('c');
        const list = ns1.listSessions();
        expect(list).toHaveLength(2);
        expect(list.every(s => s.key.startsWith('ns1:'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('empty namespace prefix matches all sessions', () => {
      const mgr = new SessionManager({ namespace: '' });
      mgr.newSession('x');
      mgr.newSession('y');
      expect(mgr.listSessions()).toHaveLength(2);
    });

    it('returns sessions sorted by lastActiveAt descending', async () => {
      const mgr = new SessionManager();
      mgr.newSession('old');
      await new Promise(r => setTimeout(r, 15));
      mgr.newSession('new');
      const list = mgr.listSessions();
      expect(list[0].key).toContain('new');
      expect(list[1].key).toContain('old');
    });
  });
});

// --------------------------------------------------------- MemoryStore
describe('createSessionStore (MemoryStore)', () => {
  it('get returns undefined for a missing key', () => {
    const store = createSessionStore();
    expect(store.get('k')).toBeUndefined();
  });

  it('set / get round-trip', () => {
    const store = createSessionStore();
    const session = { key: 'k', createdAt: 'now', lastActiveAt: 'now', isFirst: true };
    store.set(session);
    expect(store.get('k')).toEqual(session);
  });

  it('delete removes the entry', () => {
    const store = createSessionStore();
    store.set({ key: 'k', createdAt: 'now', lastActiveAt: 'now', isFirst: true });
    store.delete('k');
    expect(store.get('k')).toBeUndefined();
  });

  it('all returns sessions sorted by lastActiveAt descending', () => {
    const store = createSessionStore();
    store.set({ key: 'a', createdAt: 't', lastActiveAt: '2025-01-01T00:00:00.000Z', isFirst: true });
    store.set({ key: 'b', createdAt: 't', lastActiveAt: '2025-06-01T00:00:00.000Z', isFirst: true });
    const all = store.all();
    expect(all[0].key).toBe('b');
    expect(all[1].key).toBe('a');
  });
});

// --------------------------------------------------------- FileStore
describe('createSessionStore (FileStore)', () => {
  it('starts empty when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-test-'));
    const path = join(dir, 'sub', 'sessions.json'); // sub-dir not created yet
    try {
      const store = createSessionStore(path);
      expect(store.all()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists sessions across store instances (atomic write)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-test-'));
    const path = join(dir, 'sessions.json');
    try {
      const s1 = createSessionStore(path);
      s1.set({ key: 'k', createdAt: 'now', lastActiveAt: 'now', isFirst: true });
      const s2 = createSessionStore(path);
      expect(s2.get('k')).toMatchObject({ key: 'k' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delete is reflected after re-load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-test-'));
    const path = join(dir, 'sessions.json');
    try {
      const s1 = createSessionStore(path);
      s1.set({ key: 'k', createdAt: 'now', lastActiveAt: 'now', isFirst: true });
      s1.delete('k');
      const s2 = createSessionStore(path);
      expect(s2.get('k')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flush propagates write errors (read-only directory)', () => {
    // Not testable as root or on Windows where chmod has no effect.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const readonlyDir = mkdtempSync(join(tmpdir(), 'fs-ro-'));
    chmodSync(readonlyDir, 0o555);
    const path = join(readonlyDir, 'sessions.json');
    const store = createSessionStore(path);
    try {
      expect(() =>
        store.set({ key: 'k', createdAt: 'now', lastActiveAt: 'now', isFirst: true })
      ).toThrow();
    } finally {
      chmodSync(readonlyDir, 0o755);
      rmSync(readonlyDir, { recursive: true, force: true });
    }
  });
});
