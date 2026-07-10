/**
 * Full end-to-end acceptance scenarios against the real `claude` CLI — not fixtures.
 * Run via `npm run test:e2e`; never part of `npm test`, `npm run test:live`, or CI.
 *
 * Measured cost (real DoneEvent.usage at current Claude Sonnet 5 pricing):
 * ~$0.086/run for the full E2E suite (this file's three Claude API turns), compared
 * against the live suite's reference cost of ~$0.06/run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DoneEvent, ErrorEvent, ReadyEvent, ToolUseEvent } from '../../events/types.js';
import {
  collectLive,
  collectResultText,
  assertEventStreamStructure,
  getLiveCredentials,
} from '../helpers/live-helpers.js';

const { claudeAvailable, hasCredentials } = await getLiveCredentials('claude');

describe.skipIf(!claudeAvailable || !hasCredentials)('claude e2e scenarios', () => {
  describe('golden-path and multi-turn resume', () => {
    let scratchDir: string;

    beforeEach(async () => {
      scratchDir = await mkdtemp(join(tmpdir(), 'code-wrapper-e2e-'));
    });

    afterEach(async () => {
      await rm(scratchDir, { recursive: true, force: true });
    });

    it('creates a file with the requested content, verified on disk', async () => {
      const sentinel = 'CW-E2E-9F3A1D';
      const events = await collectLive('claude', {
        cwd: scratchDir,
        prompt: `Create a file named e2e-sentinel.txt in the current working directory. Its exact contents should be the single line: ${sentinel}. Do not create any other files. Then reply with only the word Done.`,
        skipPermissions: true,
        maxTimeout: 90,
        idleTimeout: 30,
      });

      assertEventStreamStructure(events);
      expect(events.some((e): e is ToolUseEvent => e.type === 'tool_use')).toBe(true);

      const written = readFileSync(join(scratchDir, 'e2e-sentinel.txt'), 'utf-8');
      expect(written).toContain(sentinel);
    });

    it('recalls a value across a resumed session', async () => {
      const codeword = 'RIVENSTONE-42';

      const firstEvents = await collectLive('claude', {
        cwd: scratchDir,
        prompt: `Remember this codeword for later: ${codeword}. Reply with only the word OK.`,
        maxTimeout: 60,
      });
      assertEventStreamStructure(firstEvents);
      const firstDone = firstEvents.find(e => e.type === 'done') as DoneEvent;
      const sessionId = firstDone.sessionId;

      const secondEvents = await collectLive('claude', {
        cwd: scratchDir,
        prompt: 'What codeword did I ask you to remember earlier? Reply with only that codeword.',
        sessionId,
        isFirstMessage: false,
        maxTimeout: 60,
      });
      assertEventStreamStructure(secondEvents);

      const secondReady = secondEvents.find(e => e.type === 'ready') as ReadyEvent;
      const secondDone = secondEvents.find(e => e.type === 'done') as DoneEvent;
      expect(secondReady.sessionId).toBe(sessionId);
      expect(secondDone.sessionId).toBe(sessionId);

      const recalled = collectResultText(secondEvents);
      expect(recalled.toLowerCase()).toContain(codeword.toLowerCase());
    });
  });

  it('reports a native spawn failure for a nonexistent working directory', async () => {
    const bogusCwd = join(tmpdir(), `code-wrapper-e2e-nonexistent-cwd-${randomBytes(8).toString('hex')}`);

    const events = await collectLive('claude', {
      cwd: bogusCwd,
      prompt: 'respond with exactly the word hello',
      maxTimeout: 5,
    });

    expect(events.some(e => e.type === 'done')).toBe(false);
    const error = events.find(e => e.type === 'error') as ErrorEvent | undefined;
    expect(error).toBeDefined();
    expect(error!.code).toBe('spawn_error');
  }, 10_000);
});
