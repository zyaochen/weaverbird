import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPeriodicTasksConfig } from '../../packages/core/src/periodic-tasks/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('periodic-tasks config', () => {
  it('loads config from config/periodic-tasks.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-periodic-cfg-'));
    roots.push(dir);
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, 'periodic-tasks.json');
    writeFileSync(path, JSON.stringify({
      enabled: true,
      tasks: [{
        task_id: 'task-1',
        owner_open_id: 'ou_owner',
        schedule: { type: 'interval', interval_ms: 60_000 },
        target: { home_group_id: 'oc_group', user_open_id: 'ou_user', cwd: '/repo' },
        run_template: { text: 'inspect {{task_id}}' },
      }],
    }, null, 2));
    chmodSync(path, 0o600);

    const config = loadPeriodicTasksConfig({ env: { WB_DATA_DIR: dir } });

    expect(config.enabled).toBe(true);
    expect(config.tasks[0]?.task_id).toBe('task-1');
  });

  it('defaults to disabled=false? actually enabled true with empty tasks safe parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-periodic-cfg-'));
    roots.push(dir);
    const config = loadPeriodicTasksConfig({ env: { WB_DATA_DIR: dir } });
    expect(config.tasks).toEqual([]);
  });
});
