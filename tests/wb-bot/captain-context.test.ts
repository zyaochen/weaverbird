import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCaptainContext } from '../../apps/wb-bot/src/captain/captain-context.js';

let root = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-captain-ctx-'));
  process.env = { ...originalEnv };
  process.env['WB_CONFIG_DIR'] = join(root, 'configs');
  process.env['WB_DATA_DIR'] = root;
  mkdirSync(join(root, 'configs'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('W2.5-Hotfix-batch-C P1-6 · resolveCaptainContext', () => {
  it('single-bot mode → enabled=false (不调 discovery)', () => {
    delete process.env['WB_MODE'];
    const ctx = resolveCaptainContext({ botId: 'default' });
    expect(ctx.enabled).toBe(false);
  });

  it('multi-bot mode + non-default bot → enabled=false', () => {
    process.env['WB_MODE'] = 'multi-bot';
    const ctx = resolveCaptainContext({ botId: 'claude' });
    expect(ctx.enabled).toBe(false);
  });

  it('multi-bot mode + WB_DISABLE_CAPTAIN=true → enabled=false', () => {
    process.env['WB_MODE'] = 'multi-bot';
    process.env['WB_DISABLE_CAPTAIN'] = 'true';
    const ctx = resolveCaptainContext({ botId: 'default' });
    expect(ctx.enabled).toBe(false);
  });

  it('multi-bot + default + 未禁用 → enabled=true, configDir + dataDir + bots 全展开', () => {
    process.env['WB_MODE'] = 'multi-bot';
    delete process.env['WB_DISABLE_CAPTAIN'];

    writeFileSync(join(root, 'configs', '.env.default'), 'BOT_ID=default\nLARK_APP_ID=cli_default\nLARK_APP_SECRET=sec\n');
    writeFileSync(join(root, 'configs', '.env.claude'), 'BOT_ID=claude\nLARK_APP_ID=cli_claude\nLARK_APP_SECRET=sec\n');

    const ctx = resolveCaptainContext({ botId: 'default' });
    expect(ctx.enabled).toBe(true);
    if (!ctx.enabled) return;
    expect(ctx.configDir).toBe(join(root, 'configs'));
    expect(ctx.dataDir).toBe(root);
    expect(ctx.bots.map((b) => b.botId).sort()).toEqual(['claude', 'default']);
  });

  it('multi-bot + default + 空 config dir → enabled=true 但 bots=[]', () => {
    process.env['WB_MODE'] = 'multi-bot';
    delete process.env['WB_DISABLE_CAPTAIN'];

    const ctx = resolveCaptainContext({ botId: 'default' });
    expect(ctx.enabled).toBe(true);
    if (!ctx.enabled) return;
    expect(ctx.bots).toEqual([]);
  });
});
