import { MuteRegistry, defaultMuteRegistryPath } from '../../../../packages/core/src/reverse-channel/index.js';
import type { CommandContext } from './router.js';
import { parseCommand } from './parser.js';

/**
 * /wb mute — session 维度静音 (PRD §2.7 反向 @ 礼仪第 4 条)
 *
 * 用法：
 *   /wb mute <sid> <duration>   — <sid> 为 sessionId 或 shortId (前 12 字符);
 *                                <duration> 支持 30s / 15m / 2h / 7d
 *   /wb mute list               — 列出当前 session 维度的有效静音
 *   /wb unmute <sid>            — 解除静音
 *
 * sessionId 解析规则：
 *   - 如果参数正好 12 位且是当前 thread 的 shortId, 自动扩展为 full sessionId
 *     (`${botId}:${userOpenId}:${threadId}`)
 *   - 否则按字面 sessionId 寻找 (允许跨 thread, owner 特权场景)
 *
 * 解析不到 sid 时 (用户没传 / 当前 thread 没 active session):
 *   返回提示, 不抛错.
 */
function resolveSessionId(sidArg: string, ctx: CommandContext): string | null {
  if (sidArg.length === 0) return null;
  // 当前 thread 的 sessionId 是权威解析
  const ownThreadSid = `${ctx.botId}:${ctx.userOpenId}:${ctx.threadId}`;
  if (sidArg === ownThreadSid) return ownThreadSid;
  // 支持 sid 前缀短写 (前 12 字符)
  if (sidArg.length === 12 && ownThreadSid.startsWith(sidArg)) return ownThreadSid;
  // 未匹配当前 thread 时仍按字面 sid 用 (owner 跨 thread mute 也需要)
  return sidArg;
}

export async function handleWbMute(args: string[], ctx: CommandContext, registry: MuteRegistry): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const items = registry.list();
    if (items.length === 0) return '当前没有静音中的 session';
    const lines = ['静音中的 session:'];
    for (const item of items) {
      const sidShort = item.sessionId.length > 24 ? `${item.sessionId.slice(0, 24)}…` : item.sessionId;
      const reasonSuffix = item.reason ? ` (${item.reason})` : '';
      lines.push(`- ${sidShort} · till ${item.expiresAtIso}${reasonSuffix}`);
    }
    return lines.join('\n');
  }
  if (sub === undefined) {
    return [
      '用法:',
      '  /wb mute <sid> <duration>   (30s/15m/2h/7d)',
      '  /wb mute list',
      '  /wb unmute <sid>',
    ].join('\n');
  }
  const sidArg = sub;
  const duration = rest[0];
  if (!duration) return '缺 duration: /wb mute <sid> <duration>';
  const sessionId = resolveSessionId(sidArg, ctx);
  if (!sessionId) return `未解析到 sessionId: ${sidArg}`;
  const result = registry.mute(sessionId, duration, { reason: `im /wb mute by ${ctx.userOpenId}` });
  if (!result.ok) return `❌ ${result.error}`;
  const sidShort = sessionId.length > 24 ? `${sessionId.slice(0, 24)}…` : sessionId;
  return `✅ 已静音 ${sidShort} 至 ${result.expiresAtIso}`;
}

export async function handleWbUnmute(args: string[], ctx: CommandContext, registry: MuteRegistry): Promise<string> {
  const [sidArg] = args;
  if (!sidArg) return '用法: /wb unmute <sid>';
  const sessionId = resolveSessionId(sidArg, ctx);
  if (!sessionId) return `未解析到 sessionId: ${sidArg}`;
  const result = registry.unmute(sessionId);
  if (!result.ok) return `未找到 ${sessionId} 的静音记录`;
  return `✅ 已解除 ${sessionId.slice(0, 24)}${sessionId.length > 24 ? '…' : ''} 的静音`;
}

export function createMuteRegistry(dataDir: string): MuteRegistry {
  return new MuteRegistry(defaultMuteRegistryPath(dataDir));
}

// parseCommand re-export to keep parity with router (single source).
export { parseCommand };
