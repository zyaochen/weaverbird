import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  auditMirrorPath,
  auditWalDir,
  captainQueuePath,
  captainSessionsWalDir,
  captainSocketPath,
  captainStatePath,
  runRegistryWalDir,
  runsRootDir,
} from '../../../../packages/core/src/paths.js';
import { loadRunRegistryConfig } from '../../../../packages/core/src/run-registry/config.js';
import { loadAuditPipeConfig } from '../../../../packages/core/src/audit-pipe/config.js';
import { createCaptainSessionStore } from '../../../../packages/core/src/captain/index.js';
import { createConcurrencyQueueIndex } from '../../../../packages/core/src/captain/concurrency-queue-index.js';
import { loadConcurrencyConfig } from '../../../../packages/core/src/captain/concurrency-config.js';
import type { ConcurrencyQueueEntry } from '../../../../packages/core/src/captain/concurrency-queue-store.js';
import { RUN_REGISTRY_ERROR_CODES } from '../../../../packages/core/src/run-registry/contracts.js';
import { CAPTAIN_ERROR_CODES } from '../../../../packages/core/src/captain/contracts.js';
import { readNdjsonSegments } from '../../../../packages/core/src/util/ndjson-rotation.js';
import type { BindingStore } from '../binding/store.js';
import type { BotStatus } from '../captain/bot-discovery.js';
import type { ControlPlaneConfig } from '../feishu/event-handler.js';

const WS_STALE_THRESHOLD_MS = 60_000;
const DISK_WARN_THRESHOLD_BYTES = 1024 * 1024 * 1024;
const CROSS_BOT_HB_STALE_MS = 30_000;
const AUDIT_MIRROR_STALE_MS = Number(process.env['WB_AUDIT_MIRROR_STALE_MS'] ?? 240_000);
const AUDIT_WAL_WARN_THRESHOLD = Number(process.env['WB_AUDIT_WAL_WARN_THRESHOLD'] ?? 100);
const RUN_REGISTRY_WAL_WARN_THRESHOLD = Number(process.env['WB_RUN_REGISTRY_WAL_WARN_THRESHOLD'] ?? 100);
const CAPTAIN_SESSIONS_WAL_WARN_THRESHOLD = Number(process.env['WB_CAPTAIN_SESSIONS_WAL_WARN_THRESHOLD'] ?? 100);

type CheckResult = { status: 'ok' | 'warn' | 'error'; label: string; detail: string };

function formatAgo(at: number): string {
  return `${Math.floor((Date.now() - at) / 1000)}s 前`;
}

function checkWsClient(cp: ControlPlaneConfig): CheckResult {
  const snap = cp.wsClientStatus();
  if (snap.state) {
    // 有连接状态时以它为准: 没人发消息时 "最近事件" 自然会很久, 不代表连接有问题.
    const lastEvent = snap.lastEventAt === null ? '尚未收到事件' : `最近事件 ${formatAgo(snap.lastEventAt)}`;
    const reconnect = snap.lastReconnectAt ? ` · 最近重连 ${formatAgo(snap.lastReconnectAt)}` : '';
    const forced = snap.forcedReconnects ? ` · 保活重建 ${snap.forcedReconnects} 次` : '';
    const detail = `${snap.state} · ${lastEvent}${reconnect}${forced}`;
    if (snap.state === 'connected') return { status: 'ok', label: 'WSClient', detail: `连接正常 (${detail})` };
    return { status: snap.state === 'failed' ? 'error' : 'warn', label: 'WSClient', detail };
  }
  if (snap.lastEventAt === null) {
    return { status: 'warn', label: 'WSClient', detail: '尚未收到任何事件 (服务启动后无消息)' };
  }
  const age = Date.now() - snap.lastEventAt;
  const ageS = Math.floor(age / 1000);
  if (age < WS_STALE_THRESHOLD_MS) {
    return { status: 'ok', label: 'WSClient', detail: `连接正常, 最近事件 ${ageS}s 前` };
  }
  return { status: 'warn', label: 'WSClient', detail: `最近事件 ${ageS}s 前 (> ${Math.floor(WS_STALE_THRESHOLD_MS / 1000)}s)` };
}

function checkSqlite(store: BindingStore): CheckResult {
  if (store.isReadOnly) {
    return { status: 'error', label: 'SQLite', detail: '数据库为只读模式 (migration 失败)' };
  }
  const result = store.quickCheck();
  if (result.ok) {
    return { status: 'ok', label: 'SQLite', detail: '可写 · quick_check ok' };
  }
  return { status: 'error', label: 'SQLite', detail: `quick_check 异常: ${result.error ?? 'unknown'}` };
}

function checkDisk(cp: ControlPlaneConfig): CheckResult {
  const runsDir = runsRootDir(cp.dataDir);
  if (!existsSync(runsDir)) {
    return { status: 'warn', label: '磁盘', detail: `runs/ 目录不存在 (${runsDir})` };
  }
  try {
    const stats = statfsSync(runsDir);
    const available = Number(stats.bavail) * Number(stats.bsize);
    const availableGb = (available / (1024 * 1024 * 1024)).toFixed(1);
    if (available < DISK_WARN_THRESHOLD_BYTES) {
      return { status: 'warn', label: '磁盘', detail: `runs/ 可用 ${availableGb}GB (低空间, <1GB)` };
    }
    return { status: 'ok', label: '磁盘', detail: `runs/ 可用 ${availableGb}GB` };
  } catch (err) {
    return { status: 'warn', label: '磁盘', detail: `statfs 失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function emoji(status: 'ok' | 'warn' | 'error'): string {
  return status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : '❌';
}

function checkCrossBotHeartbeats(bots: BotStatus[], nowFn?: () => number): CheckResult {
  const now = (nowFn ?? Date.now)();
  if (bots.length === 0) {
    return { status: 'ok', label: 'Worker 心跳', detail: '无其它 bot (仅 Captain 自己)' };
  }
  const stales = bots.filter((bot) => !bot.online || (bot.lastHeartbeatAt !== null && (now - bot.lastHeartbeatAt) >= CROSS_BOT_HB_STALE_MS));
  if (stales.length === 0) {
    return { status: 'ok', label: 'Worker 心跳', detail: `全部 ${bots.length} 个 bot 心跳新鲜 (< 30s)` };
  }
  const staleNames = stales.map((bot) => {
    if (bot.lastHeartbeatAt === null) return `${bot.botId} (无 heartbeat)`;
    const age = Math.floor((now - bot.lastHeartbeatAt) / 1000);
    const ageDisplay = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}min` : `${Math.floor(age / 3600)}h`;
    return `${bot.botId} (${ageDisplay} 前)`;
  }).join(', ');
  const status = stales.length === bots.length ? 'error' : 'warn';
  return { status, label: 'Worker 心跳', detail: `${stales.length}/${bots.length} bot stale: ${staleNames}` };
}

function fmtAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function checkAuditPipe(dataDir: string, nowFn?: () => number, _plistPath?: string): CheckResult {
  const plistPath = _plistPath ?? join(homedir(), 'Library', 'LaunchAgents', 'com.weaverbird.audit-pipe.plist');
  const staleMs = Number(process.env['WB_AUDIT_MIRROR_STALE_MS'] ?? AUDIT_MIRROR_STALE_MS);
  const walWarnThreshold = Number(process.env['WB_AUDIT_WAL_WARN_THRESHOLD'] ?? AUDIT_WAL_WARN_THRESHOLD);
  try {
    if (!existsSync(plistPath)) {
      return {
        status: 'warn',
        label: 'Audit Pipe',
        detail: '未安装 (可选 · 安装见 docs/guides/audit-pipe-setup.md)',
      };
    }
    const mirrorPath = auditMirrorPath(dataDir);
    const walDir = auditWalDir(dataDir);
    let walCount = 0;
    try {
      walCount = existsSync(walDir)
        ? readdirSync(walDir).filter((file) => file.endsWith('.jsonl')).length
        : 0;
    } catch {
      walCount = 0;
    }

    const mirrorLines = readNdjsonSegments(mirrorPath).length;
    if (mirrorLines === 0) {
      const wal = walCount > 0 ? ` · WAL 积压 ${walCount} 条` : '';
      return {
        status: 'warn',
        label: 'Audit Pipe',
        detail: `已安装 · 尚无审计记录 (audit-pipe 是否已运行?)${wal}`,
      };
    }

    const now = (nowFn ?? Date.now)();
    const activeMirrorExists = existsSync(mirrorPath);
    const ageMs = activeMirrorExists ? now - statSync(mirrorPath).mtimeMs : 0;
    if (activeMirrorExists && ageMs >= staleMs) {
      const wal = walCount > 0 ? ` · WAL 积压 ${walCount} 条` : '';
      return {
        status: 'warn',
        label: 'Audit Pipe',
        detail: `已安装 · mirror ${fmtAge(ageMs)} 前 (> ${Math.floor(staleMs / 1000)}s) · 可能未运行${wal}`,
      };
    }
    if (walCount >= walWarnThreshold) {
      return {
        status: 'warn',
        label: 'Audit Pipe',
        detail: `ok (最近 ${fmtAge(ageMs)}) · WAL 积压 ${walCount} 条 (≥ ${walWarnThreshold})`,
      };
    }
    return {
      status: 'ok',
      label: 'Audit Pipe',
      detail: `ok (最近 ${fmtAge(ageMs)} · ${walCount} pending)`,
    };
  } catch (err) {
    return {
      status: 'warn',
      label: 'Audit Pipe',
      detail: `检查异常: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function checkRunRegistry(dataDir: string): CheckResult {
  const walDir = runRegistryWalDir(dataDir);
  let walCount = 0;
  try {
    walCount = existsSync(walDir)
      ? readdirSync(walDir).filter((file) => file.endsWith('.jsonl')).length
      : 0;
  } catch {
    walCount = 0;
  }

  try {
    loadRunRegistryConfig({ env: { WB_DATA_DIR: dataDir } });
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === RUN_REGISTRY_ERROR_CODES.E_CFG_MISSING) {
      return { status: 'warn', label: 'Run Registry', detail: 'warn (not-configured)' };
    }
    return { status: 'warn', label: 'Run Registry', detail: `warn (config-error: ${err instanceof Error ? err.message : String(err)})` };
  }

  if (walCount >= RUN_REGISTRY_WAL_WARN_THRESHOLD) {
    return { status: 'warn', label: 'Run Registry', detail: `warn (wal_backlog: ${walCount})` };
  }
  return { status: 'ok', label: 'Run Registry', detail: `ok (${walCount} pending)` };
}

export function checkCaptainSessions(dataDir: string): CheckResult {
  const walDir = captainSessionsWalDir(dataDir);
  const mirrorPath = captainStatePath(dataDir);
  let walCount = 0;
  try {
    walCount = existsSync(walDir)
      ? readdirSync(walDir).filter((file) => file.endsWith('.jsonl')).length
      : 0;
  } catch {
    walCount = 0;
  }
  try {
    const store = createCaptainSessionStore({ env: { WB_DATA_DIR: dataDir }, _client: { bitable: { appTableField: { list: async () => ({ code: 0, msg: 'ok', data: { items: [] } }) }, appTableRecord: { search: async () => ({ code: 0, msg: 'ok', data: { items: [] } }), batchCreate: async () => ({ code: 0, msg: 'ok', data: { records: [] } }), batchUpdate: async () => ({ code: 0, msg: 'ok', data: { records: [] } }) } } } as any });
    void store;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE) {
      return { status: 'warn', label: 'Captain Sessions', detail: 'captain not configured' };
    }
    return { status: 'warn', label: 'Captain Sessions', detail: `captain config error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (walCount > CAPTAIN_SESSIONS_WAL_WARN_THRESHOLD) {
    return { status: 'warn', label: 'Captain Sessions', detail: `WAL backlog: ${walCount}` };
  }
  const mirrorLines = readNdjsonSegments(mirrorPath).length;
  if (mirrorLines > 0) {
    return { status: 'ok', label: 'Captain Sessions', detail: `${mirrorLines} sessions in mirror` };
  }
  return { status: 'ok', label: 'Captain Sessions', detail: `ok (${walCount} pending)` };
}

function readQueueEntries(dataDir: string): { entries: ConcurrencyQueueEntry[]; parseErrors: number } {
  const path = captainQueuePath(dataDir);
  const entries: ConcurrencyQueueEntry[] = [];
  let parseErrors = 0;
  for (const line of readNdjsonSegments(path)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ConcurrencyQueueEntry);
    } catch {
      parseErrors += 1;
    }
  }
  return { entries, parseErrors };
}

function formatCaptainQueueDetail(
  running: number,
  maxRunning: number,
  queued: number,
  maxQueued: number,
  parseErrors = 0,
): string {
  const counts = `running ${running}/${maxRunning} · queued ${queued}/${maxQueued}`;
  if (parseErrors > 0) return `queue parse error (${parseErrors} bad lines) · ${counts}`;
  if (running === 0 && queued === 0) return `idle · ${counts}`;
  return counts;
}

export function checkCaptainQueue(dataDir: string): CheckResult {
  const { entries, parseErrors } = readQueueEntries(dataDir);
  const config = loadConcurrencyConfig(dataDir);
  const index = createConcurrencyQueueIndex();
  index.replay(entries);
  const running = index.countRunning();
  const queued = index.countQueued();
  const detail = formatCaptainQueueDetail(running, config.max_concurrent_runs, queued, config.queue_max_depth, parseErrors);

  if (parseErrors > 0) {
    return { status: 'warn', label: 'Captain Queue', detail };
  }
  if (queued >= config.queue_max_depth && config.queue_max_depth >= 0) {
    return { status: 'warn', label: 'Captain Queue', detail };
  }
  return { status: 'ok', label: 'Captain Queue', detail };
}

export async function checkReverseChannel(dataDir: string): Promise<CheckResult> {
  const socketPath = captainSocketPath(dataDir);
  if (!existsSync(socketPath)) {
    return { status: 'warn', label: 'Reverse Channel', detail: 'socket missing' };
  }
  const mode = (statSync(socketPath).mode & 0o777).toString(8);
  if (mode !== '600') {
    return { status: 'warn', label: 'Reverse Channel', detail: `socket mode ${mode} != 600` };
  }
  const { IpcClient } = await import('../../../../packages/core/src/reverse-channel/ipc-client.js');
  const client = new IpcClient(socketPath);
  const healthRunId = `health-check-${randomUUID().slice(0, 8)}`;
  const connection = await client.openSession({ runId: healthRunId, pid: process.pid });
  try {
    const pong = await connection.send({ kind: 'ping' }, { timeoutMs: 5_000 });
    if (pong.kind !== 'pong') {
      return { status: 'warn', label: 'Reverse Channel', detail: 'ping failed' };
    }
    return { status: 'ok', label: 'Reverse Channel', detail: 'socket + ping + hello ack ready' };
  } catch (err) {
    return { status: 'warn', label: 'Reverse Channel', detail: `ipc_unreachable:${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await connection.close();
  }
}

function overall(results: CheckResult[]): 'ok' | 'warn' | 'error' {
  if (results.some((r) => r.status === 'error')) return 'error';
  if (results.some((r) => r.status === 'warn')) return 'warn';
  return 'ok';
}

export interface HealthOptions {
  cp: ControlPlaneConfig;
  store: BindingStore;
  bots?: BotStatus[];
  nowFn?: () => number;
}

export async function renderHealth(cp: ControlPlaneConfig, store: BindingStore): Promise<string>;
export async function renderHealth(opts: HealthOptions): Promise<string>;
export async function renderHealth(arg1: ControlPlaneConfig | HealthOptions, arg2?: BindingStore): Promise<string> {
  const opts: HealthOptions = 'cp' in arg1 ? arg1 : { cp: arg1, store: arg2! };
  const results: CheckResult[] = [
    checkWsClient(opts.cp),
    checkSqlite(opts.store),
    checkDisk(opts.cp),
  ];
  if (opts.bots !== undefined) {
    results.push(checkCrossBotHeartbeats(opts.bots, opts.nowFn));
  }
  results.push(checkAuditPipe(opts.cp.dataDir, opts.nowFn));
  results.push(checkRunRegistry(opts.cp.dataDir));
  results.push(checkCaptainSessions(opts.cp.dataDir));
  results.push(checkCaptainQueue(opts.cp.dataDir));
  results.push(await checkReverseChannel(opts.cp.dataDir));
  const status = overall(results);
  const lines: string[] = [];
  const suffix = opts.bots !== undefined ? ' (Captain mode)' : ' (single-bot mode)';
  lines.push(`🩺 Health Check${suffix}`);
  lines.push('─────────────────────────────────────');
  for (const r of results) {
    lines.push(`${emoji(r.status)} ${r.label}: ${r.detail}`);
  }
  lines.push('─────────────────────────────────────');
  const overallText = status === 'ok' ? '✅ 健康' : status === 'warn' ? '⚠️ 部分异常' : '❌ 异常';
  lines.push(`整体: ${overallText}`);
  if (opts.bots === undefined) {
    lines.push('(single-bot 模式: 跨 bot 心跳检查跳过)');
  }
  return lines.join('\n');
}
