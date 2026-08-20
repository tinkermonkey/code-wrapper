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

// Generate schema for all exported types
const generator = createGenerator({
  tsconfig: path.join(rootDir, 'tsconfig.json'),
  skipTypeCheck: false,
  additionalProperties: true,
});

const schema = generator.createSchema();

// Enhance schema with metadata
const versionedSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://tinkermonkey.github.io/code-wrapper/claude-event.v1.schema.json',
  title: 'Claude Event Schema v1',
  description:
    'Wire protocol event format for code-wrapper binary NDJSON output. ' +
    'Each line in the NDJSON stream is a JSON object conforming to one of the ClaudeEvent discriminated union types. ' +
    'The top-level discriminator is the "type" field. Wire protocol version is indicated by the "v" field (currently 1).',
  version: '1',
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
  definitions: schema.definitions || {},
};

// Write schema to file
const outputPath = path.join(rootDir, 'schemas', 'claude-event.v1.schema.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(versionedSchema, null, 2) + '\n');

console.log(`✓ Generated schema at ${outputPath}`);
