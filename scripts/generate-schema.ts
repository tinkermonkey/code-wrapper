/**
 * Generate JSON Schema from TypeScript types.
 * This script generates schemas/claude-event.v1.schema.json
 * from src/events/types.ts using ts-json-schema-generator.
 *
 * The generated schema is the single source of truth for:
 * - Wire protocol contract validation
 * - Python type code generation
 * - Contract testing
 */

import { createGenerator } from 'ts-json-schema-generator';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Generate schema for contract types only (via the schema-types entry point)
const generator = createGenerator({
  tsconfig: path.join(rootDir, 'tsconfig.json'),
  path: path.join(rootDir, 'src/schemas/schema-types.ts'),
  skipTypeCheck: false,
  additionalProperties: true,
  functions: 'hide',
});

const schema = generator.createSchema();

// Remove the auto-generated ClaudeEvent definition (with anyOf) to avoid duplication
// The top-level oneOf below is the single source of truth for the discriminated union
const definitions = { ...schema.definitions };
delete definitions.ClaudeEvent;

// Remove the redundant re-export alias
delete definitions.ClaudeEventSchema;

// Remove built-in/global type leaks (e.g., AbortSignal from ProcessOptions)
delete definitions['global.AbortSignal'];

// Make v required in all event types for wire protocol compliance
Object.values(definitions).forEach((def: any) => {
  if (def.required && Array.isArray(def.required) && def.properties?.v) {
    if (!def.required.includes('v')) {
      def.required.push('v');
    }
  }
});

// Enhance schema with metadata
const versionedSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://tinkermonkey.github.io/code-wrapper/claude-event.v1.schema.json',
  title: 'Claude Event Schema v1',
  description:
    'Wire protocol event format for code-wrapper binary NDJSON output. ' +
    'Each line in the NDJSON stream is a JSON object conforming to one of the ClaudeEvent discriminated union types. ' +
    'The top-level discriminator is the "type" field. Wire protocol version is indicated by the "v" field (currently 1). ' +
    'All events MUST include the "v" field set to 1 for this schema version.',
  oneOf: [
    { $ref: '#/definitions/TextEvent' },
    { $ref: '#/definitions/ThinkingEvent' },
    { $ref: '#/definitions/ToolUseEvent' },
    { $ref: '#/definitions/ToolResultEvent' },
    { $ref: '#/definitions/ProgressEvent' },
    { $ref: '#/definitions/ReadyEvent' },
    { $ref: '#/definitions/RetryEvent' },
    { $ref: '#/definitions/DoneEvent' },
    { $ref: '#/definitions/ErrorEvent' },
    { $ref: '#/definitions/RawEvent' },
  ],
  definitions,
};

// Write schema to file
const outputPath = path.join(rootDir, 'schemas', 'claude-event.v1.schema.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(versionedSchema, null, 2) + '\n');

console.log(`✓ Generated schema at ${outputPath}`);
