import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { CliProcess } from '../../process/CliProcess.js';
import type { ReadyEvent, DoneEvent, ErrorEvent, ClaudeEvent } from '../../events/types.js';
import {
  collectLive,
  assertEventStreamStructure,
  getLiveCredentials,
} from '../helpers/live-helpers.js';

const { claudeAvailable, hasCredentials } = await getLiveCredentials('claude');
// Captured at module load before any beforeEach transforms process.env
const initialApiKey = process.env.ANTHROPIC_API_KEY;
const cwd = tmpdir();

describe.skipIf(!claudeAvailable || !hasCredentials)('claude live tests', () => {
  let savedApiKey: string | undefined;

  beforeEach(() => {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  afterEach(() => {
    if (savedApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
      savedApiKey = undefined;
    }
  });

  it('golden path', async () => {
    const events = await collectLive('claude', {
      cwd,
      prompt: 'respond with exactly the word hello',
      maxTimeout: 60,
    });
    assertEventStreamStructure(events);
    expect(events.filter(e => e.type === 'ready')).toHaveLength(1);
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    const done = events.find(e => e.type === 'done') as DoneEvent;
    expect(done.usage?.inputTokens).toBeGreaterThan(0);
    expect(done.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('ReadyEvent fields', async () => {
    const events = await collectLive('claude', {
      cwd,
      prompt: 'respond with exactly the word hello',
      maxTimeout: 60,
    });
    const ready = events.find(e => e.type === 'ready') as ReadyEvent | undefined;
    expect(ready).toBeDefined();
    expect(ready!.sessionId.length).toBeGreaterThan(0);
    expect(ready!.model).toBeTruthy();
  });

  it('session resume', async () => {
    const firstEvents = await collectLive('claude', {
      cwd,
      prompt: 'respond with exactly the word hello',
      maxTimeout: 60,
    });
    expect(firstEvents.filter(e => e.type === 'error')).toHaveLength(0);
    const firstDone = firstEvents.find(e => e.type === 'done') as DoneEvent;
    const sessionId = firstDone.sessionId;

    const secondEvents = await collectLive('claude', {
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
    const proc = new CliProcess('claude');
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

  it.skipIf(!process.env.CLAUDE_CODE_OAUTH_TOKEN)('OAuth auth path', async () => {
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const events = await collectLive('claude', {
        cwd,
        prompt: 'respond with exactly the word hello',
        maxTimeout: 60,
      });
      expect(events.filter(e => e.type === 'error')).toHaveLength(0);
    } finally {
      if (savedApiKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
    }
  });

  it.skipIf(!initialApiKey)('API key auth path', async () => {
    const savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = initialApiKey!;
    try {
      const events = await collectLive('claude', {
        cwd,
        prompt: 'respond with exactly the word hello',
        maxTimeout: 60,
      });
      expect(events.filter(e => e.type === 'error')).toHaveLength(0);
    } finally {
      if (savedOauthToken !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
      }
    }
  });
});
