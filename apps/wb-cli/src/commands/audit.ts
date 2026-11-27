import { existsSync, readFileSync } from 'node:fs';
import { auditMirrorPath, resolveDataDir } from '@weaverbird/core';

export type AuditListOptions = {
  cwd?: string;
  limit?: number;
  since?: string; // ISO timestamp
  sessionId?: string;
};

export function parseAuditArgs(argv: string[]): AuditListOptions {
  const options: AuditListOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    if (arg === '--limit' && next) {
      options.limit = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    if (arg === '--since' && next) {
      options.since = next;
      i += 1;
      continue;
    }
    if (arg === '--session-id' && next) {
      options.sessionId = next;
      i += 1;
      continue;
    }
  }
  return options;
}

/**
 * M12-D (2026-08-04 owner-authorized, PRD §4.2 "wb-cli audit" 平价):
 * Reads the local audit-mirror.ndjson (W3.1 audit-pipe 持久化层) and prints a
 * tabular summary. 不动远端审计 OpenAPI (红线 specs/w3.1-f17-audit-pipe §20);
 * 远端查询 PRD-要求的"90 天企业审计" 是留 v2, 本命令只看本机镜像。
 */
export function auditCommand(argv: string[]): Promise<number> {
  const opts = parseAuditArgs(argv);
  const dataDir = resolveDataDir({});
  const mirrorPath = auditMirrorPath(dataDir);
  if (!existsSync(mirrorPath)) {
    process.stderr.write(`audit mirror not found at ${mirrorPath}; run a cycle first or check WB_DATA_DIR\n`);
    return Promise.resolve(1);
  }
  const since = opts.since ? Date.parse(opts.since) : null;
  const limit = opts.limit ?? 50;
  const lines = readFileSync(mirrorPath, 'utf8').split('\n').filter((line) => line.trim()).slice(-5000);
  const kept: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (since !== null && Date.parse(String(record['ts'] ?? '')) < since) continue;
      if (opts.sessionId && record['session_id'] !== opts.sessionId) continue;
      kept.push(record);
    } catch {
      continue;
    }
  }
  const out = kept
    .reverse()
    .slice(0, limit)
    .map((record) => [
      record['ts'],
      record['session_id'],
      record['agent_id'],
      record['action'],
      record['env_filter_hit'] ? 'env_hit=1' : 'env_hit=0',
      record['resource'],
      record['run_id'],
    ].join('\t'));
  process.stdout.write(out.length ? out.join('\n') + '\n' : '(no audit entries)\n');
  return Promise.resolve(0);
}
