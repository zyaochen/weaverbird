import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { runCommand } from '../../apps/wb-bot/src/commands/router.js';

const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-im-cmds-'));
  roots.push(dir);
  return dir;
}

function seedAuditMirror(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'audit-mirror.ndjson'), [
    JSON.stringify({ ts: '2026-08-04T08:00:00Z', agent_id: 'claude-code', action: 'shell_exec', resource: 'git status', run_id: 'run-1', session_id: 'sess-1' }),
    JSON.stringify({ ts: '2026-08-04T08:01:00Z', agent_id: 'codex', action: 'env_access', resource: 'echo $TOKEN', run_id: 'run-2', session_id: 'sess-1', env_filter_hit: true }),
  ].join('\n') + '\n');
}

function seedApproval(dataDir: string): void {
  const dir = join(dataDir, 'approval-gate');
  mkdirSync(join(dir, 'resolutions'), { recursive: true });
  writeFileSync(join(dir, 'requests.ndjson'), [
    JSON.stringify({ op: 'request_created', request: { requestId: 'req-a', runId: 'run-1', status: 'pending_approval', anchor: 'envVarChange', userOpenId: 'ou_1', threadId: 'grp', createdAt: '2026-08-04T08:00:00Z', deadlineAt: '2026-08-04T08:30:00Z' } }),
    JSON.stringify({ op: 'request_resolved', request: { requestId: 'req-b', runId: 'run-2', status: 'approved', anchor: 'writeToMainBranch', userOpenId: 'ou_1', threadId: 'grp', createdAt: '2026-08-04T08:10:00Z', deadlineAt: '2026-08-04T08:20:00Z' } }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'resolutions', 'req-b.json'), JSON.stringify({ requestId: 'req-b', runId: 'run-2', status: 'approved', reason: 'ok', resolvedAt: '2026-08-04T08:12:00Z', resolvedBy: 'ou_2' }));
}

describe('IM parity slash commands (M13-F)', () => {
  it('/wb audit returns mirror rows newest-first', async () => {
    const dir = makeDir();
    seedAuditMirror(dir);
    const store = new BindingStore(join(makeDir(), 'db'));
    const reply = await runCommand('/wb audit', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: { botId: 'default', dataDir: dir, taskIndex: {} as never, logFilePath: '/dev/null', wsClientStatus: () => ({ lastEventAt: null }) },
    });
    expect(reply).toContain('🧾 最近 2 条 audit');
    expect(reply).toContain('run-2');
    expect(reply?.split('\n')[1]).toContain('codex');
    store.close();
  });

  it('/wb audit supports --limit 1', async () => {
    const dir = makeDir();
    seedAuditMirror(dir);
    const store = new BindingStore(join(makeDir(), 'db'));
    const reply = await runCommand('/wb audit --limit 1', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: { botId: 'default', dataDir: dir, taskIndex: {} as never, logFilePath: '/dev/null', wsClientStatus: () => ({ lastEventAt: null }) },
    });
    expect(reply).toContain('最近 1 条');
    expect(reply && reply.split('\n').length).toBe(2); // title + row
    store.close();
  });

  it('/wb approval lists pending and resolved rows', async () => {
    const dir = makeDir();
    seedApproval(dir);
    const store = new BindingStore(join(makeDir(), 'db'));
    const reply = await runCommand('/wb approval --all', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: { botId: 'default', dataDir: dir, taskIndex: {} as never, logFilePath: '/dev/null', wsClientStatus: () => ({ lastEventAt: null }) },
    });
    expect(reply).toContain('📋 approval 队列');
    expect(reply).toContain('req-b');
    expect(reply).toContain('ok');
    store.close();
  });

  it('/wb approval --pending hides resolved rows', async () => {
    const dir = makeDir();
    seedApproval(dir);
    const store = new BindingStore(join(makeDir(), 'db'));
    const reply = await runCommand('/wb approval --pending', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: { botId: 'default', dataDir: dir, taskIndex: {} as never, logFilePath: '/dev/null', wsClientStatus: () => ({ lastEventAt: null }) },
    });
    expect(reply).toContain('req-a');
    expect(reply).not.toContain('req-b');
    store.close();
  });
});
