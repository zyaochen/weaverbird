import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInheritedRun, handleResume } from '../../apps/wb-bot/src/commands/resume.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { RUN_REGISTRY_ERROR_CODES, RunRegistryError, type RunRecord } from '../../packages/core/src/run-registry/index.js';

const roots: string[] = [];

function writeConfig(dir: string): void {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    run_registry: {
      bitable_base_id: 'bascn123',
      bitable_table_id: 'tblXYZ',
      app_id: 'cli_xxxxxxxxxxxxxxxx',
      app_secret: 'secret-32-characters-000000000000',
      lark_domain: 'https://open.larkoffice.com',
      run_finalize_grace_ms: 30000,
      doc_url_allowlist: ['*.larkoffice.com', '*.feishu.cn', 'github.com'],
    },
  }, null, 2));
  chmodSync(path, 0o600);
}

function makeRunRecord(): RunRecord {
  return {
    run_id: 'run-001',
    created_at: '2026-06-06T00:00:00.000Z',
    operator: 'ou_abc',
    project: 'proj-A',
    cwd: '/code',
    scope: 'default',
    agent: 'claude-code',
    cmd: 'claude-code --model opus',
    status: 'succeeded',
    cost_tokens: 123,
    cost_minutes: 7,
    produced_doc_urls: ['https://foo.larkoffice.com/doc/1'],
    commit_shas: ['0123456789abcdef0123456789abcdef01234567'],
    doc_sink_failed: false,
    calendar_block_id: null,
    calendar_hook_failed: false,
    risk_level: 'high',
    home_group_id: 'grp-001',
    entry_form: 'im',
  };
}

function commandCtx(dir: string) {
  const store = new BindingStore(join(dir, 'wb-bot.db'));
  const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);
  return {
    userOpenId: 'u1',
    threadId: 't1',
    registry,
    store,
    botId: 'default',
    close: () => store.close(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('inherit', () => {
  it('copies the six allowed inherit fields', () => {
    const inherited = buildInheritedRun(makeRunRecord(), 'new-run-id');
    expect(inherited.inherited).toEqual({
      project: 'proj-A',
      cwd: '/code',
      scope: 'default',
      agent: 'claude-code',
      home_group_id: 'grp-001',
      entry_form: 'im',
    });
    expect(inherited.newRunId).toBe('new-run-id');
  });

  it('throws run_not_found when source run does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-inherit-'));
    roots.push(dir);
    writeConfig(dir);
    vi.stubEnv('WB_DATA_DIR', dir);
    const ctx = commandCtx(dir);
    const writerModule = await import('../../packages/core/src/run-registry/bitable-writer.js');
    vi.spyOn(writerModule, 'createRunRegistryWriter').mockReturnValue({
      config: {} as any,
      wal: {} as any,
      validateSchema: vi.fn(),
      upsert: vi.fn(),
      findByRunId: vi.fn().mockResolvedValue(null),
      queryRuns: vi.fn(),
      syncOnce: vi.fn(),
      startSyncWorker: vi.fn(),
      stopSyncWorker: vi.fn(),
    });

    await expect(handleResume(['resume', '--inherit', 'nonexistent-id'], ctx as any)).rejects.toMatchObject({
      code: RUN_REGISTRY_ERROR_CODES.E_INHERIT_NOT_FOUND,
    });
    ctx.close();
  });

  it('generates unique new run ids across repeated inheritance', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      ids.add(buildInheritedRun(makeRunRecord()).newRunId);
    }
    expect(ids.size).toBe(100);
  });

  it('does not copy excluded fields into the new session result', () => {
    const inherited = buildInheritedRun(makeRunRecord(), 'new-run-id');
    expect(inherited.excluded).toEqual({
      risk_level: 'unknown',
      cost_tokens: null,
      cost_minutes: null,
      produced_doc_urls: [],
      commit_shas: [],
    });
  });
});
