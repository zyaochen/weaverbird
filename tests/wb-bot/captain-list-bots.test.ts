import { describe, expect, it } from 'vitest';
import { renderListBotsCard } from '../../apps/wb-bot/src/captain/list-bots.js';

describe('renderListBotsCard', () => {
  it('puts captain first and sorts remaining bots alphabetically', () => {
    const out = renderListBotsCard([
      { botId: 'codex', online: true, lastHeartbeatAt: 1, configPath: '/tmp/.env.codex', agentAllowed: ['codex'] },
      { botId: 'default', online: true, lastHeartbeatAt: 1, configPath: '/tmp/.env.default', agentAllowed: ['claude-code', 'codex'] },
      { botId: 'claude', online: true, lastHeartbeatAt: 1, configPath: '/tmp/.env.claude', agentAllowed: ['claude-code'] },
    ], 'default', 10_000);

    const defaultIndex = out.indexOf('default (Captain)');
    const claudeIndex = out.indexOf('claude');
    const codexIndex = out.indexOf('codex');
    expect(defaultIndex).toBeGreaterThan(-1);
    expect(defaultIndex).toBeLessThan(claudeIndex);
    expect(claudeIndex).toBeLessThan(codexIndex);
    expect(out).toContain('在线 ✓');
    expect(out.startsWith('```\n📋 已配置 bot')).toBe(true);
  });

  it('renders offline age in minutes', () => {
    const out = renderListBotsCard([
      { botId: 'mira', online: false, lastHeartbeatAt: 0, configPath: '/tmp/.env.mira', agentAllowed: ['mira-cli'] },
    ], 'default', 600_000);
    expect(out).toContain('离线 ✗ (10min 前)');
  });

  it('renders missing heartbeat explicitly', () => {
    const out = renderListBotsCard([
      { botId: 'codex', online: false, lastHeartbeatAt: null, configPath: '/tmp/.env.codex', agentAllowed: ['codex'] },
    ], 'default');
    expect(out).toContain('离线 ✗ (无 heartbeat)');
  });

  it('renders empty placeholder when no bots are configured', () => {
    const out = renderListBotsCard([], 'default');
    expect(out).toContain('(无)');
  });

  it('still respects defensive non-default captainBotId ordering', () => {
    const out = renderListBotsCard([
      { botId: 'default', online: true, lastHeartbeatAt: 1, configPath: '/tmp/.env.default', agentAllowed: ['claude-code'] },
      { botId: 'claude', online: true, lastHeartbeatAt: 1, configPath: '/tmp/.env.claude', agentAllowed: ['claude-code'] },
    ], 'claude', 10_000);
    expect(out.indexOf('claude (Captain)')).toBeLessThan(out.indexOf('default'));
  });
});
