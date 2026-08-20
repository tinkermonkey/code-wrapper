import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, existsSync, symlinkSync, mkdirSync, chmodSync } from 'node:fs';
import Ajv from 'ajv';
import { tmpdir } from 'node:os';

const schemaPath = resolve(__dirname, '../../schemas/claude-event.v1.schema.json');
const fakeClaudePath = resolve(__dirname, 'fixtures/fake-claude.mjs');
const fakeCopilotPath = resolve(__dirname, 'fixtures/fake-copilot.mjs');
const execPath = resolve(__dirname, '../../dist/cli/exec.js');

let schema: any;

beforeAll(() => {
  const schemaContent = readFileSync(schemaPath, 'utf-8');
  schema = JSON.parse(schemaContent);
});

function validateEventAgainstSchema(event: any): boolean {
  const ajv = new (Ajv as any)();
  const validate = ajv.compile(schema);
  const valid = validate(event);
  if (!valid) {
    console.error('Schema validation errors:', validate.errors);
  }
  return !!valid;
}

async function spawnBinaryWithFixture(
  fixture: string,
  backend: 'claude' | 'copilot',
  scenario: string,
): Promise<string[]> {
  // Set up a temporary directory with symlinks to the fixture binaries in PATH
  // Do this OUTSIDE the Promise constructor to ensure the directory is ready before spawn
  const fixtureDir = tmpdir() + '/cw-test-' + Math.random().toString(36).slice(2);
  mkdirSync(fixtureDir, { recursive: true });

  // Create symlinks for both fake CLIs
  try {
    const claudeLink = resolve(fixtureDir, 'claude');
    const copilotLink = resolve(fixtureDir, 'copilot');

    // Only create if not already existing (avoid EEXIST)
    if (!existsSync(claudeLink)) {
      symlinkSync(fakeClaudePath, claudeLink);
      chmodSync(claudeLink, 0o755);
    }
    if (!existsSync(copilotLink)) {
      symlinkSync(fakeCopilotPath, copilotLink);
      chmodSync(copilotLink, 0o755);
    }
  } catch (err) {
    throw new Error(`Failed to set up fixture directory: ${err instanceof Error ? err.message : String(err)}`);
  }

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      FAKE_SCENARIO: scenario,
      PATH: fixtureDir + ':' + (process.env.PATH || ''),
    };

    const proc = spawn('node', [execPath, '--backend', backend, '--prompt', 'Test prompt'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr!.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const lines = stdout
        .trim()
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();
          // Only include lines that are valid JSON objects
          return trimmed.length > 0 && trimmed[0] === '{' && trimmed[trimmed.length - 1] === '}';
        });
      if (lines.length > 0) {
        resolve(lines);
      } else {
        reject(new Error(`No JSON output. Exit code: ${code}, stderr: ${stderr.slice(0, 200)}`));
      }
    });

    proc.on('error', reject);
  });
}

describe('code-wrapper exec binary', () => {
  // Skip if exec binary doesn't exist yet
  const skipIfNoExec = existsSync(execPath) ? describe : describe.skip;

  skipIfNoExec('binary schema compliance', () => {
    it('emits valid NDJSON lines conforming to schema', async () => {
      const lines = await spawnBinaryWithFixture(fakeClaudePath, 'claude', 'golden-path');

      expect(Array.isArray(lines)).toBe(true);
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        const event = JSON.parse(line);

        // Check that v field is present and required
        expect(event.v).toBe(1);

        // Check that event conforms to schema
        expect(validateEventAgainstSchema(event)).toBe(true);

        // Check required fields
        expect(event).toHaveProperty('seq');
        expect(event).toHaveProperty('timestamp');
        expect(event).toHaveProperty('type');

        expect(typeof event.seq).toBe('number');
        expect(typeof event.timestamp).toBe('number');
        expect(typeof event.type).toBe('string');
      }
    });

    it('maintains monotonically increasing sequence numbers', async () => {
      const lines = await spawnBinaryWithFixture(fakeClaudePath, 'claude', 'golden-path');
      expect(Array.isArray(lines)).toBe(true);
      const seqs = lines.map(line => JSON.parse(line).seq);

      // Verify seq is strictly increasing
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    });

    it('emits ready event with session ID', async () => {
      const lines = await spawnBinaryWithFixture(fakeClaudePath, 'claude', 'golden-path');
      expect(Array.isArray(lines)).toBe(true);
      const events = lines.map(line => JSON.parse(line));
      const readyEvent = events.find(e => e.type === 'ready');

      expect(readyEvent).toBeDefined();
      expect(readyEvent).toHaveProperty('sessionId');
      expect(typeof readyEvent.sessionId).toBe('string');
    });

    it('works with copilot backend', async () => {
      const lines = await spawnBinaryWithFixture(fakeCopilotPath, 'copilot', 'golden-path');
      expect(Array.isArray(lines)).toBe(true);

      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        const event = JSON.parse(line);
        expect(event.v).toBe(1);
        expect(validateEventAgainstSchema(event)).toBe(true);
      }
    });
  });
});
