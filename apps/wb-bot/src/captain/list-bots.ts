import type { BotStatus } from './bot-discovery.js';

export function renderListBotsCard(bots: BotStatus[], captainBotId: string, now?: number): string {
  if (bots.length === 0) {
    return ['```', '📋 已配置 bot', '─────────────────────────────────────', '(无)', '─────────────────────────────────────', '```'].join('\n');
  }

  const nowMs = now ?? Date.now();
  const sorted = [...bots].sort((left, right) => {
    if (left.botId === captainBotId) return -1;
    if (right.botId === captainBotId) return 1;
    return left.botId.localeCompare(right.botId);
  });

  const lines = ['```', '📋 已配置 bot', '─────────────────────────────────────'];
  const width = Math.max(...sorted.map((bot) => (bot.botId === captainBotId ? `${bot.botId} (Captain)` : bot.botId).length), 10);

  for (const bot of sorted) {
    const isCaptain = bot.botId === captainBotId;
    const name = isCaptain ? `${bot.botId} (Captain)` : bot.botId;
    const namePadded = name.padEnd(width);
    const agents = bot.agentAllowed && bot.agentAllowed.length > 0
      ? `agents=[${bot.agentAllowed.join(', ')}]`
      : 'agents=[(unknown)]';

    let status = '离线 ✗ (无 heartbeat)';
    if (bot.online) {
      status = '在线 ✓';
    } else if (bot.lastHeartbeatAt !== null) {
      const ageSec = Math.floor((nowMs - bot.lastHeartbeatAt) / 1000);
      const ageDisplay = ageSec < 60
        ? `${ageSec}s`
        : ageSec < 3600
          ? `${Math.floor(ageSec / 60)}min`
          : `${Math.floor(ageSec / 3600)}h`;
      status = `离线 ✗ (${ageDisplay} 前)`;
    }

    lines.push(`${namePadded} · ${agents} · ${status}`);
  }

  lines.push('─────────────────────────────────────', '```');
  return lines.join('\n');
}
