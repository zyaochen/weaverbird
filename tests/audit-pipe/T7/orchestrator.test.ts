import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAuditPipe } from '../../../packages/core/src/audit-pipe/index.js';

function writeConfig(dir: string, enabled = true): void {
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, 'audit-pipe.json');
  writeFileSync(path, JSON.stringify(enabled ? {
    enabled: true,
    bitable_base_id: { type: 'literal', value: 'bascn' },
    bitable_table_id: { type: 'literal', value: 'tbl' },
    app_id: { type: 'literal', value: 'cli_xxxxxxxxxxxxxxxx' },
    app_secret: { type: 'literal', value: 'secret-32-characters-000000000000' },
    lark_domain: 'https://open.larkoffice.com',
  } : { enabled: false }, null, 2));
  chmodSync(path, 0o600);
}

function writeRun(dir: string, runId: string, events = '', withSpec = true): string {
  const runDir = join(dir, 'runs', 'bot-1', runId);
  mkdirSync(runDir, { recursive: true });
  if (withSpec) {
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({
      runId,
      botId: 'bot-1',
      agentId: 'claude-code',
      userOpenId: 'ou_x',
      threadId: 'om_t',
      sourceMessageId: 'om_msg',
      replyMessageId: 'om_msg2',
      cwd: '/tmp',
      model: null,
      consentLevel: 'normal',
      startedAt: '2026-06-04T00:00:00.000Z',
      schemaVersion: 1,
      host: 'local',
    }));
  }
  writeFileSync(join(runDir, 'events.ndjson'), events);
  return runDir;
}

describe('T7 orchestrator', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns stub status when audit is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-orch-'));
    try {
      writeConfig(dir, false);
      const controller = await startAuditPipe({ configPath: join(dir, 'config', 'audit-pipe.json'), env: { WB_DATA_DIR: dir } });
      expect(controller.status().tailers).toBe(0);
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes one mirrored record from a minimal run directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-orch-'));
    try {
      writeConfig(dir, true);
      writeRun(dir, 'run-1', '{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"},"schemaVersion":1}\n');
      const controller = await startAuditPipe({
        configPath: join(dir, 'config', 'audit-pipe.json'),
        env: { WB_DATA_DIR: dir },
        _bitableClient: { bitable: { appTableRecord: { batchCreate: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec1' }] } }) } } } as any,
        _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 },
        _scanIntervalMs: 50,
        _drainIntervalMs: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const line = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim().split('\n')[0]!;
      const record = JSON.parse(line) as { action: string; entry_form: string };
      expect(record.action).toBe('file_read');
      expect(record.entry_form).toBe('im');
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers a run created after startup without reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-orch-'));
    try {
      writeConfig(dir, true);
      const batchCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec-late' }] } });
      const controller = await startAuditPipe({
        configPath: join(dir, 'config', 'audit-pipe.json'),
        env: { WB_DATA_DIR: dir },
        _bitableClient: { bitable: { appTableRecord: { batchCreate } } } as any,
        _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 },
        _scanIntervalMs: 50,
        _drainIntervalMs: 50,
      });
      expect(controller.status().tailers).toBe(0);
      writeRun(dir, 'run-late', '{"type":"tool_use","id":"late-1","name":"Read","input":{"file_path":"late.ts"},"schemaVersion":1}\n');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const lines = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { run_id: string; raw_tool_use_id: string });
      expect(lines.some((line) => line.run_id === 'run-late' && line.raw_tool_use_id === 'late-1')).toBe(true);
      expect(lines.filter((line) => line.run_id === 'run-late' && line.raw_tool_use_id === 'late-1')).toHaveLength(1);
      expect(controller.status().tailers).toBe(1);
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reload attaches a run created after startup without duplicate mirror writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-orch-'));
    try {
      writeConfig(dir, true);
      const batchCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec-reload' }] } });
      const controller = await startAuditPipe({
        configPath: join(dir, 'config', 'audit-pipe.json'),
        env: { WB_DATA_DIR: dir },
        _bitableClient: { bitable: { appTableRecord: { batchCreate } } } as any,
        _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 },
        _scanIntervalMs: 5000,
        _drainIntervalMs: 50,
      });
      writeRun(dir, 'run-reload', '{"type":"tool_use","id":"reload-1","name":"Read","input":{"file_path":"reload.ts"},"schemaVersion":1}\n');
      await controller.reload();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const lines = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { run_id: string; raw_tool_use_id: string });
      expect(lines.filter((line) => line.run_id === 'run-reload' && line.raw_tool_use_id === 'reload-1')).toHaveLength(1);
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates audit-rejected.ndjson with the shared utility without changing rejected semantics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-orch-'));
    try {
      writeConfig(dir, true);
      const rejectedPath = join(dir, 'audit-rejected.ndjson');
      writeFileSync(rejectedPath, 'x'.repeat(8 * 1024 * 1024), 'utf8');
      const runDir = join(dir, 'runs', 'bot-1', 'run-rotated');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'spec.json'), '{not valid json');
      writeFileSync(join(runDir, 'events.ndjson'), '{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"},"schemaVersion":1}\n');
      const batchCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec1' }] } });
      const controller = await startAuditPipe({ configPath: join(dir, 'config', 'audit-pipe.json'), env: { WB_DATA_DIR: dir }, _bitableClient: { bitable: { appTableRecord: { batchCreate } } } as any, _scanIntervalMs: 50, _drainIntervalMs: 50 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(`${rejectedPath}.1`)).toBe(true);
      const active = readFileSync(rejectedPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(active).toHaveLength(1);
      const mirror = JSON.parse(readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim()) as { status: string; reason: string };
      expect(mirror.status).toBe('rejected');
      expect(mirror.reason).toBe('missing_spec');
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reloads config and clears tailers when audit becomes disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-orch-'));
    try {
      writeConfig(dir, true);
      const controller = await startAuditPipe({ configPath: join(dir, 'config', 'audit-pipe.json'), env: { WB_DATA_DIR: dir } });
      writeConfig(dir, false);
      await controller.reload();
      expect(controller.status().tailers).toBe(0);
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
