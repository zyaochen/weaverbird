import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { TaskIndex } from '../../apps/wb-bot/src/binding/task-index.js';
import { checkCaptainQueue, checkCaptainSessions, renderHealth } from '../../apps/wb-bot/src/commands/health.js';
import type { ControlPlaneConfig } from '../../apps/wb-bot/src/feishu/event-handler.js';

let dir = '';
let store: BindingStore;
let cp: ControlPlaneConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-captain-health-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
  cp = {
    botId: 'default',
    dataDir: dir,
    taskIndex: new TaskIndex(dir, 'default'),
    logFilePath: join(dir, 'wb-bot.log'),
    wsClientStatus: () => ({ lastEventAt: Date.now() - 5000 }),
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('health-captain', () => {
  it('returns warn when captain config is missing', () => {
    const result = checkCaptainSessions(dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('captain not configured');
  });

  it('returns warn when WAL backlog exceeds threshold', () => {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ captain: { bitable_base_id: 'b', sessions_table_id: 't', app_id: 'a', app_secret: 's', lark_domain: 'LarkSuite', captain_state_path: join(dir, 'captain-state.ndjson'), captain_toml_path: 'captain.json' } }));
    chmodSync(configPath, 0o600);
    const walDir = join(dir, 'wal', 'captain-sessions');
    mkdirSync(walDir, { recursive: true });
    for (let i = 0; i < 101; i += 1) {
      writeFileSync(join(walDir, `s${i}.jsonl`), '{}');
    }
    const result = checkCaptainSessions(dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('WAL backlog');
  });

  it('reports mirror line count when captain-state.ndjson exists', () => {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ captain: { bitable_base_id: 'b', sessions_table_id: 't', app_id: 'a', app_secret: 's', lark_domain: 'LarkSuite', captain_state_path: join(dir, 'captain-state.ndjson'), captain_toml_path: 'captain.json' } }));
    chmodSync(configPath, 0o600);
    writeFileSync(join(dir, 'captain-state.ndjson'), '{"session":"1"}\n{"session":"2"}\n');
    const result = checkCaptainSessions(dir);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('2 sessions in mirror');
  });

  it('returns ok when queue is empty', () => {
    const result = checkCaptainQueue(dir);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('idle');
    expect(result.detail).toContain('running 0/1 · queued 0/10');
  });

  it('returns warn when queue parse errors are present', () => {
    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(join(dir, 'captain', 'queue.ndjson'), '{bad-json}\n', 'utf8');
    const result = checkCaptainQueue(dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('queue parse error');
    expect(result.detail).toContain('running 0/1 · queued 0/10');
  });

  it('returns warn when queued count reaches queue_max_depth', () => {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'captain.json'), JSON.stringify({ max_concurrent_runs: 1, queue_max_depth: 1 }), 'utf8');
    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(join(dir, 'captain', 'queue.ndjson'), '{"session_id":"s1","run_id":"run-1","status":"queued","ts":"2026-06-13T00:00:00.000Z"}\n', 'utf8');
    const result = checkCaptainQueue(dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('running 0/1 · queued 1/1');
  });

  it('renderHealth includes Captain Sessions as the 7th check family item', async () => {
    const out = await renderHealth(cp, store);
    expect(out).toContain('Captain Sessions');
    expect(out).toContain('Captain Queue');
  });

  it('captain setup doc exists with sessions schema and config fields', () => {
    const content = readFileSync(join(process.cwd(), 'docs', 'guides', 'captain-setup.md'), 'utf8');
    expect(content).toContain('sessions 表 14 字段');
    expect(content).toContain('sessions_table_id');
    expect(content).toContain('captain_state_path');
    expect(content).toContain('captain_toml_path');
  });
});
