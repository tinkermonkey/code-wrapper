import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { CliProcess } from '../../process/CliProcess.js';
import type { ReadyEvent, ErrorEvent, TextEvent, ClaudeEvent } from '../../events/types.js';
import {
  collectLive,
  assertEventStreamStructure,
} from '../helpers/live-helpers.js';

const cwd = tmpdir();

const copilot = new CliProcess('copilot');
const isAvailable = await copilot.isAvailable();

let isAuthenticated = false;
if (isAvailable) {
  const authCheckEvents = await collectLive('copilot', {
    cwd,
    prompt: 'hi',
    maxTimeout: 30,
  });
  isAuthenticated = !authCheckEvents.some(e => e.type === 'error');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe.skipIf(!isAvailable || !isAuthenticated)('copilot live tests', () => {
  it('golden path', async () => {
    const events = await collectLive('copilot', {
      cwd,
      prompt: 'respond with exactly the word hello',
      maxTimeout: 60,
    });
    assertEventStreamStructure(events);
  });

  it('ReadyEvent session UUID', async () => {
    const events = await collectLive('copilot', {
      cwd,
      prompt: 'respond with exactly the word hello',
      maxTimeout: 60,
    });
    const ready = events.find(e => e.type === 'ready') as ReadyEvent | undefined;
    expect(ready).toBeDefined();
    expect(ready!.sessionId).toMatch(UUID_RE);
  });

  it('text content emitted', async () => {
    const events = await collectLive('copilot', {
      cwd,
      prompt: 'respond with exactly the word hello',
      maxTimeout: 60,
    });
    const textEvents = events.filter(e => e.type === 'text') as TextEvent[];
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents.some(e => e.text.length > 0)).toBe(true);
  });

  it('session resume', async () => {
    const firstEvents = await collectLive('copilot', {
      cwd,
      prompt: 'respond with exactly the word hello',
      maxTimeout: 60,
    });
    expect(firstEvents.filter(e => e.type === 'error')).toHaveLength(0);
    const firstReady = firstEvents.find(e => e.type === 'ready') as ReadyEvent;
    const { sessionId } = firstReady;

    const secondEvents = await collectLive('copilot', {
      cwd,
      prompt: 'respond with exactly the word world',
      sessionId,
      isFirstMessage: false,
      maxTimeout: 60,
    });
    expect(secondEvents.filter(e => e.type === 'error')).toHaveLength(0);
    const secondReady = secondEvents.find(e => e.type === 'ready') as ReadyEvent;
    expect(secondReady.sessionId).toBe(sessionId);
  });

  it('AbortSignal mid-run', async () => {
    const controller = new AbortController();
    const proc = new CliProcess('copilot');
    const events: ClaudeEvent[] = [];
    for await (const ev of proc.run({
      cwd,
      prompt: 'write a comprehensive multi-section essay about the entire history of computing, covering at least ten major eras in detail',
      signal: controller.signal,
      maxTimeout: 60,
    })) {
      events.push(ev);
      if (ev.type === 'ready') {
        controller.abort();
      }
    }
    const last = events[events.length - 1] as ErrorEvent;
    expect(last.type).toBe('error');
    expect(last.code).toBe('aborted');
  });
});
