import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCaptainConfig } from '../../../../packages/core/src/captain/index.js';
import { SlaTracker, type MetricEntry } from '../../../../packages/core/src/reverse-channel/sla-tracker.js';

type CaptainBinding = { captain_id: string; updated_at: string };

function metricsPath(homeDir = homedir()): string {
  return join(homeDir, '.weaverbird', 'sla-metrics.ndjson');
}

function readMetrics(homeDir = homedir()): MetricEntry[] {
  const path = metricsPath(homeDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as MetricEntry);
}

function resolveCaptainBindingPath(homeDir = homedir()): string {
  return join(homeDir, '.weaverbird', 'captain-binding.json');
}

function readCaptainBinding(homeDir = homedir()): CaptainBinding | null {
  const path = resolveCaptainBindingPath(homeDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CaptainBinding;
  } catch {
    return null;
  }
}

function writeCaptainBinding(captainId: string, homeDir = homedir()): void {
  const path = resolveCaptainBindingPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ captain_id: captainId, updated_at: new Date().toISOString() }, null, 2));
}

export function captainCommand(argv: string[], opts: { cwd?: string; homeDir?: string } = {}): number {
  if (argv[0] === 'sla') {
    const entries = readMetrics(opts.homeDir);
    const tracker = new SlaTracker(metricsPath(opts.homeDir));
    const summary = tracker.summarize(entries.slice(-100));
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return 0;
    }
    process.stdout.write([
      `F18 attach P95: ${summary.attach_p95_ms}ms`,
      `F19 echo P95: ${summary.echo_p95_ms}ms`,
      `F21 hit rate: ${Math.round(summary.reverse_at_hit_rate * 100)}%`,
    ].join('\n') + '\n');
    return 0;
  }
  if (argv[0] === 'use') {
    const captainId = argv[1];
    if (!captainId) {
      process.stderr.write('Usage: wb-cli captain use <captain_id>\n');
      return 1;
    }
    writeCaptainBinding(captainId, opts.homeDir);
    process.stdout.write(`captain=${captainId}\n`);
    return 0;
  }

  const config = loadCaptainConfig({ cwd: opts.cwd, homeDir: opts.homeDir });
  const binding = readCaptainBinding(opts.homeDir);
  const lines = ['Known captains:'];
  for (const mapping of config.mapping) {
    const current = binding?.captain_id === mapping.captain_id ? ' (current)' : '';
    lines.push(`- ${mapping.captain_id}${current}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
