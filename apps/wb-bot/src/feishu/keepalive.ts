/**
 * 长连接保活. SDK 自己会断线重连, 但遇到过两类它兜不住的情况:
 * - 笔记本合盖 / 进程被挂起后醒来, socket 早死了, SDK 状态还停在 connected 或卡在 reconnecting
 * - 重连循环用尽次数后进入 failed, 不再尝试
 *
 * 做法 (参照 notebook bot 的 auto_reconnect):
 * - 15s 独立定时器读 `getConnectionStatus()`
 * - 两次 tick 间隔远超 15s → 判定刚从睡眠醒来, 本轮只重置计数 (睡前的状态不可信)
 * - 连续 3 次不是 connected, 且 HTTP 能连到飞书 (排除整机断网) → 重建 WSClient
 */

export const KEEPALIVE_INTERVAL_MS = 15_000;
const SLEEP_DETECT_MS = 30_000;
const TIMER_STORM_GUARD_MS = 5_000;
const DEAD_THRESHOLD = 3;

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type KeepaliveDeps = {
  connectionState(): ConnectionState | undefined;
  /** 飞书域名能否 HTTP 访问; 不能访问说明是网络问题, 重建连接也没用. */
  probe(): Promise<boolean>;
  forceReconnect(): Promise<void>;
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  now?: () => number;
};

export class Keepalive {
  private lastTick = 0;
  private consecutiveDown = 0;
  private networkDown = false;
  private timer: NodeJS.Timeout | null = null;
  forcedReconnects = 0;
  lastForcedReconnectAt: number | null = null;

  constructor(private readonly deps: KeepaliveDeps) {}

  start(intervalMs = KEEPALIVE_INTERVAL_MS): void {
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => this.deps.logger.warn({ error }, 'keepalive tick failed'));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const sinceLast = this.lastTick > 0 ? now - this.lastTick : 0;
    // 醒来时积压的 interval 会背靠背触发, 只认第一个.
    if (sinceLast > 0 && sinceLast < TIMER_STORM_GUARD_MS) return;
    this.lastTick = now;
    if (sinceLast > SLEEP_DETECT_MS) {
      this.deps.logger.info({ sleptMs: sinceLast }, 'keepalive detected wake-up, resetting counters');
      this.consecutiveDown = 0;
      return;
    }
    const state = this.deps.connectionState();
    if (!state || state === 'idle' || state === 'connected') {
      if (this.consecutiveDown > 0) this.deps.logger.info({ afterTicks: this.consecutiveDown }, 'feishu ws recovered');
      this.consecutiveDown = 0;
      this.networkDown = false;
      return;
    }
    if (!(await this.deps.probe())) {
      if (!this.networkDown) this.deps.logger.warn({ state }, 'feishu unreachable over http, waiting for network');
      this.networkDown = true;
      this.consecutiveDown = 0;
      return;
    }
    this.networkDown = false;
    this.consecutiveDown += 1;
    this.deps.logger.warn({ state, consecutiveDown: this.consecutiveDown }, 'feishu ws not connected');
    if (this.consecutiveDown < DEAD_THRESHOLD) return;
    this.consecutiveDown = 0;
    this.forcedReconnects += 1;
    this.lastForcedReconnectAt = now;
    this.deps.logger.warn({ state }, 'feishu ws stuck, rebuilding client');
    await this.deps.forceReconnect();
  }
}

export async function httpProbe(url: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return response.status > 0;
  } catch {
    // 超时 / DNS / 连接拒绝都按不可达处理, 由调用方记日志.
    return false;
  }
}
