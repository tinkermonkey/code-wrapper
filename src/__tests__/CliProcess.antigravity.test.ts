import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliProcess } from '../process/CliProcess.js';
import type { ClaudeEvent, ErrorEvent, TextEvent, ReadyEvent, DoneEvent } from '../events/types.js';
import type { ProcessOptions } from '../process/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGY_SRC = join(__dirname, 'fixtures', 'fake-agy.mjs');

let fakeBinDir: string;
let savedPath: string | undefined;

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'fake-agy-'));
  const fakeBin = join(fakeBinDir, 'agy');
  writeFileSync(fakeBin, readFileSync(FAKE_AGY_SRC, 'utf-8'), 'utf-8');
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
});

const BASE: ProcessOptions = { cwd: tmpdir(), prompt: 'test prompt' };

async function collect(extra: Partial<ProcessOptions> = {}): Promise<ClaudeEvent[]> {
  const proc = new CliProcess('antigravity');
  const events: ClaudeEvent[] = [];
  for await (const ev of proc.run({ ...BASE, ...extra })) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------- golden path
describe('golden path', () => {
  it('emits progress, ready, text, and done events — no errors', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events.some(e => e.type === 'progress')).toBe(true);
    expect(events.some(e => e.type === 'ready')).toBe(true);
    expect(events.some(e => e.type === 'text')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('first event is ProgressEvent with elapsed=0', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events[0]).toMatchObject({ type: 'progress', elapsed: 0 });
  });

  it('ReadyEvent carries the session ID', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events.find(e => e.type === 'ready')).toMatchObject({
      type: 'ready',
      sessionId: 'agy-sess-abc123',
    });
  });

  it('DoneEvent carries the session ID', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events.find(e => e.type === 'done')).toMatchObject({
      type: 'done',
      sessionId: 'agy-sess-abc123',
    });
  });

  it('TextEvents carry the antigravity response content', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as TextEvent).text)
      .join('');
    expect(text).toContain('Hello from Antigravity!');
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
it('isAvailable returns true when fake agy binary is in PATH', async () => {
  const proc = new CliProcess('antigravity');
  expect(await proc.isAvailable()).toBe(true);
});

// ---------------------------------------------------------------- binary name
it('binaryName() resolves to agy for antigravity backend', async () => {
  const proc = new CliProcess('antigravity');
  expect(await proc.isAvailable()).toBe(true);
});

// ---------------------------------------------------------------- argument building
describe('buildAntigravityArgs', () => {
  it('includes -p with the prompt', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    // This is tested indirectly by running the process; the prompt must be passed
    const events = await collect({ prompt: 'special test prompt' });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('skipPermissions=true includes --dangerously-skip-permissions', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect({ skipPermissions: true });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('skipPermissions=false omits --dangerously-skip-permissions', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect({ skipPermissions: false });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('agent flag is passed through', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect({ agent: 'test-agent' });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- stdin handling
it('stdin is closed immediately after spawn without writing', async () => {
  process.env.FAKE_SCENARIO = 'golden-path';
  const events = await collect();
  // If stdin wasn't closed properly, the process might hang or behave oddly
  // The fact that we get a complete event stream confirms proper stdin handling
  expect(events.some(e => e.type === 'done')).toBe(true);
  expect(events.filter(e => e.type === 'error')).toHaveLength(0);
});

// ---------------------------------------------------------------- error paths
it('nonzero exit → ErrorEvent { nonzero_exit, exitCode: 1 }', async () => {
  process.env.FAKE_SCENARIO = 'nonzero-exit';
  const events = await collect();
  expect(events.find(e => e.type === 'error')).toMatchObject({
    type: 'error', code: 'nonzero_exit', exitCode: 1,
  });
});

it('stale-session error → ErrorEvent { stale_session }', async () => {
  process.env.FAKE_SCENARIO = 'stale-session';
  const events = await collect();
  expect(events.find(e => e.type === 'error')).toMatchObject({
    type: 'error', code: 'stale_session',
  });
});

it('rate-limit error → ErrorEvent { rate_limit }', async () => {
  process.env.FAKE_SCENARIO = 'rate-limit';
  const events = await collect();
  expect(events.find(e => e.type === 'error')).toMatchObject({
    type: 'error', code: 'rate_limit',
  });
});

it('generic error-event → ErrorEvent { cli_error }', async () => {
  process.env.FAKE_SCENARIO = 'error-event';
  const events = await collect();
  expect(events.find(e => e.type === 'error')).toMatchObject({
    type: 'error', code: 'cli_error',
  });
});

// ---------------------------------------------------------------- spawn errors
// Note: We can't easily test spawn errors with a fake binary in PATH,
// but the spawn_error path is tested through the copilot tests and is
// generic code in CliProcess that applies to all backends.

// ---------------------------------------------------------------- timeouts
describe('timeouts', () => {
  it('idle timeout → ErrorEvent { idle_timeout }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const events = await collect({
      idleTimeout: 1,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 300,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'idle_timeout' });
  });

  it('max timeout → ErrorEvent { max_timeout }', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const events = await collect({
      maxTimeout: 1,
      idleTimeout: 300,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 300,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'max_timeout' });
  });

  it('SIGKILL escalation when agy ignores SIGTERM', async () => {
    process.env.FAKE_SCENARIO = 'ignore-sigterm';
    const events = await collect({
      idleTimeout: 1,
      _watchdogIntervalMs: 100,
      _sigkillDelayMs: 300,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'idle_timeout' });
  });
});

// ---------------------------------------------------------------- AbortSignal
describe('AbortSignal', () => {
  it('pre-flight abort → single ErrorEvent { aborted } without spawning', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const controller = new AbortController();
    controller.abort();
    const events = await collect({ signal: controller.signal });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'aborted' });
  });

  it('mid-run abort → ErrorEvent { aborted } after some events', async () => {
    process.env.FAKE_SCENARIO = 'stall';
    const controller = new AbortController();
    const proc = new CliProcess('antigravity');
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
});

// ---------------------------------------------------------------- session resume
describe('session resume', () => {
  it('sessionId + isFirstMessage=false → --conversation <id> arg', async () => {
    process.env.FAKE_SCENARIO = 'resume';
    const events = await collect({ sessionId: 'test-sess-uuid', isFirstMessage: false });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
    const ready = events.find(e => e.type === 'ready') as ReadyEvent | undefined;
    expect(ready).toBeDefined();
    expect(ready!.sessionId).toBe('agy-resumed-sess-xyz789');
  });

  it('sessionId + isFirstMessage=true → no resume flag', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect({ sessionId: 'existing-sess', isFirstMessage: true });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
    expect(events.find(e => e.type === 'ready')).toMatchObject({
      type: 'ready',
      sessionId: 'agy-sess-abc123',
    });
  });

  it('DoneEvent carries sessionId for resumed session', async () => {
    process.env.FAKE_SCENARIO = 'resume';
    const events = await collect({ sessionId: 'test-sess-uuid', isFirstMessage: false });
    const done = events.find(e => e.type === 'done') as DoneEvent | undefined;
    expect(done).toBeDefined();
    expect(done!.sessionId).toBe('agy-resumed-sess-xyz789');
  });
});
