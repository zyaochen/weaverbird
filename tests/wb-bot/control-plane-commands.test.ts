import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { CodexAgent } from '../../packages/core/src/agent/codex.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { TaskIndex } from '../../apps/wb-bot/src/binding/task-index.js';
import { resetAgentListCache, runCommand } from '../../apps/wb-bot/src/commands/router.js';
import type {
  ActiveSessionSnapshot,
  ControlPlaneConfig,
  WsClientStatusSnapshot,
} from '../../apps/wb-bot/src/feishu/event-handler.js';

let dataDir = '';
let store: BindingStore;
let taskIndex: TaskIndex;
let logFilePath = '';
let wsStatus: WsClientStatusSnapshot;
let activeSnapshot: ActiveSessionSnapshot[] = [];
let stoppedCount = 0;
let cp: ControlPlaneConfig;

const registry = new DefaultAgentRegistry([
  { agent: new ClaudeCodeAgent(), command: 'claude' },
  { agent: new CodexAgent(), command: 'codex' },
]);

beforeEach(() => {
  resetAgentListCache();
  dataDir = mkdtempSync(join(tmpdir(), 'wb-bot-cp-'));
  store = new BindingStore(join(dataDir, 'wb-bot.db'));
  taskIndex = new TaskIndex(dataDir, 'default');
  logFilePath = join(dataDir, 'logs', 'default', 'wb-bot.log');
  mkdirSync(join(dataDir, 'logs', 'default'), { recursive: true });
  mkdirSync(join(dataDir, 'runs', 'default'), { recursive: true });
  wsStatus = { lastEventAt: null };
  activeSnapshot = [];
  stoppedCount = 0;
  cp = {
    botId: 'default',
    dataDir,
    taskIndex,
    logFilePath,
    wsClientStatus: () => wsStatus,
  };
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ctx() {
  return {
    userOpenId: 'u1',
    threadId: 't1',
    registry,
    store,
    botId: 'default',
    controlPlane: cp,
    activeSessions: () => activeSnapshot,
    stopAllSessions: async () => {
      stoppedCount = activeSnapshot.length;
      activeSnapshot = [];
    },
  };
}

function writeRun(runId: string, opts: { agentId: string; status: string; startedAt?: string; cwd?: string; minutesAgo?: number }): void {
  const runDir = join(dataDir, 'runs', 'default', runId);
  mkdirSync(runDir, { recursive: true });
  const startedAt = opts.startedAt ?? new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000).toISOString();
  const spec = {
    runId,
    botId: 'default',
    agentId: opts.agentId,
    cwd: opts.cwd ?? '/tmp/code',
    startedAt,
    userOpenId: 'u1',
    threadId: 't1',
  };
  writeFileSync(join(runDir, 'spec.json'), JSON.stringify(spec));
  writeFileSync(join(runDir, 'status'), opts.status);
}

describe('/status command', () => {
  it('reports zero active runs when none (W2.5-Hotfix-batch-C P1-8: session→run 术语统一)', async () => {
    const out = await runCommand('/status', ctx());
    expect(out).toContain('📊 Weaverbird Status');
    expect(out).toContain('active runs: 0');
    expect(out).toContain('(无 active run)');
    expect(out).toContain('single-bot 模式');
  });

  it('lists active runs with elapsed + heartbeat', async () => {
    activeSnapshot = [
      {
        scopeKey: 'u1:t1',
        agentId: 'claude-code',
        runId: 'r-abcdef123456789',
        startedAt: Date.now() - 60_000,
        stopState: 'running',
        terminalState: 'running',
        replyMessageId: 'm-1',
      },
    ];
    writeRun('r-abcdef123456789', { agentId: 'claude-code', status: 'running' });
    writeFileSync(join(dataDir, 'runs', 'default', 'r-abcdef123456789', 'heartbeat'), String(Math.floor(Date.now() / 1000) - 3));
    const out = await runCommand('/status', ctx());
    expect(out).toContain('active runs: 1');
    expect(out).toContain('claude-code');
    expect(out).toContain('r-abcdef1234');
    expect(out).toMatch(/heartbeat \d+s 前/);
    expect(out).toContain('status=running');
  });
});

describe('/stop-all command', () => {
  it('returns no-active when empty', async () => {
    const out = await runCommand('/stop-all', ctx());
    expect(out).toContain('当前没有 active run');
  });

  it('invokes stopAllSessions and lists each run', async () => {
    activeSnapshot = [
      { scopeKey: 'u1:t1', agentId: 'claude-code', runId: 'r-aaaaaaaaaaaa', startedAt: Date.now(), stopState: 'running', terminalState: 'running', replyMessageId: 'm-1' },
      { scopeKey: 'u1:t2', agentId: 'codex', runId: 'r-bbbbbbbbbbbb', startedAt: Date.now(), stopState: 'running', terminalState: 'running', replyMessageId: 'm-2' },
    ];
    const out = await runCommand('/stop-all', ctx());
    expect(out).toContain('已向 2 个 active run 发送 stop 信号');
    expect(out).toContain('claude-code / r-aaaaaaaaaa');
    expect(out).toContain('codex / r-bbbbbbbbbb');
    expect(stoppedCount).toBe(2);
  });
});

describe('/logs command', () => {
  it('returns empty file message when no file', async () => {
    const out = await runCommand('/logs', ctx());
    expect(out).toContain('📋 logs/default/wb-bot.log');
    expect(out).toContain('tail 50');
    expect(out).toContain('(no log lines');
  });

  it('reads last N lines', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    writeFileSync(logFilePath, lines.join('\n'));
    const out = await runCommand('/logs 10', ctx());
    expect(out).toContain('tail 10');
    expect(out).toContain('line 91');
    expect(out).toContain('line 100');
    expect(out).not.toContain('line 90');
  });

  it('accepts tail=N syntax', async () => {
    writeFileSync(logFilePath, 'a\nb\nc\nd\ne\n');
    const out = await runCommand('/logs tail=2', ctx());
    expect(out).toContain('tail 2');
    expect(out).toContain('d\ne');
  });

  it('rejects bot=<id> param (single-bot mode)', async () => {
    const out = await runCommand('/logs bot=claude', ctx());
    expect(out).toContain('❌');
    expect(out).toContain('bot=<id>');
    expect(out).toContain('multi-bot');
    expect(out).not.toMatch(/\bW2(\.\d+)?\b/);
  });

  it('rejects positional <botId> param', async () => {
    const out = await runCommand('/logs claude', ctx());
    expect(out).toContain('❌');
    expect(out).toContain('<botId>');
  });

  it('clamps tail to MAX_TAIL=500', async () => {
    const lines = Array.from({ length: 800 }, (_, i) => `L${i}`);
    writeFileSync(logFilePath, lines.join('\n'));
    const out = await runCommand('/logs 1000', ctx());
    expect(out).toContain('tail 500');
  });
});

describe('/queue-metrics command', () => {
  it('T17-happy: renders current session queue metrics snapshot', async () => {
    const out = await runCommand('/queue-metrics', {
      ...ctx(),
      queueMetricsSnapshot: () => ({
        counters: {
          captain_queue_decisions_total: 5,
          captain_queue_promotions_total: 2,
          captain_queue_preempted_runs_total: 1,
          captain_queue_cancelled_runs_total: 3,
        },
        gauges: {
          captain_queue_running_total: 1,
          captain_queue_depth: 4,
        },
        histograms: {
          captain_queue_wait_duration_seconds: {
            count: 2,
            sum: 30,
            p50: 10,
            p95: 20,
            buckets: {},
          },
        },
      }),
    });
    expect(out).toBe([
      'Queue Metrics (session)',
      '- running: 1',
      '- queued: 4',
      '- decisions_total: 5',
      '- promoted_total: 2',
      '- preempted_total: 1',
      '- cancelled_total: 3',
      '- wait_p50_s: 10',
      '- wait_p95_s: 20',
    ].join('\n'));
    expect(out).not.toContain('run_id');
    expect(out).not.toContain('message_id');
  });

  it('T18-empty: renders zeroes for missing metrics', async () => {
    const out = await runCommand('/queue-metrics', {
      ...ctx(),
      queueMetricsSnapshot: () => ({
        counters: {},
        gauges: {},
        histograms: {},
      }),
    });
    expect(out).toBe([
      'Queue Metrics (session)',
      '- running: 0',
      '- queued: 0',
      '- decisions_total: 0',
      '- promoted_total: 0',
      '- preempted_total: 0',
      '- cancelled_total: 0',
      '- wait_p50_s: 0',
      '- wait_p95_s: 0',
    ].join('\n'));
  });

  it('T19-unavailable: returns unavailable when snapshot getter is not injected', async () => {
    const out = await runCommand('/queue-metrics', ctx());
    expect(out).toBe('queue-metrics unavailable');
  });
});

describe('/health command', () => {
  it('reports 3 W2-degraded checks', async () => {
    wsStatus = { lastEventAt: Date.now() - 5_000 };
    cp = { ...cp, wsClientStatus: () => wsStatus };
    const out = await runCommand('/health', ctx());
    expect(out).toContain('🩺 Health Check (single-bot mode)');
    expect(out).toContain('WSClient');
    expect(out).toContain('SQLite');
    expect(out).toContain('磁盘');
    expect(out).toContain('quick_check ok');
    expect(out).toContain('single-bot 模式: 跨 bot 心跳检查跳过');
  });

  it('flags WSClient warn when no events ever', async () => {
    wsStatus = { lastEventAt: null };
    cp = { ...cp, wsClientStatus: () => wsStatus };
    const out = await runCommand('/health', ctx());
    expect(out).toMatch(/⚠️ WSClient.*尚未收到任何事件/);
  });

  it('trusts the connection state over event age when the SDK reports it', async () => {
    wsStatus = { lastEventAt: Date.now() - 600_000, state: 'connected', lastReconnectAt: Date.now() - 30_000, forcedReconnects: 1 };
    cp = { ...cp, wsClientStatus: () => wsStatus };
    const ok = await runCommand('/health', ctx());
    expect(ok).toMatch(/✅ WSClient.*连接正常 \(connected · 最近事件 600s 前 · 最近重连 30s 前 · 保活重建 1 次\)/);
    wsStatus = { lastEventAt: null, state: 'failed' };
    cp = { ...cp, wsClientStatus: () => wsStatus };
    expect(await runCommand('/health', ctx())).toMatch(/WSClient.*failed · 尚未收到事件/);
  });

  it('flags WSClient warn when last event >60s ago', async () => {
    wsStatus = { lastEventAt: Date.now() - 120_000 };
    cp = { ...cp, wsClientStatus: () => wsStatus };
    const out = await runCommand('/health', ctx());
    expect(out).toMatch(/⚠️ WSClient.*> 60s/);
  });
});

describe('/tasks command', () => {
  it('shows empty history with negative list', async () => {
    const out = await runCommand('/tasks', ctx());
    expect(out).toContain('📋 Task History (近 7 日');
    expect(out).toContain('tail 20');
    expect(out).toContain('未列出');
    expect(out).toContain('当前 active 任务');
  });

  it('lists history entries from runs/ scan', async () => {
    writeRun('r-aaa111aaa111', { agentId: 'claude-code', status: 'done', minutesAgo: 30 });
    writeRun('r-bbb222bbb222', { agentId: 'codex', status: 'error', minutesAgo: 60 });
    const out = await runCommand('/tasks 10', ctx());
    expect(out).toContain('claude-code');
    expect(out).toContain('codex');
    expect(out).toContain('r-aaa111aaa1');
    expect(out).toContain('done');
    expect(out).toContain('error');
  });

  it('filters by agentId', async () => {
    writeRun('r-aaa', { agentId: 'claude-code', status: 'done', minutesAgo: 10 });
    writeRun('r-bbb', { agentId: 'codex', status: 'done', minutesAgo: 20 });
    const out = await runCommand('/tasks 10 codex', ctx());
    expect(out).toContain('codex');
    expect(out).toContain('agent=codex');
    expect(out).not.toContain('claude-code');
  });

  it('rejects unknown agentId', async () => {
    const out = await runCommand('/tasks 10 unknown-agent', ctx());
    expect(out).toContain('❌');
    expect(out).toContain('unknown-agent');
  });

  it('ignores bot=<id> and shows warning', async () => {
    writeRun('r-zz', { agentId: 'claude-code', status: 'done', minutesAgo: 5 });
    const out = await runCommand('/tasks 5 bot=foo', ctx());
    expect(out).toContain('claude-code');
    expect(out).toContain('single-bot 模式忽略 bot=<id> 子参数');
    expect(out).toContain('当前仍是本 bot 视角');
    expect(out).not.toMatch(/\bW2(\.\d+)?\b/);
  });

  it('clamps N to MAX_N=100', async () => {
    const out = await runCommand('/tasks 999', ctx());
    expect(out).toContain('tail 100');
  });
});

describe('/list-bots command', () => {
  it('returns single-bot mode placeholder', async () => {
    const prevMode = process.env['WB_MODE'];
    const prevDisable = process.env['WB_DISABLE_CAPTAIN'];
    delete process.env['WB_MODE'];
    delete process.env['WB_DISABLE_CAPTAIN'];
    try {
      const out = await runCommand('/list-bots', ctx());
      expect(out).toContain('📋 已配置 bot (single-bot mode)');
      expect(out).toContain('default (Captain)');
      expect(out).toContain('claude-code');
      expect(out).toContain('在线 ✓ (本进程)');
      expect(out).toContain('multi-bot');
    } finally {
      if (prevMode === undefined) delete process.env['WB_MODE'];
      else process.env['WB_MODE'] = prevMode;
      if (prevDisable === undefined) delete process.env['WB_DISABLE_CAPTAIN'];
      else process.env['WB_DISABLE_CAPTAIN'] = prevDisable;
    }
  });
});

describe('/agents alias', () => {
  it('renders same content as /list-agents', async () => {
    const a = await runCommand('/agents', ctx());
    const b = await runCommand('/list-agents', ctx());
    expect(a).toContain('Claude Code');
    expect(b).toContain('Claude Code');
    expect(a).toBe(b);
  });
});

describe('/help mode-aware grouping (W2.5-Hotfix-batch-C P1-5)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('single mode: 列出本 bot 控制命令, 不暴露 /list-bots (multi-bot 心智)', async () => {
    delete process.env['WB_MODE'];
    const out = await runCommand('/help', ctx());
    expect(out).toContain('[核心]');
    expect(out).toContain('[本 bot 控制]');
    expect(out).toContain('/status');
    expect(out).toContain('/stop-all');
    expect(out).toContain('/logs');
    expect(out).toContain('/health');
    expect(out).toContain('/tasks');
    expect(out).toContain('/agents');
    expect(out).not.toContain('[Captain 跨 bot]');
    expect(out).not.toContain('/list-bots');
  });

  it('captain mode: 增加 [Captain 跨 bot] 分组, 包含 /list-bots', async () => {
    process.env['WB_MODE'] = 'multi-bot';
    delete process.env['WB_DISABLE_CAPTAIN'];
    const out = await runCommand('/help', ctx());
    expect(out).toContain('[核心]');
    expect(out).toContain('[本 bot 控制]');
    expect(out).toContain('[Captain 跨 bot]');
    expect(out).toContain('/list-bots');
  });

  it('multi-bot + WB_DISABLE_CAPTAIN=true: 回到 single 视图', async () => {
    process.env['WB_MODE'] = 'multi-bot';
    process.env['WB_DISABLE_CAPTAIN'] = 'true';
    const out = await runCommand('/help', ctx());
    expect(out).not.toContain('[Captain 跨 bot]');
    expect(out).not.toContain('/list-bots');
  });
});
