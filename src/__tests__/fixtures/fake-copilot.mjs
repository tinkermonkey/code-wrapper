#!/usr/bin/env node
/**
 * Fake Copilot CLI binary for integration tests.
 * Driven by FAKE_SCENARIO env var; prompt arrives via --prompt flag (not stdin).
 *
 * Scenarios:
 *   golden-path    three text lines then exit 0
 *   stall          one line then stalls; exits cleanly on SIGTERM
 *   ignore-sigterm one line, ignores SIGTERM; only SIGKILL kills it
 *   nonzero-exit   one line, exits with code 1
 */

// CliProcess closes stdin immediately for Copilot (prompt is in --prompt flag).
process.stdin.on('data', () => {});
await new Promise((resolve) => process.stdin.on('end', resolve));

const scenario = process.env.FAKE_SCENARIO ?? 'golden-path';

switch (scenario) {
  case 'golden-path': {
    process.stdout.write('Hello from Copilot!\n');
    process.stdout.write('Here is the answer.\n');
    process.stdout.write('\n```typescript\nconst x = 42;\n```\n');
    break;
  }

  case 'stall': {
    process.stdout.write('Starting...\n');
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 30_000); // keep alive until signal
    break;
  }

  case 'ignore-sigterm': {
    process.stdout.write('Starting...\n');
    process.on('SIGTERM', () => { /* intentionally ignored */ });
    setInterval(() => {}, 30_000); // only SIGKILL stops this
    break;
  }

  case 'nonzero-exit': {
    process.stdout.write('Something went wrong\n');
    process.exitCode = 1;
    break;
  }

  default: {
    process.stderr.write(`Unknown FAKE_SCENARIO: ${scenario}\n`);
    process.exitCode = 1;
  }
}
