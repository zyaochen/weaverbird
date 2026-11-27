import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { TaskIndex } from '../../apps/wb-bot/src/binding/task-index.js';
import { checkRunRegistry, renderHealth } from '../../apps/wb-bot/src/commands/health.js';
import type { ControlPlaneConfig } from '../../apps/wb-bot/src/feishu/event-handler.js';

let dir = '';
let store: BindingStore;
let cp: ControlPlaneConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-run-registry-health-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
  cp = {
    botId: 'default',
    dataDir: dir,
    taskIndex: new TaskIndex(dir, 'default'),
    logFilePath: join(dir, 'logs', 'default', 'wb-bot.log'),
    wsClientStatus: () => ({ lastEventAt: Date.now() - 5000 }),
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('health-sop', () => {
  it('reports not-configured when run_registry config is missing', () => {
    const result = checkRunRegistry(dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toBe('warn (not-configured)');
  });

  it('reports wal backlog warning when pending files exceed threshold', () => {
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'run-registry.json');
    writeFileSync(configPath, JSON.stringify({ bitable_base_id: 'b', bitable_table_id: 't', app_id: 'a', app_secret: 's', lark_domain: 'https://open.larkoffice.com', run_finalize_grace_ms: 30000, doc_url_allowlist: ['github.com'] }));
    chmodSync(configPath, 0o600);
    const walDir = join(dir, 'wal', 'run-registry');
    mkdirSync(walDir, { recursive: true });
    for (let i = 0; i < 150; i += 1) {
      writeFileSync(join(walDir, `run_${String(i).padStart(4, '0')}.jsonl`), '{}');
    }
    const result = checkRunRegistry(dir);
    expect(result.detail).toBe('warn (wal_backlog: 150)');
  });

  it('includes Run Registry line in /health output', async () => {
    const output = await renderHealth(cp, store);
    expect(output).toContain('Run Registry');
  });

  it('run registry setup doc exists with required keywords', () => {
    const content = readFileSync(join(process.cwd(), 'docs', 'guides', 'run-registry-setup.md'), 'utf8');
    expect(content).toContain('config.json');
    expect(content).toContain('bitable_base_id');
    expect(content).toContain('bitable_table_id');
    expect(content).toContain('字段');
  });

  it('run registry setup doc contains at least 19 schema rows plus header', () => {
    const content = readFileSync(join(process.cwd(), 'docs', 'guides', 'run-registry-setup.md'), 'utf8');
    const lines = content.split('\n').filter((line) => line.includes('|'));
    expect(lines.length).toBeGreaterThanOrEqual(20);
  });
});
