import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveSessionSnapshot, ControlPlaneConfig } from '../feishu/event-handler.js';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function readHeartbeat(runDir: string): number | null {
  const path = join(runDir, 'heartbeat');
  if (!existsSync(path)) return null;
  try {
    const ts = parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (!Number.isFinite(ts)) return null;
    return ts * 1000;
  } catch {
    return null;
  }
}

function readStatusFile(runDir: string): string | null {
  const path = join(runDir, 'status');
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

export function renderStatus(sessions: ActiveSessionSnapshot[], cp?: ControlPlaneConfig): string {
  const now = Date.now();
  const ts = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
  const lines: string[] = [];
  lines.push(`📊 Weaverbird Status (single-bot mode, ${ts})`);
  lines.push('─────────────────────────────────────');

  if (sessions.length === 0) {
    lines.push('active runs: 0');
    lines.push('(无 active run)');
  } else {
    lines.push(`active runs: ${sessions.length}`);
    for (const session of sessions) {
      const runShort = session.runId ? session.runId.slice(0, 12) : '(no run)';
      const elapsed = formatElapsed(now - session.startedAt);
      const sessionIdPart = session.sessionShortId ? `#${session.sessionShortId} · ` : '';
      const parts = [
        `- ${session.agentId} · ${sessionIdPart}${runShort} · ${elapsed}`,
      ];
      if (cp && session.runId) {
        const runDir = join(cp.dataDir, 'runs', cp.botId, session.runId);
        const hbMs = readHeartbeat(runDir);
        if (hbMs !== null) {
          const age = Math.floor((now - hbMs) / 1000);
          parts.push(`heartbeat ${age}s 前`);
        }
        const statusValue = readStatusFile(runDir);
        if (statusValue) {
          parts.push(`status=${statusValue}`);
        }
      }
      parts.push(`state=${session.terminalState}/${session.stopState}`);
      lines.push(parts.join(' · '));
    }
  }
  lines.push('─────────────────────────────────────');
  lines.push('(single-bot 模式: 仅显示本进程 active runs)');
  return lines.join('\n');
}
