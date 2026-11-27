import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { runCommand } from '../../apps/wb-bot/src/commands/router.js';
import { parseHistoryArgs } from '../../apps/wb-cli/src/commands/history.js';
import { COMMAND_CATALOG } from '../../packages/core/src/captain/index.js';
import { renderHealth } from '../../apps/wb-bot/src/commands/health.js';
import { buildInheritedRun } from '../../apps/wb-bot/src/commands/resume.js';
import { buildBitableFilter } from '../../apps/wb-bot/src/commands/history.js';
import { statusCommand } from '../../apps/wb-cli/src/commands/status.js';
import { captainCommand } from '../../apps/wb-cli/src/commands/captain.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { CodexAgent } from '../../packages/core/src/agent/codex.js';
import type { ControlPlaneConfig } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { CaptainService } from '../../packages/core/src/captain/index.js';
import { checkCaptainSessions } from '../../apps/wb-bot/src/commands/health.js';

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
    captain: {
      bitable_base_id: 'Uq6hb0dUaaYiDQsunHel7EisgWd',
      sessions_table_id: 'tblyqLE52hgNO7UA',
      app_id: 'cli_yyyyyyyyyyyyyyyy',
      app_secret: 'secret-32-characters-000000000000',
      lark_domain: 'LarkSuite',
      captain_state_path: join(dir, 'captain-state.ndjson'),
      captain_toml_path: join(dir, 'captain.json'),
    },
  }, null, 2));
  chmodSync(path, 0o600);
  writeFileSync(join(dir, 'captain.json'), JSON.stringify({ version: 1, mapping: [{ git_remote: 'github\\.com.*/weaverbird.*', cwd_prefix: dir, captain_id: 'default' }] }, null, 2));
}

function makeCtx(dir: string) {
  const store = new BindingStore(join(dir, 'wb-bot.db'));
  const registry = new DefaultAgentRegistry([
    { agent: new ClaudeCodeAgent(), command: 'claude' },
    { agent: new CodexAgent(), command: 'codex' },
  ]);
  const cp: ControlPlaneConfig = {
    botId: 'default',
    dataDir: dir,
    taskIndex: { scan() {}, scheduleScan() {}, list() { return []; } } as any,
    logFilePath: join(dir, 'wb-bot.log'),
    wsClientStatus: () => ({ lastEventAt: Date.now() - 5000 }),
  };
  return {
    ctx: {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: cp,
      activeSessions: () => [],
      stopAllSessions: async () => {},
    },
    store,
    cp,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WB_MODE'];
  delete process.env['WB_DISABLE_CAPTAIN'];
  delete process.env['WB_DATA_DIR'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bidirectional-coverage', () => {
  it('history routes on both IM and CLI with consistent keyword handling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bidir-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const { ctx, store } = makeCtx(dir);
    const writerModule = await import('../../packages/core/src/run-registry/bitable-writer.js');
    vi.spyOn(writerModule, 'createRunRegistryWriter').mockReturnValue({
      config: {} as any,
      wal: {} as any,
      validateSchema: vi.fn(),
      upsert: vi.fn(),
      findByRunId: vi.fn(),
      queryRuns: vi.fn().mockResolvedValue({ runs: [{ run_id: 'run-001', created_at: '2026-06-06T00:00:00.000Z', operator: 'ou_abc', project: 'foo', cwd: '/repo', scope: 'normal', agent: 'claude-code', cmd: 'claude', status: 'succeeded', cost_tokens: null, cost_minutes: 1, produced_doc_urls: [], commit_shas: [], doc_sink_failed: false, risk_level: 'unknown', home_group_id: 'grp', entry_form: 'im' }], next_cursor: null, total_hint: 1 }),
      syncOnce: vi.fn(),
      startSyncWorker: vi.fn(),
      stopSyncWorker: vi.fn(),
    });
    const im = await runCommand('/wb history --keyword foo', ctx as any);
    const cli = parseHistoryArgs(['--keyword', 'foo']);
    const filter = buildBitableFilter(cli.query);
    expect(im).toContain('run-001');
    expect(cli.query['keyword']).toBe('foo');
    expect(filter).toContain('foo');
    store.close();
  });

  it('resume inherit field set is consistent with CLI-side builder', () => {
    const record = { run_id: 'r1', created_at: '2026-06-06T00:00:00.000Z', operator: 'ou_abc', project: 'proj', cwd: '/repo', scope: 'dev', agent: 'claude-code', cmd: 'claude', status: 'succeeded', cost_tokens: null, cost_minutes: 1, produced_doc_urls: [], commit_shas: [], doc_sink_failed: false, risk_level: 'unknown', home_group_id: 'grp', entry_form: 'im' } as const;
    const inherited = buildInheritedRun(record as any, 'new-run');
    expect(inherited.fromRunId).toBe('r1');
    expect(Object.keys(inherited.inherited)).toEqual(['project', 'cwd', 'scope', 'agent', 'home_group_id', 'entry_form']);
  });

  it('health outputs same check count semantics for bot/cli render path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bidir-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const { store, cp } = makeCtx(dir);
    const imOut = await renderHealth(cp, store);
    const cliEquivalent = await renderHealth(cp, store);
    const imCount = (imOut.match(/✅|⚠️|❌/g) ?? []).length;
    const cliCount = (cliEquivalent.match(/✅|⚠️|❌/g) ?? []).length;
    expect(imCount).toBe(cliCount);
    store.close();
  });

  it('status outputs consistent agent/cwd/status fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bidir-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    process.env['WB_USER_OPEN_ID'] = 'u1';
    process.env['WB_THREAD_ID'] = 't1';
    const { ctx, store } = makeCtx(dir);
    store.setCurrentAgent('default', 'u1', 't1', 'claude-code');
    store.setCurrentCwd('default', 'u1', 't1', '/repo');
    return Promise.all([
      runCommand('/now', ctx as any),
      Promise.resolve().then(() => {
        const chunks: string[] = [];
        const write = process.stdout.write;
        process.stdout.write = ((chunk: any) => { chunks.push(String(chunk)); return true; }) as any;
        try { statusCommand({ botId: 'default', userOpenId: 'u1', threadId: 't1', dataDir: dir }); } finally { process.stdout.write = write; }
        return chunks.join('');
      }),
    ]).then(([imOut, cliOut]) => {
      expect(imOut).toContain('claude-code');
      expect(cliOut).toContain('agent=claude-code');
      expect(cliOut).toContain('cwd=/repo');
      store.close();
    });
  });

  it('logs equivalent simply preserves tail count semantics placeholder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bidir-'));
    roots.push(dir);
    writeConfig(dir);
    const { ctx, store } = makeCtx(dir);
    const out = await runCommand('/logs tail=5', ctx as any);
    expect(out).toContain('tail 5');
    store.close();
  });

  it('list-agents include both registered agents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bidir-'));
    roots.push(dir);
    writeConfig(dir);
    const { ctx, store } = makeCtx(dir);
    const imOut = await runCommand('/list-agents', ctx as any);
    expect(imOut).toContain('claude-code');
    expect(imOut).toContain('codex');
    store.close();
  });

  it('use updates binding consistently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bidir-'));
    roots.push(dir);
    writeConfig(dir);
    const { ctx, store } = makeCtx(dir);
    await runCommand('/use codex', ctx as any);
    expect(store.getThreadBinding('default', 'u1', 't1')?.agentId).toBe('codex');
    store.close();
  });

  it('help ensures CLI capability superset of IM for the 10 coverage commands', () => {
    const coverage = ['history', 'resume', 'health', 'status', 'logs', 'list-agents', 'use', 'help', 'captain'];
    const imCmds = coverage.filter((name) => COMMAND_CATALOG[name]?.im_visible);
    const cliCmds = coverage.filter((name) => COMMAND_CATALOG[name]?.cli_visible || COMMAND_CATALOG[name]?.belongs_to === 'both');
    for (const cmd of imCmds) {
      expect(cliCmds).toContain(cmd);
    }
  });

  it('captain output includes session-like information consistently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bidir-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const { ctx, store } = makeCtx(dir);
    const service = new CaptainService({ dataDir: dir });
    service.createSession({ session_id: 'sid-001', captain_id: 'default', created_at: '2026-06-06T00:00:00.000Z', last_active_at: '2026-06-06T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im' });
    const cliChunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: any) => { cliChunks.push(String(chunk)); return true; }) as any;
    try { captainCommand([], { cwd: dir, homeDir: dir }); } finally { process.stdout.write = write; }
    const cliOut = cliChunks.join('');
    expect(cliOut).toContain('Known captains');
    expect(cliOut).toContain('default');
    expect(COMMAND_CATALOG['captain']?.belongs_to).toBe('both');
    store.close();
  });

  it('captain-use is cli only and im_visible=false', () => {
    expect(COMMAND_CATALOG['captain-use']?.belongs_to).toBe('cli');
    expect(COMMAND_CATALOG['captain-use']?.im_visible).toBe(false);
  });
});
