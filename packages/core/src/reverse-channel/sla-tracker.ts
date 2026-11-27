import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

type MetricKind = 'attach' | 'echo' | 'reverse_at';

type MetricEntry = {
  kind: MetricKind;
  elapsed_ms: number;
  sla_ok: boolean;
  ts: string;
};

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function atomicAppend(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class SlaTracker {
  constructor(private readonly path: string) {}

  record(kind: MetricKind, elapsedMs: number, targetMs: number): MetricEntry {
    const entry: MetricEntry = {
      kind,
      elapsed_ms: elapsedMs,
      sla_ok: elapsedMs <= targetMs,
      ts: new Date().toISOString(),
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (line.length > 1024) {
      throw new Error('SLA metric line too long');
    }
    atomicAppend(this.path, line);
    return entry;
  }

  summarize(entries: MetricEntry[]): { attach_p95_ms: number; echo_p95_ms: number; reverse_at_hit_rate: number } {
    const attach = entries.filter((entry) => entry.kind === 'attach').map((entry) => entry.elapsed_ms);
    const echo = entries.filter((entry) => entry.kind === 'echo').map((entry) => entry.elapsed_ms);
    const reverse = entries.filter((entry) => entry.kind === 'reverse_at');
    const reverseOk = reverse.filter((entry) => entry.sla_ok).length;
    return {
      attach_p95_ms: p95(attach),
      echo_p95_ms: p95(echo),
      reverse_at_hit_rate: reverse.length > 0 ? reverseOk / reverse.length : 0,
    };
  }
}

export type { MetricEntry, MetricKind };
