import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replayEventsFromNdjson, SUPPORTED_SCHEMA_VERSION } from '../../packages/core/src/runner/event-replay.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('F7 events.ndjson schema tolerance', () => {
  it('ignores unknown fields in events (forward compatibility)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-replay-'));
    roots.push(dir);
    const ndjson = join(dir, 'events.ndjson');
    const lines = [
      JSON.stringify({ type: 'system', continuationToken: 'tok-1', cwd: '/tmp', model: 'claude-4', schemaVersion: 1, unknownField: 'ignored' }),
      JSON.stringify({ type: 'text', delta: 'hello', schemaVersion: 1, futureField: 123 }),
      JSON.stringify({ type: 'done', continuationToken: 'tok-2', schemaVersion: 1, anotherNew: true }),
    ];
    writeFileSync(ndjson, lines.join('\n'));

    const result = replayEventsFromNdjson(ndjson);
    expect(result.events).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toBe(false);
    expect(result.latestContinuationToken).toBe('tok-2');
  });

  it('skips run entirely when schemaVersion > supported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-replay-'));
    roots.push(dir);
    const ndjson = join(dir, 'events.ndjson');
    const lines = [
      JSON.stringify({ type: 'system', continuationToken: 'tok-1', schemaVersion: 1 }),
      JSON.stringify({ type: 'text', delta: 'hello', schemaVersion: 999 }),
    ];
    writeFileSync(ndjson, lines.join('\n'));

    const result = replayEventsFromNdjson(ndjson);
    expect(result.skipped).toBe(true);
    expect(result.events).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('999');
  });

  it('handles JSON parse failures gracefully (corrupted line)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-replay-'));
    roots.push(dir);
    const ndjson = join(dir, 'events.ndjson');
    const lines = [
      JSON.stringify({ type: 'system', continuationToken: 'tok-1', schemaVersion: 1 }),
      'not valid json {{{',
      JSON.stringify({ type: 'done', continuationToken: 'tok-2', schemaVersion: 1 }),
    ];
    writeFileSync(ndjson, lines.join('\n'));

    const result = replayEventsFromNdjson(ndjson);
    expect(result.events).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.skipped).toBe(false);
    expect(result.latestContinuationToken).toBe('tok-2');
  });

  it('tolerates W1 old format without subagentId field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-replay-'));
    roots.push(dir);
    const ndjson = join(dir, 'events.ndjson');
    const lines = [
      JSON.stringify({ type: 'system', continuationToken: 'old-tok', cwd: '/tmp' }),
      JSON.stringify({ type: 'tool_use', id: 't1', name: 'Read', input: {} }),
      JSON.stringify({ type: 'tool_result', id: 't1', output: 'file content', isError: false }),
      JSON.stringify({ type: 'done', continuationToken: 'old-tok-2' }),
    ];
    writeFileSync(ndjson, lines.join('\n'));

    const result = replayEventsFromNdjson(ndjson);
    expect(result.events).toHaveLength(4);
    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toBe(false);
    expect(result.latestContinuationToken).toBe('old-tok-2');
  });

  it('picks most recent continuationToken from system/done events (F6)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-replay-'));
    roots.push(dir);
    const ndjson = join(dir, 'events.ndjson');
    const lines = [
      JSON.stringify({ type: 'system', continuationToken: 'initial-tok', schemaVersion: 1 }),
      JSON.stringify({ type: 'text', delta: 'working...', schemaVersion: 1 }),
      JSON.stringify({ type: 'done', continuationToken: 'rotated-tok-1', schemaVersion: 1 }),
      JSON.stringify({ type: 'system', continuationToken: 'resumed-tok', schemaVersion: 1 }),
      JSON.stringify({ type: 'done', continuationToken: 'final-tok', schemaVersion: 1 }),
    ];
    writeFileSync(ndjson, lines.join('\n'));

    const result = replayEventsFromNdjson(ndjson);
    expect(result.latestContinuationToken).toBe('final-tok');
  });

  it('returns empty result for non-existent file', () => {
    const result = replayEventsFromNdjson('/tmp/no-such-file-events.ndjson');
    expect(result.events).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toBe(false);
  });

  it('ignores heartbeat events during replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-replay-'));
    roots.push(dir);
    const ndjson = join(dir, 'events.ndjson');
    const lines = [
      JSON.stringify({ type: 'system', continuationToken: 'tok', schemaVersion: 1 }),
      JSON.stringify({ type: 'heartbeat', ts: Date.now(), schemaVersion: 1 }),
      JSON.stringify({ type: 'done', continuationToken: 'tok-2', schemaVersion: 1 }),
    ];
    writeFileSync(ndjson, lines.join('\n'));

    const result = replayEventsFromNdjson(ndjson);
    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => (e.type as string) !== 'heartbeat')).toBe(true);
  });

  it('preserves schemaVersion from agent CLI (not overwritten to 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-replay-'));
    roots.push(dir);
    const ndjson = join(dir, 'events.ndjson');
    const lines = [
      JSON.stringify({ type: 'system', continuationToken: 'tok', schemaVersion: 2, cwd: '/tmp' }),
      JSON.stringify({ type: 'text', delta: 'hello', schemaVersion: 2 }),
      JSON.stringify({ type: 'done', continuationToken: 'tok-2', schemaVersion: 2 }),
    ];
    writeFileSync(ndjson, lines.join('\n'));

    const result = replayEventsFromNdjson(ndjson);
    expect(result.skipped).toBe(true);
    expect(result.events).toHaveLength(0);
  });
});
