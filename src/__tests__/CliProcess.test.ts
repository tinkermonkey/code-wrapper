import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliProcess } from '../process/CliProcess.js';
import type { ClaudeEvent, ErrorEvent, TextEvent, RawEvent } from '../events/types.js';
import type { ProcessOptions } from '../process/types.js';

// Resolve fake binary fixture paths relative to this test file.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_SRC = join(__dirname, 'fixtures', 'fake-claude.mjs');
const FAKE_COPILOT_SRC = join(__dirname, 'fixtures', 'fake-copilot.mjs');

let fakeBinDir: string;
let savedPath: string | undefined;

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const fakeBin = join(fakeBinDir, 'claude');
  writeFileSync(fakeBin, readFileSync(FAKE_CLAUDE_SRC, 'utf-8'), 'utf-8');
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

// Reset FAKE_SCENARIO after every test so tests that don't set it explicitly
// don't silently inherit a stale value from the previous test.
afterEach(() => {
  delete process.env.FAKE_SCENARIO;
});

// Collect all events from a single run.
async function collect(opts: ProcessOptions): Promise<ClaudeEvent[]> {
  const proc = new CliProcess();
  const events: ClaudeEvent[] = [];
  for await (const ev of proc.run(opts)) {
    events.push(ev);
  }
  return events;
}

const BASE: ProcessOptions = { cwd: tmpdir(), prompt: 'test' };

// ---------------------------------------------------------------- golden path
describe('golden path', () => {
  it('emits progress, ready, text, tool_use, tool_result, done — no errors', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect(BASE);
    const types = events.map(e => e.type);
    expect(types).toContain('progress');
    expect(types).toContain('ready');
    expect(types).toContain('text');
    expect(types).toContain('tool_use');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('first event is ProgressEvent with elapsed=0', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect(BASE);
    expect(events[0]).toMatchObject({ type: 'progress', elapsed: 0 });
  });

  it('ReadyEvent carries sessionId, model, and tool names', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect(BASE);
    expect(events.find(e => e.type === 'ready')).toMatchObject({
      type: 'ready',
      sessionId: 'sess-abc123',
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Write'],
    });
  });

  it('DoneEvent carries sessionId and full usage including cache fields', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect(BASE);
    expect(events.find(e => e.type === 'done')).toMatchObject({
      type: 'done',
      sessionId: 'sess-abc123',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
    });
  });

  it('seq values are strictly increasing', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect(BASE);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });
});

// ---------------------------------------------------------------- other scenarios
it('ThinkingEvent emitted from assistant thinking blocks', async () => {
  process.env.FAKE_SCENARIO = 'thinking';
  const events = await collect(BASE);
  expect(events.find(e => e.type === 'thinking')).toMatchObject({
    type: 'thinking',
    thinking: expect.stringContaining('think'),
  });
});

it('RetryEvent emitted on api_retry', async () => {
  process.env.FAKE_SCENARIO = 'api-retry';
  const events = await collect(BASE);
  expect(events.find(e => e.type === 'retry')).toMatchObject({
    type: 'retry',
    attempt: 1,
    delayMs: 500,
    error: 'Connection reset by peer',
  });
});

// ---------------------------------------------------------------- error paths
it('nonzero exit → ErrorEvent { nonzero_exit, exitCode: 1 }', async () => {
  process.env.FAKE_SCENARIO = 'nonzero-exit';
  const events = await collect(BASE);
  const err = events.find(e => e.type === 'error') as ErrorEvent | undefined;
  expect(err).toMatchObject({ type: 'error', code: 'nonzero_exit', exitCode: 1 });
});

it('stale-session stderr → ErrorEvent { stale_session }', async () => {
  process.env.FAKE_SCENARIO = 'stale-session';
  const events = await collect(BASE);
  expect(events.find(e => e.type === 'error')).toMatchObject({ type: 'error', code: 'stale_session' });
});

it('spawn failure (binary not in PATH) → ErrorEvent { spawn_error }', async () => {
  const savedForTest = process.env.PATH;
  process.env.PATH = '/no-such-directory';
  try {
    const events = await collect(BASE);
    expect(events.find(e => e.type === 'error')).toMatchObject({ type: 'error', code: 'spawn_error' });
  } finally {
    if (savedForTest !== undefined) {
      process.env.PATH = savedForTest;
    } else {
      delete process.env.PATH;
    }
  }
});

it('isAvailable returns true when fake binary is in PATH', async () => {
  const proc = new CliProcess();
  expect(await proc.isAvailable()).toBe(true);
});

// ---------------------------------------------------------------- AbortSignal
describe('AbortSignal', () => {
  it('pre-flight abort → single ErrorEvent { aborted } without spawning', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const controller = new AbortController();
    controller.abort();
    const events = await collect({ ...BASE, signal: controller.signal });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'aborted' });
  });

  it('mid-run abort → ErrorEvent { aborted } after some events', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const controller = new AbortController();
    const proc = new CliProcess();
    const events: ClaudeEvent[] = [];
    for await (const ev of proc.run({
      ...BASE,
      signal: controller.signal,
      _watchdogIntervalMs: 60_000, // prevent watchdog from firing
      _sigkillDelayMs: 300,        // fast SIGKILL escalation if SIGTERM ignored
    })) {
      events.push(ev);
      if (ev.type === 'ready') controller.abort();
    }
    const err = events.find(e => e.type === 'error') as ErrorEvent | undefined;
    expect(err).toMatchObject({ type: 'error', code: 'aborted' });
  });
});

// ---------------------------------------------------------------- timeouts
describe('timeouts', () => {
  it('idle timeout → ErrorEvent { idle_timeout }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const events = await collect({
      ...BASE,
      idleTimeout: 1,           // 1 second of silence → SIGTERM
      _watchdogIntervalMs: 100, // poll every 100 ms so test completes ~1.1 s
      _sigkillDelayMs: 300,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'idle_timeout' });
  });

  it('max timeout → ErrorEvent { max_timeout }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const events = await collect({
      ...BASE,
      maxTimeout: 1,            // 1 second wall-clock ceiling
      idleTimeout: 300,         // keep idle timeout from firing first
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 300,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'max_timeout' });
  });

  it('SIGKILL escalation when process ignores SIGTERM', async () => {
    process.env.FAKE_SCENARIO = 'ignore-sigterm';
    const events = await collect({
      ...BASE,
      idleTimeout: 1,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 300,     // 300 ms after SIGTERM → SIGKILL
    });
    // idle_timeout is still the reported code even when SIGKILL was needed
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'idle_timeout' });
  });
});

// ---------------------------------------------------------------- new scenarios
it('session-resume: ReadyEvent carries the session ID passed via --resume', async () => {
  process.env.FAKE_SCENARIO = 'session-resume';
  const events = await collect({ ...BASE, sessionId: 'sess-to-resume', isFirstMessage: false });
  expect(events.find(e => e.type === 'ready')).toMatchObject({
    type: 'ready',
    sessionId: 'sess-to-resume',
  });
  expect(events.find(e => e.type === 'done')).toMatchObject({ type: 'done', sessionId: 'sess-to-resume' });
  expect(events.filter(e => e.type === 'error')).toHaveLength(0);
});

it('rate-limit: rate_limit_event on stdout surfaces as ErrorEvent { rate_limit }', async () => {
  process.env.FAKE_SCENARIO = 'rate-limit';
  const events = await collect(BASE);
  expect(events.find(e => e.type === 'error' && (e as ErrorEvent).code === 'rate_limit')).toMatchObject({
    type: 'error',
    code: 'rate_limit',
  });
});

it('permission-request: server_tool_use block inside assistant event becomes RawEvent', async () => {
  process.env.FAKE_SCENARIO = 'permission-request';
  const events = await collect(BASE);
  const raw = events.find(
    e => e.type === 'raw' && (e as RawEvent).rawSubtype === 'server_tool_use',
  ) as RawEvent | undefined;
  expect(raw).toBeDefined();
  expect(raw).toMatchObject({ type: 'raw', rawType: 'assistant', rawSubtype: 'server_tool_use' });
  expect(events.some(e => e.type === 'done')).toBe(true);
  expect(events.filter(e => e.type === 'error')).toHaveLength(0);
});

it('multi-block: single assistant message with text+tool_use emits both TextEvent and ToolUseEvent', async () => {
  process.env.FAKE_SCENARIO = 'multi-block';
  const events = await collect(BASE);
  expect(events.some(e => e.type === 'text')).toBe(true);
  expect(events.some(e => e.type === 'tool_use')).toBe(true);
  expect(events.filter(e => e.type === 'error')).toHaveLength(0);
});

it('unknown FAKE_SCENARIO writes stderr and exits with code 1', async () => {
  process.env.FAKE_SCENARIO = 'no-such-scenario-xyz';
  const events = await collect(BASE);
  expect(events.find(e => e.type === 'error')).toMatchObject({
    type: 'error',
    code: 'nonzero_exit',
    exitCode: 1,
  });
});

// ---------------------------------------------------------------- copilot backend
describe('copilot backend', () => {
  let copilotBinDir: string;
  let pathBeforeCopilot: string | undefined;

  beforeAll(() => {
    copilotBinDir = mkdtempSync(join(tmpdir(), 'fake-copilot-'));
    const fakeBin = join(copilotBinDir, 'copilot');
    writeFileSync(fakeBin, readFileSync(FAKE_COPILOT_SRC, 'utf-8'), 'utf-8');
    chmodSync(fakeBin, 0o755);
    pathBeforeCopilot = process.env.PATH;
    process.env.PATH = `${copilotBinDir}:${pathBeforeCopilot ?? ''}`;
  });

  afterAll(() => {
    if (pathBeforeCopilot !== undefined) {
      process.env.PATH = pathBeforeCopilot;
    } else {
      delete process.env.PATH;
    }
    rmSync(copilotBinDir, { recursive: true, force: true });
  });

  async function collectCopilot(extra: Partial<ProcessOptions> = {}): Promise<ClaudeEvent[]> {
    const proc = new CliProcess('copilot');
    const events: ClaudeEvent[] = [];
    for await (const ev of proc.run({ ...BASE, ...extra })) {
      events.push(ev);
    }
    return events;
  }

  it('isAvailable returns true when fake copilot binary is in PATH', async () => {
    const proc = new CliProcess('copilot');
    expect(await proc.isAvailable()).toBe(true);
  });

  it('golden path emits progress, ready, text, and done events — no errors', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collectCopilot();
    expect(events.some(e => e.type === 'progress')).toBe(true);
    expect(events.some(e => e.type === 'ready')).toBe(true);
    expect(events.some(e => e.type === 'text')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('first event is ProgressEvent with elapsed=0', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collectCopilot();
    expect(events[0]).toMatchObject({ type: 'progress', elapsed: 0 });
  });

  it('ReadyEvent carries the ACP session ID', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collectCopilot();
    expect(events.find(e => e.type === 'ready')).toMatchObject({
      type: 'ready',
      sessionId: 'copilot-sess-abc123',
    });
  });

  it('DoneEvent carries the ACP session ID', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collectCopilot();
    expect(events.find(e => e.type === 'done')).toMatchObject({
      type: 'done',
      sessionId: 'copilot-sess-abc123',
    });
  });

  it('text events carry the copilot response content', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collectCopilot();
    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as TextEvent).text)
      .join('');
    expect(text).toContain('Hello from Copilot!');
  });

  it('seq values are strictly increasing', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collectCopilot();
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });

  it('nonzero exit → ErrorEvent { nonzero_exit, exitCode: 1 }', async () => {
    process.env.FAKE_SCENARIO = 'nonzero-exit';
    const events = await collectCopilot();
    expect(events.find(e => e.type === 'error')).toMatchObject({
      type: 'error', code: 'nonzero_exit', exitCode: 1,
    });
  });

  it('idle timeout → ErrorEvent { idle_timeout }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const events = await collectCopilot({
      idleTimeout: 1,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 300,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'idle_timeout' });
  });

  it('max timeout → ErrorEvent { max_timeout }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const events = await collectCopilot({
      maxTimeout: 1,
      idleTimeout: 300,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 300,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'max_timeout' });
  });

  it('SIGKILL escalation when copilot ignores SIGTERM', async () => {
    process.env.FAKE_SCENARIO = 'ignore-sigterm';
    const events = await collectCopilot({
      idleTimeout: 1,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 300,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'idle_timeout' });
  });

  it('AbortSignal mid-run → ErrorEvent { aborted }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const controller = new AbortController();
    const proc = new CliProcess('copilot');
    const events: ClaudeEvent[] = [];
    for await (const ev of proc.run({
      ...BASE,
      signal: controller.signal,
      _watchdogIntervalMs: 60_000,
      _sigkillDelayMs: 300,
    })) {
      events.push(ev);
      if (ev.type === 'ready') controller.abort();
    }
    expect(events.find(e => e.type === 'error')).toMatchObject({ type: 'error', code: 'aborted' });
  });

  it('permission/request notification → RawEvent', async () => {
    process.env.FAKE_SCENARIO = 'permission-request';
    const events = await collectCopilot();
    const raw = events
      .filter(e => e.type === 'raw')
      .find(e => (e as RawEvent).rawType === 'permission/request') as RawEvent | undefined;
    expect(raw).toBeDefined();
    expect(raw).toMatchObject({ type: 'raw', rawType: 'permission/request' });
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });
});
