import { describe, it, expect } from 'vitest';
import { collectResultText } from './live-helpers.js';
import type { ClaudeEvent } from '../../events/types.js';

describe('collectResultText', () => {
  it('joins text from TextEvents and ignores other event types', () => {
    const events = [
      { type: 'ready', seq: 0, sessionId: 's1' },
      { type: 'text', seq: 1, text: 'Hello, ' },
      { type: 'tool_use', seq: 2, name: 'Read' },
      { type: 'text', seq: 3, text: 'world!' },
      { type: 'done', seq: 4, sessionId: 's1' },
    ] as unknown as ClaudeEvent[];

    expect(collectResultText(events)).toBe('Hello, world!');
  });

  it('returns an empty string when there are no TextEvents', () => {
    const events = [
      { type: 'ready', seq: 0, sessionId: 's1' },
      { type: 'done', seq: 1, sessionId: 's1' },
    ] as unknown as ClaudeEvent[];

    expect(collectResultText(events)).toBe('');
  });
});
