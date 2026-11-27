import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startAuditPipe } from '../../../packages/core/src/audit-pipe/index.js';

function writeConfig(dir: string): void {
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, 'audit-pipe.json');
  writeFileSync(path, JSON.stringify({
    enabled: true,
    bitable_base_id: { type: 'literal', value: 'bascn' },
    bitable_table_id: { type: 'literal', value: 'tbl' },
    app_id: { type: 'literal', value: 'cli_xxxxxxxxxxxxxxxx' },
    app_secret: { type: 'literal', value: 'secret-32-characters-000000000000' },
    lark_domain: 'https://open.larkoffice.com',
  }, null, 2));
  chmodSync(path, 0o600);
}

function setupRun(dataDir: string, runId: string, events: string, withSpec = true): void {
  const runDir = join(dataDir, 'runs', 'bot-1', runId);
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
}

describe('T8 E2E acceptance', () => {
  it('F1: mirror preserves tool_use timeline order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    try {
      writeConfig(dir);
      setupRun(dir, 'run-1', [
        '{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"},"schemaVersion":1}',
        '{"type":"text","delta":"hi","schemaVersion":1}',
        '{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"},"schemaVersion":1}',
        '{"type":"tool_use","id":"t3","name":"Write","input":{"file_path":"b.ts"},"schemaVersion":1}',
      ].join('\n') + '\n');
      const controller = await startAuditPipe({ configPath: join(dir, 'config', 'audit-pipe.json'), env: { WB_DATA_DIR: dir }, _bitableClient: { bitable: { appTableRecord: { batchCreate: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec1' }] } }) } } } as any, _scanIntervalMs: 50, _drainIntervalMs: 50 });
      await new Promise((resolve) => setTimeout(resolve, 800));
      const records = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { raw_tool_use_id: string });
      expect(records.map((record) => record.raw_tool_use_id)).toEqual(['t1', 't2', 't3']);
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F2: env_access stays separate from shell_exec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    try {
      writeConfig(dir);
      setupRun(dir, 'run-2', '{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo $HOME"},"schemaVersion":1}\n');
      const controller = await startAuditPipe({ configPath: join(dir, 'config', 'audit-pipe.json'), env: { WB_DATA_DIR: dir }, _bitableClient: { bitable: { appTableRecord: { batchCreate: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec1' }] } }) } } } as any, _scanIntervalMs: 50, _drainIntervalMs: 50 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const line = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim();
      expect(JSON.parse(line).action).toBe('env_access');
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F3: unreadable spec writes rejected outputs and does not call Bitable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    try {
      writeConfig(dir);
      const runDir = join(dir, 'runs', 'bot-1', 'run-3');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'spec.json'), '{not valid json');
      writeFileSync(join(runDir, 'events.ndjson'), '{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"},"schemaVersion":1}\n');
      const batchCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec1' }] } });
      const controller = await startAuditPipe({ configPath: join(dir, 'config', 'audit-pipe.json'), env: { WB_DATA_DIR: dir }, _bitableClient: { bitable: { appTableRecord: { batchCreate } } } as any, _scanIntervalMs: 50, _drainIntervalMs: 50 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(join(dir, 'audit-rejected.ndjson'))).toBe(true);
      expect(batchCreate).not.toHaveBeenCalled();
      const mirror = JSON.parse(readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim()) as { status: string; reason: string };
      expect(mirror.status).toBe('rejected');
      expect(mirror.reason).toBe('missing_spec');
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F4: queued WAL entries replay after Bitable recovers without data loss', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    try {
      writeConfig(dir);
      setupRun(dir, 'run-4', [
        '{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"},"schemaVersion":1}',
        '{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"},"schemaVersion":1}',
      ].join('\n') + '\n');
      let failing = true;
      const batchCreate = vi.fn().mockImplementation(async () => {
        if (failing) throw new Error('HTTP 503 Service Unavailable');
        return { code: 0, msg: 'success', data: { records: [{ record_id: 'rec1' }] } };
      });
      const controller = await startAuditPipe({
        configPath: join(dir, 'config', 'audit-pipe.json'),
        env: { WB_DATA_DIR: dir },
        _bitableClient: { bitable: { appTableRecord: { batchCreate } } } as any,
        _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 },
        _scanIntervalMs: 50,
        _drainIntervalMs: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(readdirSync(join(dir, 'wal', 'audit')).length).toBeGreaterThanOrEqual(2);
      failing = false;
      await controller.reload();
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(readdirSync(join(dir, 'wal', 'audit'))).toHaveLength(0);
      const delivered = new Set(batchCreate.mock.calls.flatMap((call) => (call[0].data.records ?? []).map((record: { fields: { raw_tool_use_id: string } }) => record.fields.raw_tool_use_id)));
      expect(delivered.has('t1')).toBe(true);
      expect(delivered.has('t2')).toBe(true);
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F5: orchestrator discovers a run created after startup and mirrors it once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    try {
      writeConfig(dir);
      const batchCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec-late' }] } });
      const controller = await startAuditPipe({ configPath: join(dir, 'config', 'audit-pipe.json'), env: { WB_DATA_DIR: dir }, _bitableClient: { bitable: { appTableRecord: { batchCreate } } } as any, _scanIntervalMs: 50, _drainIntervalMs: 50 });
      setupRun(dir, 'run-late', '{"type":"tool_use","id":"late-1","name":"Read","input":{"file_path":"late.ts"},"schemaVersion":1}\n');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const records = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { run_id: string; raw_tool_use_id: string });
      expect(records.filter((record) => record.run_id === 'run-late' && record.raw_tool_use_id === 'late-1')).toHaveLength(1);
      await controller.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
