import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolveDataDir, auditMirrorPath, approvalGateDir, approvalRequestsPath } from '../../../../packages/core/src/paths.js';
import type { CommandContext } from './router.js';

/**
 * M13-F (2026-08-04 owner-authorized): IM 侧 audit 平价。
 * `/wb audit [--limit N] [--session-id SID]` 打本机 audit-mirror 最近 N 行。
 * 与 wb-cli audit 共享同一份读取路径,不回远端不发起新 audit 调用。
 */
export function handleWbAudit(args: string[], ctx: CommandContext): string {
  const limit = Number.parseInt(args[args.indexOf('--limit') + 1] ?? '', 10) || 20;
  const sessionIdx = args.indexOf('--session-id');
  const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;

  const dataDir = ctx.controlPlane?.dataDir;
  if (!dataDir) return '⚠️ /wb audit 不可用 (control plane 未启动)';

  const mirror = auditMirrorPath(dataDir);
  if (!existsSync(mirror)) return '(audit mirror 还没生成)';

  const lines = readFileSync(mirror, 'utf8').split('\n').filter(Boolean);
  const kept: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (sessionId && record['session_id'] !== sessionId) continue;
      kept.push(record);
      if (kept.length >= limit) break;
    } catch {
      continue;
    }
  }
  if (kept.length === 0) return '(audit mirror 空)';

  return [
    `🧾 最近 ${kept.length} 条 audit (mirror=${mirror})`,
    ...kept.reverse().map((record) => [
      String(record['ts'] ?? '-'),
      String(record['agent_id'] ?? '-'),
      String(record['action'] ?? '-'),
      record['env_filter_hit'] ? 'env' : '',
      String(record['run_id'] ?? '-'),
      String(record['resource'] ?? '-'),
    ].filter(Boolean).join(' · ')),
  ].join('\n');
}
