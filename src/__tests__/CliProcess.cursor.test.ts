import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliProcess } from '../process/CliProcess.js';
import type { ClaudeEvent, ErrorEvent, TextEvent, ReadyEvent, DoneEvent, ToolUseEvent, ToolResultEvent } from '../events/types.js';
import type { ProcessOptions } from '../process/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CURSOR_SRC = join(__dirname, 'fixtures', 'fake-cursor.mjs');

let fakeBinDir: string;
let savedPath: string | undefined;

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'fake-cursor-'));
  const fakeBin = join(fakeBinDir, 'agent');
  writeFileSync(fakeBin, readFileSync(FAKE_CURSOR_SRC, 'utf-8'), 'utf-8');
  chmodSync(fakeBin, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath ?? ''}`;
});

afterAll(() => {
  if (savedPath !== undefined) {
    process.env.PATH = savedPath;
  } else {
    delete process.env.PATH;
  }
  rmSync(fakeBinDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.FAKE_SCENARIO;
  delete process.env.FAKE_EXPECT_SKIP_PERMISSIONS;
  delete process.env.FAKE_EXPECT_AGENT;
});

const BASE: ProcessOptions = { cwd: tmpdir(), prompt: 'test prompt' };

async function collect(extra: Partial<ProcessOptions> = {}): Promise<ClaudeEvent[]> {
  const proc = new CliProcess('cursor');
  const events: ClaudeEvent[] = [];
  for await (const ev of proc.run({ ...BASE, ...extra })) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------- golden path
describe('golden path', () => {
  it('emits progress, ready, text, tool events, and done — no errors', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events.some(e => e.type === 'progress')).toBe(true);
    expect(events.some(e => e.type === 'ready')).toBe(true);
    expect(events.some(e => e.type === 'text')).toBe(true);
    expect(events.some(e => e.type === 'tool_use')).toBe(true);
    expect(events.some(e => e.type === 'tool_result')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('first event is ProgressEvent with elapsed=0', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events[0]).toMatchObject({ type: 'progress', elapsed: 0 });
  });

  it('ReadyEvent carries the session ID and model', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events.find(e => e.type === 'ready')).toMatchObject({
      type: 'ready',
      sessionId: 'cursor-sess-abc123',
      model: 'claude-opus-4',
    });
  });

  it('DoneEvent carries the session ID and duration', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events.find(e => e.type === 'done')).toMatchObject({
      type: 'done',
      sessionId: 'cursor-sess-abc123',
      durationMs: 1500,
    });
  });

  it('TextEvents carry the Cursor response content', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as TextEvent).text)
      .join('');
    expect(text).toContain('Hello from Cursor!');
    expect(text).toContain('Here is the answer');
  });

  it('ToolUseEvent carries tool call information', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    const toolUse = events.find(e => e.type === 'tool_use') as ToolUseEvent | undefined;
    expect(toolUse).toBeDefined();
    expect(toolUse?.id).toBe('tool-1');
    expect(toolUse?.name).toBe('read');
    expect(toolUse?.input).toEqual({ path: '/test/file.txt' });
  });

  it('ToolResultEvent carries tool execution result', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    const toolResult = events.find(e => e.type === 'tool_result') as ToolResultEvent | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult?.toolUseId).toBe('tool-1');
    expect(toolResult?.output).toBe('File contents\n');
    expect(toolResult?.isError).toBe(false);
  });

  it('seq values are strictly increasing', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });
});

// ---------------------------------------------------------------- availability
it('isAvailable returns true when fake cursor agent binary is in PATH', async () => {
  const proc = new CliProcess('cursor');
  expect(await proc.isAvailable()).toBe(true);
});

// ---------------------------------------------------------------- session resume
describe('session resume', () => {
  it('first message does not include --resume', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect({ sessionId: 'cursor-sess-abc123', isFirstMessage: true });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('resumed message includes --resume <chatId>', async () => {
    process.env.FAKE_SCENARIO = 'resume';
    const events = await collect({ sessionId: 'cursor-sess-abc123', isFirstMessage: false });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
    // Check that the resumed session ID is different from the first message
    const readyEvent = events.find(e => e.type === 'ready') as ReadyEvent | undefined;
    expect(readyEvent?.sessionId).toBe('cursor-resumed-sess-xyz789');
  });
});

// ---------------------------------------------------------------- argument building
describe('buildCursorArgs', () => {
  it('passes prompt via -p flag', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    // This is tested by running the process; the prompt must be passed via -p
    const events = await collect({ prompt: 'special test prompt' });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('includes --output-format stream-json', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    // If the stream format is wrong, we'd get parse errors
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('skipPermissions=true includes --force', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    process.env.FAKE_EXPECT_SKIP_PERMISSIONS = 'true';
    const events = await collect({ skipPermissions: true });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('skipPermissions=false omits --force', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    process.env.FAKE_EXPECT_SKIP_PERMISSIONS = 'false';
    const events = await collect({ skipPermissions: false });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('agent flag is passed through', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    process.env.FAKE_EXPECT_AGENT = 'test-agent';
    const events = await collect({ agent: 'test-agent' });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('cwd is passed via --workspace when specified', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    // Use tmpdir() to ensure the directory exists
    const customCwd = tmpdir();
    const events = await collect({ cwd: customCwd });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- stdin handling
it('closes stdin immediately (prompt passed via -p, not stdin)', async () => {
  process.env.FAKE_SCENARIO = 'golden-path';
  const events = await collect();
  // If stdin wasn't closed, the fake-cursor would hang waiting for input
  // Success means we got a done event, proving stdin was properly handled
  expect(events.some(e => e.type === 'done')).toBe(true);
});

// ---------------------------------------------------------------- error handling
describe('error handling', () => {
  it('stale-session stderr → ErrorEvent { stale_session }', async () => {
    process.env.FAKE_SCENARIO = 'stale-session';
    const events = await collect({ sessionId: 'invalid-session-id', isFirstMessage: false });
    expect(events.find(e => e.type === 'error')).toMatchObject({
      type: 'error',
      code: 'stale_session',
    });
  });

  it('rate-limit stderr → ErrorEvent { rate_limit }', async () => {
    process.env.FAKE_SCENARIO = 'rate-limit';
    const events = await collect();
    expect(events.find(e => e.type === 'error')).toMatchObject({
      type: 'error',
      code: 'rate_limit',
    });
  });

  it('nonzero exit → ErrorEvent { nonzero_exit }', async () => {
    process.env.FAKE_SCENARIO = 'nonzero-exit';
    const events = await collect();
    const error = events.find(e => e.type === 'error') as ErrorEvent | undefined;
    expect(error).toBeDefined();
    expect(error?.code).toBe('nonzero_exit');
    expect(error?.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------- timeout handling
describe('timeouts', () => {
  it('idle timeout → ErrorEvent { idle_timeout }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const events = await collect({
      idleTimeout: 1,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 50,
    });
    const error = events.find(e => e.type === 'error') as ErrorEvent | undefined;
    expect(error?.code).toBe('idle_timeout');
  });

  it('max timeout → ErrorEvent { max_timeout }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const events = await collect({
      idleTimeout: 100,
      maxTimeout: 1,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 50,
    });
    const error = events.find(e => e.type === 'error') as ErrorEvent | undefined;
    expect(error?.code).toBe('max_timeout');
  });

  it('SIGKILL escalation when cursor ignores SIGTERM', async () => {
    process.env.FAKE_SCENARIO = 'ignore-sigterm';
    const events = await collect({
      idleTimeout: 1,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 100,
    });
    const error = events.find(e => e.type === 'error') as ErrorEvent | undefined;
    expect(error?.code).toBe('idle_timeout');
  });
});

// ---------------------------------------------------------------- oversized prompt handling
describe('oversized prompt handling', () => {
  it('oversized prompt → ErrorEvent { parse_error } with descriptive detail', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const oversizedPrompt = 'x'.repeat(33 * 1024); // Exceed 32 KB threshold
    const events = await collect({ prompt: oversizedPrompt });
    const error = events.find(e => e.type === 'error') as ErrorEvent | undefined;
    expect(error).toBeDefined();
    expect(error?.code).toBe('parse_error');
    expect(error?.detail).toContain('exceeds');
    expect(error?.detail).toContain('bytes');
  });

  it('prompt at threshold is accepted', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const thresholdPrompt = 'x'.repeat(32 * 1024); // Exactly at 32 KB threshold
    const events = await collect({ prompt: thresholdPrompt });
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- abort handling
describe('abort signal', () => {
  it('abort while running → ErrorEvent { aborted }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const controller = new AbortController();
    // Abort after a short delay to let the process start
    setTimeout(() => controller.abort(), 50);
    const events = await collect({
      signal: controller.signal,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 50,
    });
    const error = events.find(e => e.type === 'error') as ErrorEvent | undefined;
    expect(error?.code).toBe('aborted');
  });

  it('abort before run → ErrorEvent { aborted } without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect({ signal: controller.signal });
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'aborted' });
  });
});
