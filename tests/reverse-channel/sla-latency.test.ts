import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SlaTracker } from '../../packages/core/src/reverse-channel/sla-tracker.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sla-latency', () => {
  it('records attach latency and marks sla_ok under 5000ms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-sla-'));
    roots.push(dir);
    const path = join(dir, 'sla-metrics.ndjson');
    const tracker = new SlaTracker(path);
    const entry = tracker.record('attach', 4200, 5000);
    expect(entry.sla_ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('"kind":"attach"');
  });

  it('records echo latency and marks sla_ok under 3000ms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-sla-'));
    roots.push(dir);
    const path = join(dir, 'sla-metrics.ndjson');
    const tracker = new SlaTracker(path);
    const entry = tracker.record('echo', 2500, 3000);
    expect(entry.sla_ok).toBe(true);
  });

  it('records reverse_at round-trip and includes it in hit rate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-sla-'));
    roots.push(dir);
    const path = join(dir, 'sla-metrics.ndjson');
    const tracker = new SlaTracker(path);
    tracker.record('reverse_at', 900, 1000);
    tracker.record('reverse_at', 1200, 1000);
    const summary = tracker.summarize([
      { kind: 'reverse_at', elapsed_ms: 900, sla_ok: true, ts: '2026-06-07T00:00:00.000Z' },
      { kind: 'reverse_at', elapsed_ms: 1200, sla_ok: false, ts: '2026-06-07T00:00:01.000Z' },
    ]);
    expect(summary.reverse_at_hit_rate).toBe(0.5);
  });

  it('computes attach and echo p95 from recent entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-sla-'));
    roots.push(dir);
    const path = join(dir, 'sla-metrics.ndjson');
    const tracker = new SlaTracker(path);
    const summary = tracker.summarize([
      { kind: 'attach', elapsed_ms: 1000, sla_ok: true, ts: '2026-06-07T00:00:00.000Z' },
      { kind: 'attach', elapsed_ms: 3000, sla_ok: true, ts: '2026-06-07T00:00:01.000Z' },
      { kind: 'attach', elapsed_ms: 4800, sla_ok: true, ts: '2026-06-07T00:00:02.000Z' },
      { kind: 'echo', elapsed_ms: 500, sla_ok: true, ts: '2026-06-07T00:00:03.000Z' },
      { kind: 'echo', elapsed_ms: 2500, sla_ok: true, ts: '2026-06-07T00:00:04.000Z' },
    ]);
    expect(summary.attach_p95_ms).toBeLessThanOrEqual(5000);
    expect(summary.echo_p95_ms).toBeLessThanOrEqual(3000);
  });

  it('rejects metric lines longer than 1KB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-sla-'));
    roots.push(dir);
    const path = join(dir, 'sla-metrics.ndjson');
    const tracker = new SlaTracker(path);
    const huge = 'x'.repeat(2000);
    expect(() => tracker.record(huge as any, 1, 1)).toThrow(/too long/i);
  });
});
