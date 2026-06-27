import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliProcess } from '../process/CliProcess.js';
import type { ClaudeEvent, ErrorEvent, TextEvent, RawEvent } from '../events/types.js';
import type { ProcessOptions } from '../process/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_COPILOT_SRC = join(__dirname, 'fixtures', 'fake-copilot.mjs');

let fakeBinDir: string;
let savedPath: string | undefined;

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'fake-copilot-'));
  const fakeBin = join(fakeBinDir, 'copilot');
  writeFileSync(fakeBin, readFileSync(FAKE_COPILOT_SRC, 'utf-8'), 'utf-8');
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

const BASE: ProcessOptions = { cwd: tmpdir(), prompt: 'test' };

async function collect(extra: Partial<ProcessOptions> = {}): Promise<ClaudeEvent[]> {
  const proc = new CliProcess('copilot');
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

  it('ReadyEvent carries the ACP session ID', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events.find(e => e.type === 'ready')).toMatchObject({
      type: 'ready',
      sessionId: 'copilot-sess-abc123',
    });
  });

  it('DoneEvent carries the ACP session ID', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    expect(events.find(e => e.type === 'done')).toMatchObject({
      type: 'done',
      sessionId: 'copilot-sess-abc123',
    });
  });

  it('TextEvents carry the copilot response content', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect();
    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as TextEvent).text)
      .join('');
    expect(text).toContain('Hello from Copilot!');
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
it('isAvailable returns true when fake copilot binary is in PATH', async () => {
  const proc = new CliProcess('copilot');
  expect(await proc.isAvailable()).toBe(true);
});

// ---------------------------------------------------------------- error paths
it('nonzero exit → ErrorEvent { nonzero_exit, exitCode: 1 }', async () => {
  process.env.FAKE_SCENARIO = 'nonzero-exit';
  const events = await collect();
  expect(events.find(e => e.type === 'error')).toMatchObject({
    type: 'error', code: 'nonzero_exit', exitCode: 1,
  });
});

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

  it('SIGKILL escalation when copilot ignores SIGTERM', async () => {
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
});

// ---------------------------------------------------------------- resume handshake
describe('resume handshake', () => {
  it('skips session/new and uses id=2 for session/prompt when isFirstMessage is false', async () => {
    process.env.FAKE_SCENARIO = 'resume';
    const events = await collect({ sessionId: 'test-sess-uuid', isFirstMessage: false });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  it('sends session/new (produces ReadyEvent) when isFirstMessage is true (default)', async () => {
    process.env.FAKE_SCENARIO = 'golden-path';
    const events = await collect({ sessionId: 'existing-sess', isFirstMessage: true });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
    expect(events.find(e => e.type === 'ready')).toMatchObject({
      type: 'ready',
      sessionId: 'copilot-sess-abc123',
    });
  });
});

// ---------------------------------------------------------------- extended scenarios
it('permission/request notification → RawEvent', async () => {
  process.env.FAKE_SCENARIO = 'permission-request';
  const events = await collect();
  const raw = events
    .filter(e => e.type === 'raw')
    .find(e => (e as RawEvent).rawType === 'permission/request') as RawEvent | undefined;
  expect(raw).toBeDefined();
  expect(raw).toMatchObject({ type: 'raw', rawType: 'permission/request' });
  expect(events.some(e => e.type === 'done')).toBe(true);
  expect(events.filter(e => e.type === 'error')).toHaveLength(0);
});
