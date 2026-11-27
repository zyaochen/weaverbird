import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { approvalGateDir, approvalRequestsPath, approvalResolutionPath, resolveDataDir } from '@weaverbird/core';

export type ApprovalListFilter = {
  all?: boolean;
  pending?: boolean;
  resolved?: boolean;
  expired?: boolean;
  limit?: number;
};

export function parseApprovalArgs(argv: string[]): ApprovalListFilter {
  const filter: ApprovalListFilter = {};
  for (const arg of argv) {
    if (arg === '--all') filter.all = true;
    else if (arg === '--pending') filter.pending = true;
    else if (arg === '--resolved') filter.resolved = true;
    else if (arg === '--expired') filter.expired = true;
    else if (arg === '--limit') filter.limit = Number.parseInt(argv[argv.indexOf(arg) + 1] ?? '', 10);
  }
  return filter;
}

type LoadedApproval = {
  requestId: string;
  runId: string;
  status: string;
  anchor: string;
  userOpenId: string;
  threadId: string;
  createdAt: string;
  deadlineAt: string;
  resolutionReason?: string;
  resolvedBy?: string;
};

function loadRequests(dataDir: string): LoadedApproval[] {
  const path = approvalRequestsPath(dataDir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out: LoadedApproval[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { op?: string; request?: LoadedApproval };
      if (entry.op === 'request_created' || entry.op === 'request_resolved') {
        if (entry.request) out.push(entry.request);
      }
    } catch {
      continue;
    }
  }
  return out;
}

function loadResolutions(dataDir: string, requestIds: string[]): Map<string, LoadedApproval> {
  const dir = approvalGateDir(dataDir);
  if (!existsSync(dir)) return new Map();
  const out = new Map<string, LoadedApproval>();
  for (const id of requestIds) {
    const path = approvalResolutionPath(dataDir, id);
    if (!existsSync(path)) continue;
    try {
      const resolution = JSON.parse(readFileSync(path, 'utf8')) as LoadedApproval;
      out.set(id, resolution);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * M12-D (2026-08-04 owner-authorized, PRD §4.2 "wb-cli approval" 平价):
 * 本机 Approval 队列视图:读 approval-requests.ndjson + resolutions/。只做查询,
 * 不做远端审批 API 调用,也不动飞书审批 决策(还是卡片按钮决定)。
 */
export function approvalCommand(argv: string[]): Promise<number> {
  const filter = parseApprovalArgs(argv);
  const dataDir = resolveDataDir({});
  const requests = loadRequests(dataDir);
  if (requests.length === 0) {
    process.stdout.write('(no approval requests)\n');
    return Promise.resolve(0);
  }
  const deduped = new Map<string, LoadedApproval>();
  for (const request of requests) deduped.set(request.requestId, request);
  const resolutions = loadResolutions(dataDir, [...deduped.keys()]);

  const rows = [...deduped.values()]
    .map((request) => ({ ...request, resolved: resolutions.get(request.requestId) }))
    .filter((row) => {
      if (filter.all) return true;
      if (filter.pending) return row.status === 'pending_dispatch' || row.status === 'pending_approval';
      if (filter.resolved) return Boolean(row.resolved);
      if (filter.expired) return row.status === 'expired';
      return true;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, filter.limit ?? 50);

  const lines = rows.map((row) => [
    row.createdAt,
    row.requestId.slice(0, 8),
    row.anchor,
    row.status,
    row.resolved?.resolutionReason ?? '-',
    row.userOpenId,
  ].join('\t'));
  process.stdout.write(lines.join('\n') + '\n');
  return Promise.resolve(0);
}
