import { expect } from 'vitest';
import { CliProcess } from '../../process/CliProcess.js';
import type { ClaudeEvent, ReadyEvent, DoneEvent } from '../../events/types.js';
import type { CliBackend, ProcessOptions } from '../../process/types.js';

export async function collectLive(
  backend: CliBackend,
  options: ProcessOptions,
): Promise<ClaudeEvent[]> {
  const proc = new CliProcess(backend);
  const events: ClaudeEvent[] = [];
  for await (const ev of proc.run(options)) {
    events.push(ev);
  }
  return events;
}

export function assertEventStreamStructure(events: ClaudeEvent[]): void {
  expect(events.some(e => e.type === 'ready')).toBe(true);
  expect(events.some(e => e.type === 'text')).toBe(true);
  expect(events.some(e => e.type === 'done')).toBe(true);
  expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  for (let i = 1; i < events.length; i++) {
    expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
  }
  const ready = events.find(e => e.type === 'ready') as ReadyEvent;
  const done = events.find(e => e.type === 'done') as DoneEvent;
  expect(ready.sessionId).toBe(done.sessionId);
  expect(ready.sessionId).toBeTruthy();
}

export async function getLiveCredentials(backend: CliBackend): Promise<{
  claudeAvailable: boolean;
  hasCredentials: boolean;
}> {
  const proc = new CliProcess(backend);
  const claudeAvailable = await proc.isAvailable();

  let hasCredentials: boolean;
  if (backend === 'claude') {
    hasCredentials =
      !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    hasCredentials = claudeAvailable;
  }

  return { claudeAvailable, hasCredentials };
}
