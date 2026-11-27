import { randomUUID } from 'node:crypto';
import {
  loadGroupSyncConfig,
  syncGroupCommand,
  createMockGroupSyncTransport,
} from '../../../../packages/core/src/group-sync/index.js';
import type { GroupSyncCommandReceived } from '../../../../packages/core/src/group-sync/contracts.js';
import type { CommandContext } from './router.js';

/**
 * `/wb sync` 命令 handler（M11-C C3）。
 * PRD §5.1 中 F8-F12 触发面在 IM；这里把 group-sync 已有 service 接到 IM slash:
 *
 *   /wb sync                        — 手动触发一次 sync
 *   /wb sync dry                    — run sync 但不真正写 mock transport 状态(留接口)
 *
 * 当前用 mock transport 兜底 (没有真正的 IM 群转发通道，不引入新 dispatch surface)。
 * 后续如需真实 sendCard 到其他群,在 `transport` 里换 guarded / 新建 Lark transport。
 */
export async function handleWbSync(args: string[], ctx: CommandContext): Promise<string> {
  // 必需的 controlPlane.dataDir 是 group-sync state 的落点.
  const dataDir = ctx.controlPlane?.dataDir;
  if (!dataDir) {
    return '⚠️ /wb sync 不可用 (control plane 未启动)';
  }
  const config = loadGroupSyncConfig({ env: { WB_DATA_DIR: dataDir } });
  if (!config.enabled) {
    return [
      '⚠️ group-sync 未启用',
      `当前 transport=${config.transport}`,
      '要开启,在 `config/group-sync.json` 或 legacy `config.json` 里把 `group_sync.enabled` 设为 true',
    ].join('\n');
  }

  const sub = args[1] ?? 'run';
  if (sub !== 'run') {
    return 'Usage: /wb sync run';
  }

  const runId = `run-wb-sync-${randomUUID().slice(0, 8)}`;
  const command: GroupSyncCommandReceived = {
    request_id: `req-${randomUUID()}`,
    session_id: `${ctx.botId}:${ctx.userOpenId}:${ctx.threadId}`,
    run_id: runId,
    revision: 0,
    text: `/wb sync ${sub}`,
    scheduled_at: new Date().toISOString(),
    user_open_id: ctx.userOpenId,
    thread_id: ctx.threadId,
    message_id: runId,
  };

  const result = await syncGroupCommand({
    dataDir,
    botId: ctx.botId,
    command,
    config,
    transport: createMockGroupSyncTransport(dataDir),
  });

  if (result.sync_failed) {
    return `❌ sync 失败: ${result.state.last_error ?? 'unknown'}`;
  }
  return [
    `✅ sync 已开始 (run_id=${runId})`,
    `session=${command.session_id}`,
    `state.last_synced_at=${result.state.last_synced_at ?? '-'}`,
  ].join('\n');
}
