import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractLatestContinuationToken,
  checkSchemaVersion,
  parseEventLine,
  readEventsSync,
  EVENTS_SUPPORTED_SCHEMA_VERSION,
} from '../../apps/wb-bot/src/feishu/events-file-reader.js';

describe('events-replay (F6 + F7)', () => {
  describe('F6: extractLatestContinuationToken', () => {
    it('F6.1: returns last done event continuationToken from multi done events', () => {
      const events = [
        { type: 'system', continuationToken: 'session-old' },
        { type: 'done', continuationToken: 'token-1' },
        { type: 'text', delta: 'hello' },
        { type: 'done', continuationToken: 'token-2' },
      ];
      expect(extractLatestContinuationToken(events)).toBe('token-2');
    });

    it('F6.2: returns last system event token when no done events', () => {
      const events = [
        { type: 'system', continuationToken: 'sys-token-1' },
        { type: 'text', delta: 'hi' },
        { type: 'system', continuationToken: 'sys-token-2' },
      ];
      expect(extractLatestContinuationToken(events)).toBe('sys-token-2');
    });

    it('F6.3: returns undefined for empty events array', () => {
      expect(extractLatestContinuationToken([])).toBeUndefined();
    });

    it('F6.4: returns undefined for pre-W2 ndjson (no token fields)', () => {
      const events = [
        { type: 'text', delta: 'hello' },
        { type: 'tool_use', id: 'tu-1', name: 'Read' },
        { type: 'done' },
      ];
      expect(extractLatestContinuationToken(events)).toBeUndefined();
    });

    it('F6.5: ignores non-string continuationToken values', () => {
      const events = [
        { type: 'done', continuationToken: 123 },
        { type: 'system', continuationToken: null },
      ];
      expect(extractLatestContinuationToken(events as any)).toBeUndefined();
    });
  });

  describe('F7: schema tolerance', () => {
    it('F7.1: parseEventLine skips unknown event types gracefully', () => {
      const result = parseEventLine('{"type":"future_event_v99","data":"xyz"}');
      expect(result).toEqual({ type: 'future_event_v99', data: 'xyz' });
    });

    it('F7.2: parseEventLine returns null for corrupt JSON', () => {
      expect(parseEventLine('{invalid json')).toBeNull();
      expect(parseEventLine('')).toBeNull();
    });

    it('F7.3: parseEventLine returns null for non-object JSON', () => {
      expect(parseEventLine('"just a string"')).toBeNull();
      expect(parseEventLine('42')).toBeNull();
    });

    it('F7.4: parseEventLine returns null when type field missing', () => {
      expect(parseEventLine('{"data":"hello"}')).toBeNull();
    });

    it('F7.5: checkSchemaVersion defaults to 1 when no schemaVersion field', () => {
      const result = checkSchemaVersion({});
      expect(result).toEqual({ ok: true, version: 1 });
    });

    it('F7.6: checkSchemaVersion defaults to 1 for undefined spec', () => {
      const result = checkSchemaVersion(undefined);
      expect(result).toEqual({ ok: true, version: 1 });
    });

    it('F7.7: checkSchemaVersion=1 passes (supported)', () => {
      const result = checkSchemaVersion({ schemaVersion: 1 });
      expect(result).toEqual({ ok: true, version: 1 });
    });

    it('F7.8: checkSchemaVersion=2 fails (> supported), no throw', () => {
      const result = checkSchemaVersion({ schemaVersion: 2 });
      expect(result.ok).toBe(false);
      expect(result.version).toBe(2);
      expect(result.message).toContain('schemaVersion 2');
    });

    it('F7.9: EVENTS_SUPPORTED_SCHEMA_VERSION is 1', () => {
      expect(EVENTS_SUPPORTED_SCHEMA_VERSION).toBe(1);
    });
  });

  describe('F6.1: readEventsSync', () => {
    it('returns [] for non-existent file', () => {
      expect(readEventsSync('/tmp/does-not-exist-xyz.ndjson')).toEqual([]);
    });

    it('returns only valid events from mixed valid/corrupt lines', () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-rs-'));
      const path = join(dir, 'events.ndjson');
      writeFileSync(path, [
        '{"type":"text","delta":"hello"}',
        '{corrupt json',
        '{"type":"done","continuationToken":"tok-123"}',
        '',
      ].join('\n'));
      const events = readEventsSync(path);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'text', delta: 'hello' });
      expect(events[1]).toEqual({ type: 'done', continuationToken: 'tok-123' });
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads done event with continuationToken', () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-rs-'));
      const path = join(dir, 'events.ndjson');
      writeFileSync(path, '{"type":"done","continuationToken":"session-abc"}\n');
      const events = readEventsSync(path);
      expect(events).toHaveLength(1);
      expect(events[0]!['continuationToken']).toBe('session-abc');
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
