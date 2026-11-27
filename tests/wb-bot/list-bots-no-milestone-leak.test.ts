// W2.5-Hotfix-batch-D D3 / D4 · Regression guards for user-facing internal-terminology leaks.
//
// Five classes of leaks this guards against:
//   1. /list-bots single-mode footer must not contain internal milestone names ("W2", "W2.5").
//   2. completion-push user text must not contain the AgentEvent internal type literal "done".
//   3. card-renderer terminal-state badge must not contain the AgentEvent internal type literal "done".
//   4. (D4) /tasks bot=<id> ignored-warning footer must not contain "W2" / "W2.5".
//   5. (D4) /logs bot=<id> rejection text must not contain "W2" / "W2.5".
//
// What is intentionally NOT guarded (内部 contract, 不能动):
//   - AgentEvent.type === 'done' 判定逻辑 (event-handler.ts / stream-state.ts)
//   - StreamState.terminalState === 'done' 状态机字面值
//   - admin-alerts.ndjson 文件名 / 写入 schema (内部 audit log)
//   - sendAdminAlert 函数名 / module 名
//   - 测试代码自身的 describe/it 标题 (这些是 dev-facing, 非用户面)

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { TaskIndex } from '../../apps/wb-bot/src/binding/task-index.js';
import { resetAgentListCache, runCommand } from '../../apps/wb-bot/src/commands/router.js';
import type { ControlPlaneConfig } from '../../apps/wb-bot/src/feishu/event-handler.js';
import {
  formatCompletionMessage,
} from '../../apps/wb-bot/src/feishu/completion-push.js';
import { renderCard } from '../../apps/wb-bot/src/feishu/card-renderer.js';
import { createInitialState } from '../../apps/wb-bot/src/feishu/stream-state.js';

let root = '';
let store: BindingStore;
let cp: ControlPlaneConfig;

const registry = new DefaultAgentRegistry([
  { agent: new ClaudeCodeAgent(), command: 'claude' },
]);

beforeEach(() => {
  resetAgentListCache();
  root = mkdtempSync(join(tmpdir(), 'wb-d3-leak-'));
  store = new BindingStore(join(root, 'wb-bot.db'));
  mkdirSync(join(root, 'logs', 'default'), { recursive: true });
  mkdirSync(join(root, 'runs', 'default'), { recursive: true });
  cp = {
    botId: 'default',
    dataDir: root,
    taskIndex: new TaskIndex(root, 'default'),
    logFilePath: join(root, 'logs', 'default', 'wb-bot.log'),
    wsClientStatus: () => ({ lastEventAt: null }),
  };
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env['WB_MODE'];
  delete process.env['WB_DISABLE_CAPTAIN'];
});

describe('D3 · /list-bots single-mode 不泄漏内部 milestone 名', () => {
  it('单 bot 默认模式 footer 不含 "W2" / "W2.5" / 未来语', async () => {
    delete process.env['WB_MODE'];
    delete process.env['WB_DISABLE_CAPTAIN'];
    const out = await runCommand('/list-bots', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
    });
    expect(out).toBeTypeOf('string');
    // 文案 user-friendly: 仍标明 single-bot mode + multi-bot 启用后的展望, 但不带内部 milestone 名.
    expect(out).toContain('single-bot mode');
    expect(out).toContain('multi-bot');
    // milestone 名 leak guard.
    expect(out).not.toMatch(/\bW2(\.\d+)?\b/);
    expect(out).not.toContain('W2 阶段');
    expect(out).not.toContain('W2.5 启用');
  });

  it('multi-bot + WB_DISABLE_CAPTAIN=true 回 single 视图时也不泄漏 milestone 名', async () => {
    process.env['WB_MODE'] = 'multi-bot';
    process.env['WB_DISABLE_CAPTAIN'] = 'true';
    const out = await runCommand('/list-bots', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
    });
    expect(out).toBeTypeOf('string');
    expect(out).not.toMatch(/\bW2(\.\d+)?\b/);
  });
});

describe('D3 · completion push 用户文本不泄漏内部 AgentEvent type 字面值', () => {
  it('formatCompletionMessage 输出不含字面 "done"', () => {
    const msg = formatCompletionMessage('Claude Code', '/Users/test/code', 360_000);
    // user-friendly 替代项必须存在.
    expect(msg).toContain('✅');
    expect(msg).toContain('任务完成');
    // 字面 "done" 不再出现.
    expect(msg).not.toContain('done');
  });
});

describe('D3 · card-renderer 用户卡片不泄漏内部 AgentEvent type 字面值', () => {
  it('terminalState=done 状态徽章文本不含字面 "done"', () => {
    const card = renderCard({
      ...createInitialState('claude-code', 'Claude Code', 'Claude Code'),
      terminalState: 'done',
    }) as { header: { title: { content: string } } };
    // user-friendly 替代项: "✅ 完成".
    expect(card.header.title.content).toContain('✅ 完成');
    // 字面 "done" 不再出现在徽章里 (badge 行).
    const badgeLine = card.header.title.content.split('\n')[1] ?? '';
    expect(badgeLine).not.toContain('done');
  });
});

describe('D4 · /tasks 和 /logs 用户面文本不泄漏内部 milestone 名', () => {
  function ctx() {
    return {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: cp,
      activeSessions: () => [],
      stopAllSessions: async () => {},
    };
  }

  it('/tasks bot=<id> ignored 警告文案不含 "W2" / "W2.5"', async () => {
    const out = await runCommand('/tasks 5 bot=foo', ctx());
    expect(out).toContain('single-bot 模式忽略 bot=<id> 子参数');
    expect(out).not.toMatch(/\bW2(\.\d+)?\b/);
    expect(out).not.toContain('W2 启用');
    expect(out).not.toContain('W2.5 启用');
  });

  it('/tasks 默认 footer "用 /logs 查" 行不含 milestone 名', async () => {
    const out = await runCommand('/tasks', ctx());
    expect(out).toContain('用 /logs 查');
    expect(out).not.toMatch(/\bW2(\.\d+)?\b/);
  });

  it('/logs bot=<id> 拒绝文案不含 "W2" / "W2.5"', async () => {
    const out = await runCommand('/logs bot=claude', ctx());
    expect(out).toContain('❌');
    expect(out).toContain('bot=<id>');
    expect(out).toContain('multi-bot');
    expect(out).not.toMatch(/\bW2(\.\d+)?\b/);
  });

  it('/logs 位置参数 <botId> 拒绝文案不含 "W2" / "W2.5"', async () => {
    const out = await runCommand('/logs claude', ctx());
    expect(out).toContain('❌');
    expect(out).toContain('<botId>');
    expect(out).not.toMatch(/\bW2(\.\d+)?\b/);
  });
});
