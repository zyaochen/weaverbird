import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBitableFilter, handleHistory } from '../../apps/wb-bot/src/commands/history.js';
import { parseHistoryArgs } from '../../apps/wb-cli/src/commands/history.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import type { RunRecord } from '../../packages/core/src/run-registry/index.js';

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

function ctx(dir: string) {
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

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: overrides.run_id ?? 'run-001',
    created_at: overrides.created_at ?? '2026-06-06T00:00:00.000Z',
    operator: overrides.operator ?? 'ou_abc',
    project: overrides.project ?? 'DR演练',
    cwd: overrides.cwd ?? '/repo',
    scope: overrides.scope ?? 'normal',
    agent: overrides.agent ?? 'claude-code',
    cmd: overrides.cmd ?? 'claude-code --model opus',
    status: overrides.status ?? 'succeeded',
    cost_tokens: overrides.cost_tokens ?? null,
    cost_minutes: overrides.cost_minutes ?? 1,
    produced_doc_urls: overrides.produced_doc_urls ?? ['https://foo.larkoffice.com/doc/1', 'https://foo.larkoffice.com/doc/2', 'https://foo.larkoffice.com/doc/3', 'https://foo.larkoffice.com/doc/4'],
    commit_shas: overrides.commit_shas ?? [],
    doc_sink_failed: overrides.doc_sink_failed ?? false,
    calendar_block_id: overrides.calendar_block_id ?? null,
    calendar_hook_failed: overrides.calendar_hook_failed ?? false,
    risk_level: overrides.risk_level ?? 'unknown',
    home_group_id: overrides.home_group_id ?? 'grp-001',
    entry_form: overrides.entry_form ?? 'im',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('history-query', () => {
  it('builds empty filter as ALL()', () => {
    expect(buildBitableFilter({ limit: 20 })).toBe('ALL()');
  });

  it('builds operator and agent filter expressions', () => {
    const filter = buildBitableFilter({ operator: 'ou_abc', agent: 'claude-code', limit: 20 });
    expect(filter).toContain('CurrentValue.[operator]="ou_abc"');
    expect(filter).toContain('CurrentValue.[agent]="claude-code"');
  });

  it('builds status filter expression', () => {
    const filter = buildBitableFilter({ status: 'succeeded', limit: 20 });
    expect(filter).toContain('CurrentValue.[status]="succeeded"');
  });

  it('parses cli history args including --json and cursor', () => {
    const parsed = parseHistoryArgs(['--json', '--status', 'succeeded', '--limit', '5', '--cursor', 'page2']);
    expect(parsed.json).toBe(true);
    expect(parsed.query.status).toBe('succeeded');
    expect(parsed.query.limit).toBe(5);
    expect(parsed.query.cursor).toBe('page2');
  });

  it('renders history output with required fields and next cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-history-'));
    roots.push(dir);
    writeConfig(dir);
    const commandCtx = ctx(dir);
    vi.stubEnv('WB_DATA_DIR', dir);
    const writerModule = await import('../../packages/core/src/run-registry/bitable-writer.js');
    vi.spyOn(writerModule, 'createRunRegistryWriter').mockReturnValue({
      config: {} as any,
      wal: {} as any,
      validateSchema: vi.fn(),
      upsert: vi.fn(),
      findByRunId: vi.fn(),
      queryRuns: vi.fn().mockResolvedValue({ runs: [runRecord()], next_cursor: 'page2', total_hint: 1 }),
      syncOnce: vi.fn(),
      startSyncWorker: vi.fn(),
      stopSyncWorker: vi.fn(),
    });

    const output = await handleHistory(['history'], commandCtx as any);

    expect(output).toContain('📚 Run History');
    expect(output).toContain('run-001');
    expect(output).toContain('/repo');
    expect(output).toContain('succeeded');
    expect(output).toContain('claude-code');
    expect(output).toContain('next_cursor=page2');
    commandCtx.close();
  });

  it('limits produced_doc_urls display to first three entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-history-'));
    roots.push(dir);
    writeConfig(dir);
    const commandCtx = ctx(dir);
    vi.stubEnv('WB_DATA_DIR', dir);
    const writerModule = await import('../../packages/core/src/run-registry/bitable-writer.js');
    vi.spyOn(writerModule, 'createRunRegistryWriter').mockReturnValue({
      config: {} as any,
      wal: {} as any,
      validateSchema: vi.fn(),
      upsert: vi.fn(),
      findByRunId: vi.fn(),
      queryRuns: vi.fn().mockResolvedValue({ runs: [runRecord()], next_cursor: null, total_hint: 1 }),
      syncOnce: vi.fn(),
      startSyncWorker: vi.fn(),
      stopSyncWorker: vi.fn(),
    });

    const output = await handleHistory(['history'], commandCtx as any);

    expect(output).toContain('doc/1');
    expect(output).toContain('doc/2');
    expect(output).toContain('doc/3');
    expect(output).not.toContain('doc/4');
    commandCtx.close();
  });
});
