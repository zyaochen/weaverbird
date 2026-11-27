import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { approvalGateDir, approvalRequestsPath, approvalResolutionPath } from '../../../../packages/core/src/paths.js';
import type { CommandContext } from './router.js';

type Row = {
  requestId: string;
  status: string;
  anchor: string;
  userOpenId: string;
  createdAt: string;
  resolved?: { resolutionReason?: string; resolvedBy?: string };
};

function readRequests(dataDir: string): Row[] {
  const path = approvalRequestsPath(dataDir);
  if (!existsSync(path)) return [];
  const deduped = new Map<string, Row>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { op: string; request: Row };
      if (entry.op !== 'request_created' && entry.op !== 'request_resolved') continue;
      deduped.set(entry.request.requestId, entry.request);
    } catch {
      continue;
    }
  }
  return [...deduped.values()];
}

function readResolutions(dataDir: string): Map<string, { resolutionReason?: string; resolvedBy?: string }> {
  const dir = join(approvalGateDir(dataDir), 'resolutions');
  if (!existsSync(dir)) return new Map();
  const out = new Map<string, { resolutionReason?: string; resolvedBy?: string }>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { requestId: string; reason?: string; resolvedBy?: string };
      out.set(raw.requestId, { resolutionReason: raw.reason, resolvedBy: raw.resolvedBy });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * M13-F: `/wb approval [--all|--pending|--resolved|--expired|--limit N]`
 * IM 侧只读 approval 队列。不发起审批决策(那是卡片按钮),只是把 runbook 列表化,
 * 让 group 里人也能看懂 pending 状态。
 */
export function handleWbApproval(args: string[], ctx: CommandContext): string {
  const dataDir = ctx.controlPlane?.dataDir;
  if (!dataDir) return '⚠️ /wb approval 不可用 (control plane 未启动)';

  const filterAll = args.includes('--all');
  const filterPending = args.includes('--pending');
  const filterResolved = args.includes('--resolved');
  const filterExpired = args.includes('--expired');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? '', 10) : 20;

  const requests = readRequests(dataDir);
  const resolutions = readResolutions(dataDir);
  const rows = requests
    .map((request) => ({ ...request, resolved: resolutions.get(request.requestId) }))
    .filter((row) => {
      if (filterAll) return true;
      if (filterPending) return row.status === 'pending_dispatch' || row.status === 'pending_approval';
      if (filterResolved) return Boolean(row.resolved);
      if (filterExpired) return row.status === 'expired';
      return true;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);

  if (rows.length === 0) return '(没有 approval 记录)';

  return [
    `📋 approval 队列 (${rows.length})`,
    ...rows.map((row) => [
      row.createdAt.slice(0, 19).replace('T', ' '),
      row.requestId.slice(0, 8),
      row.anchor,
      row.status,
      row.resolved?.resolutionReason ?? '-',
    ].join('\t')),
  ].join('\n');
}
