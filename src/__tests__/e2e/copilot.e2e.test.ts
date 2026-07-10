import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliProcess } from '../../process/CliProcess.js';
import type { ErrorEvent, ToolUseEvent } from '../../events/types.js';
import { collectLive, assertEventStreamStructure } from '../helpers/live-helpers.js';

// Error codes that indicate an actual auth failure vs transient issues
const AUTH_ERROR_CODES = new Set(['cli_error', 'spawn_error']);

const copilot = new CliProcess('copilot');
const isAvailable = await copilot.isAvailable();

let isAuthenticated = false;

if (isAvailable) {
  const authCheckEvents = await collectLive('copilot', {
    cwd: tmpdir(),
    prompt: 'hi',
    maxTimeout: 60,
  });
  const allErrors = authCheckEvents.filter((e): e is ErrorEvent => e.type === 'error');
  const authErrors = allErrors.filter(e => AUTH_ERROR_CODES.has(e.code));
  const nonAuthErrors = allErrors.filter(e => !AUTH_ERROR_CODES.has(e.code));
  const timedOut = allErrors.some(e => e.code === 'idle_timeout');

  if (timedOut) {
    console.warn(
      '[copilot.e2e] auth probe timed out — could be a Copilot cold start, not necessarily an auth failure',
    );
  }
  if (nonAuthErrors.length > 0) {
    console.warn(
      '[copilot.e2e] non-auth errors during auth probe (suite will still run):',
      nonAuthErrors.map(e => `${e.code}: ${e.detail}`).join('; '),
    );
  }
  if (authErrors.length > 0) {
    console.warn(
      '[copilot.e2e] auth check failed — skipping suite:',
      authErrors.map(e => `${e.code}: ${e.detail}`).join('; '),
    );
  }
  isAuthenticated = authErrors.length === 0;
}

describe.skipIf(!isAvailable || !isAuthenticated)('copilot e2e scenarios', () => {
  describe('golden-path', () => {
    let scratchDir: string;

    beforeEach(async () => {
      scratchDir = await mkdtemp(join(tmpdir(), 'code-wrapper-e2e-'));
    });

    afterEach(async () => {
      await rm(scratchDir, { recursive: true, force: true });
    });

    it('creates a file with the requested content, verified on disk', async () => {
      const sentinel = 'CW-E2E-9F3A1D';
      const events = await collectLive('copilot', {
        cwd: scratchDir,
        prompt: `Create a file named e2e-sentinel.txt in the current working directory. Its exact contents should be the single line: ${sentinel}. Do not create any other files. Then reply with only the word Done.`,
        skipPermissions: true,
        maxTimeout: 90,
      });

      assertEventStreamStructure(events);
      expect(events.some((e): e is ToolUseEvent => e.type === 'tool_use')).toBe(true);

      const written = readFileSync(join(scratchDir, 'e2e-sentinel.txt'), 'utf-8');
      expect(written).toContain(sentinel);
    });
  });
});
