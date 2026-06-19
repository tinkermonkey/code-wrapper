import { describe, it, expect } from 'vitest';
import { runWithRecovery } from '../process/recovery.js';
import type { ClaudeEvent, ErrorEvent, DoneEvent, ReadyEvent } from '../events/types.js';
import type { CliProcess } from '../process/CliProcess.js';
import type { SessionManager } from '../sessions/SessionManager.js';
import type { ProcessOptions } from '../process/types.js';

// --- helpers ---

const makeError = (code: string, seq = 0): ErrorEvent => ({
  seq, timestamp: 0, type: 'error', code: code as ErrorEvent['code'], detail: `${code} error`,
});

const makeDone = (seq = 1): DoneEvent => ({
  seq, timestamp: 0, type: 'done', sessionId: 'new-sess',
});

const makeReady = (seq = 0): ReadyEvent => ({
  seq, timestamp: 0, type: 'ready', sessionId: 'sess-1',
});

function makeMockProc(runs: Array<ClaudeEvent[]>): CliProcess {
  let call = 0;
  return {
    async *run(_opts: ProcessOptions) {
      const events = runs[call++] ?? [];
      yield* events;
    },
  } as unknown as CliProcess;
}

function makeMockSessions(): SessionManager & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    clearSession(key: string) { cleared.push(key); },
  } as unknown as SessionManager & { cleared: string[] };
}

const BASE: ProcessOptions = { cwd: '/tmp', prompt: 'test' };

// --- tests ---

describe('runWithRecovery', () => {
  it('passes through normal events unchanged', async () => {
    const done = makeDone();
    const events: ClaudeEvent[] = [];
    for await (const e of runWithRecovery(makeMockProc([[done]]), makeMockSessions(), 'key', BASE)) {
      events.push(e);
    }
    expect(events).toEqual([done]);
  });

  it('intercepts stale_session: clears session, retries once, does not yield stale error', async () => {
    const stale = makeError('stale_session');
    const done = makeDone();
    const sessions = makeMockSessions();
    const events: ClaudeEvent[] = [];

    for await (const e of runWithRecovery(makeMockProc([[stale], [done]]), sessions, 'myKey', BASE)) {
      events.push(e);
    }

    expect(events).toEqual([done]);
    expect(sessions.cleared).toEqual(['myKey']);
  });

  it('retries with sessionId: undefined and isFirstMessage: true', async () => {
    const capturedOpts: ProcessOptions[] = [];
    let call = 0;
    const proc: CliProcess = {
      async *run(opts: ProcessOptions) {
        capturedOpts.push({ ...opts });
        if (call++ === 0) yield makeError('stale_session');
        else yield makeDone();
      },
    } as unknown as CliProcess;

    const opts = { ...BASE, sessionId: 'old-sess', isFirstMessage: false };
    for await (const _ of runWithRecovery(proc, makeMockSessions(), 'k', opts)) { /* drain */ }

    expect(capturedOpts[0]).toMatchObject({ sessionId: 'old-sess', isFirstMessage: false });
    expect(capturedOpts[1]).toMatchObject({ sessionId: undefined, isFirstMessage: true });
  });

  it('yields second stale_session without retrying again', async () => {
    const stale1 = makeError('stale_session', 0);
    const stale2 = makeError('stale_session', 1);
    const sessions = makeMockSessions();
    const events: ClaudeEvent[] = [];

    for await (const e of runWithRecovery(makeMockProc([[stale1], [stale2]]), sessions, 'k', BASE)) {
      events.push(e);
    }

    // First stale triggers retry and is swallowed; second is yielded as-is.
    expect(events).toEqual([stale2]);
    expect(sessions.cleared).toHaveLength(1);
  });

  it('non-stale-session errors pass through without clearing session', async () => {
    const err = makeError('idle_timeout');
    const sessions = makeMockSessions();
    const events: ClaudeEvent[] = [];

    for await (const e of runWithRecovery(makeMockProc([[err]]), sessions, 'k', BASE)) {
      events.push(e);
    }

    expect(events).toEqual([err]);
    expect(sessions.cleared).toHaveLength(0);
  });

  it('events emitted before stale_session are not dropped', async () => {
    const ready = makeReady(0);
    const stale = makeError('stale_session', 1);
    const done = makeDone(2);
    const events: ClaudeEvent[] = [];

    for await (const e of runWithRecovery(
      makeMockProc([[ready, stale], [done]]),
      makeMockSessions(),
      'k',
      BASE,
    )) {
      events.push(e);
    }

    expect(events[0]).toMatchObject({ type: 'ready' });
    expect(events[1]).toMatchObject({ type: 'done' });
    expect(events).toHaveLength(2);
  });
});
