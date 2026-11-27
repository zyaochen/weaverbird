import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEventLine } from '../../../packages/core/src/audit-pipe/parser.js';
import { createTailer } from '../../../packages/core/src/audit-pipe/tailer.js';

describe('T2 parser', () => {
  it('parses tool_use line into ToolUseEvent', () => {
    const event = parseEventLine('{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"},"schemaVersion":1}');
    expect(event?.type).toBe('tool_use');
    expect(event?.name).toBe('Read');
  });

  it('returns null for non-tool_use events', () => {
    expect(parseEventLine('{"type":"text","delta":"hi","schemaVersion":1}')).toBeNull();
    expect(parseEventLine('{"type":"done","schemaVersion":1}')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseEventLine('not json')).toBeNull();
    expect(parseEventLine('')).toBeNull();
  });

  it('returns null when id or name is missing', () => {
    expect(parseEventLine('{"type":"tool_use","name":"Read","input":{}}')).toBeNull();
    expect(parseEventLine('{"type":"tool_use","id":"t1","input":{}}')).toBeNull();
  });
});

describe('T2 tailer', () => {
  it('reads only appended lines on subsequent ticks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-tailer-'));
    const eventsPath = join(dir, 'events.ndjson');
    try {
      writeFileSync(eventsPath, '{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"},"schemaVersion":1}\n{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"},"schemaVersion":1}\n');
      const tailer = createTailer({ eventsPath, offsetPath: join(dir, 'audit-offset') });
      const first: string[] = [];
      for await (const line of tailer.tick()) first.push(line);
      expect(first).toHaveLength(2);

      appendFileSync(eventsPath, '{"type":"tool_use","id":"t3","name":"Write","input":{"file_path":"b.ts"},"schemaVersion":1}\n');
      const second: string[] = [];
      for await (const line of tailer.tick()) second.push(line);
      expect(second).toHaveLength(1);
      expect(JSON.parse(second[0]!).id).toBe('t3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists offset across tailer recreation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-tailer-'));
    const eventsPath = join(dir, 'events.ndjson');
    const offsetPath = join(dir, 'audit-offset');
    try {
      writeFileSync(eventsPath, '{"type":"tool_use","id":"t1","name":"Read","input":{},"schemaVersion":1}\n');
      const firstTailer = createTailer({ eventsPath, offsetPath });
      for await (const _line of firstTailer.tick()) {
        // drain
      }
      appendFileSync(eventsPath, '{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"},"schemaVersion":1}\n');
      const secondTailer = createTailer({ eventsPath, offsetPath });
      const lines: string[] = [];
      for await (const line of secondTailer.tick()) lines.push(line);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).id).toBe('t2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
