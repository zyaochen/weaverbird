import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env['WB_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'wb-cli-audit-'));

import { auditCommand, parseAuditArgs } from '../../apps/wb-cli/src/commands/audit.js';
import { approvalCommand } from '../../apps/wb-cli/src/commands/approval.js';
import { auditMirrorPath, approvalRequestsPath, approvalGateDir } from '@weaverbird/core';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function auditMirror(): string {
  return auditMirrorPath(process.env['WB_DATA_DIR'] as string);
}

function seedAuditMirror(): void {
  const mirrorPath = auditMirror();
  mkdirSync(join(mirrorPath, '..'), { recursive: true });
  writeFileSync(mirrorPath, [
    JSON.stringify({ ts: '2026-08-04T08:00:00Z', agent_id: 'claude-code', action: 'shell_exec', resource: 'git status', run_id: 'run-1', session_id: 'sess-1' }),
    JSON.stringify({ ts: '2026-08-04T08:01:00Z', agent_id: 'codex', action: 'file_write', resource: '/repo/a.ts', run_id: 'run-2', session_id: 'sess-1', env_filter_hit: true }),
    JSON.stringify({ ts: '2026-08-04T08:02:00Z', agent_id: 'claude-code', action: 'env_access', resource: 'echo $TOKEN', run_id: 'run-3', session_id: 'sess-2', env_filter_hit: true }),
  ].join('\n') + '\n');
}

describe('wb-cli audit', () => {
  it('returns 1 when audit mirror is missing', async () => {
    const code = await auditCommand([]);
    expect(code).toBe(1);
  });

  it('prints rows newest-first with limit', async () => {
    seedAuditMirror();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await auditCommand(['--limit', '2']);
    expect(code).toBe(0);
    const stdout = write.mock.calls.map((call) => String(call[0])).join('');
    expect(stdout.split('\n').filter(Boolean).length).toBe(2);
    // limit=2 拿最新两条 run-3 (08:02) + run-2 (08:01), newest first => run-3 出现在第一行.
    expect(stdout.split('\n')[0]).toContain('run-3');
    expect(stdout.split('\n')[1]).toContain('run-2');
    write.mockRestore();
  });

  it('filters by session_id', async () => {
    seedAuditMirror();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await auditCommand(['--session-id', 'sess-2']);
    expect(code).toBe(0);
    const stdout = write.mock.calls.map((call) => String(call[0])).join('');
    expect(stdout).toContain('sess-2');
    expect(stdout).not.toContain('sess-1');
    write.mockRestore();
  });

  it('parseAuditArgs covers --limit --since --session-id', () => {
    expect(parseAuditArgs(['--limit', '10', '--since', '2026-08-04', '--session-id', 's1'])).toEqual({ limit: 10, since: '2026-08-04', sessionId: 's1' });
  });
});

describe('wb-cli approval', () => {
  it('returns 0 with empty ledger', async () => {
    const code = await approvalCommand([]);
    expect(code).toBe(0);
  });

  it('writes rows from approval-requests.ndjson and picks up resolutions', async () => {
    const dir = process.env['WB_DATA_DIR'] as string;
    const path = approvalRequestsPath(dir);
    mkdirSync(join(path, '..'), { recursive: true });
    const resolutionDir = approvalGateDir(dir);
    mkdirSync(join(resolutionDir, 'resolutions'), { recursive: true });
    const requestId = 'req-1';
    writeFileSync(path, [
      JSON.stringify({ op: 'request_created', request: { requestId, runId: 'run-a', status: 'pending_approval', anchor: 'envVarChange', userOpenId: 'u1', threadId: 'grp', createdAt: '2026-08-04T08:00:00Z', deadlineAt: '2026-08-04T08:30:00Z' } }),
      JSON.stringify({ op: 'request_resolved', request: { requestId, runId: 'run-a', status: 'approved', anchor: 'envVarChange', userOpenId: 'u1', threadId: 'grp', createdAt: '2026-08-04T08:00:00Z', deadlineAt: '2026-08-04T08:30:00Z', resolutionReason: 'ok' } }),
    ].join('\n') + '\n');
    writeFileSync(join(resolutionDir, 'resolutions', `${requestId}.json`), JSON.stringify({ requestId, runId: 'run-a', status: 'approved', reason: 'ok', resolvedAt: '2026-08-04T08:05:00Z', resolvedBy: 'u2' }));

    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await approvalCommand(['--all']);
    expect(code).toBe(0);
    const stdout = write.mock.calls.map((call) => String(call[0])).join('');
    expect(stdout).toContain('req-1');
    expect(stdout).toContain('envVarChange');
    expect(stdout).toContain('approved');
    write.mockRestore();
  });
});
