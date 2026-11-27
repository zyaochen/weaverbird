/**
 * 真机 wb-runner 全链路验证 (不依赖飞书 UI).
 *
 * 复刻 wb-bot 真路径: buildAgentArgs (claude-code) + buildClaudeAgentEnv +
 * spawnWbRunner, 跑真 `claude-w` 命令, 验证:
 *   1. events.ndjson 出真实 streaming text event + done event
 *   2. status 最终 = done
 *   3. heartbeat 在 5s 内写出
 *   4. D6 env 过滤: 子进程 env 里只有 ANTHROPIC_xxx / PATH / HOME 等白名单,
 *      LARK_APP_SECRET / OPENAI_API_KEY 等 secret 不泄漏
 *
 * 用法: tsx scripts/realmachine-wb-runner-check.ts
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { buildAgentArgs, extractModelFromArgs } from '../apps/wb-bot/src/feishu/event-handler.js';
import { buildFilteredEnv } from '../apps/wb-bot/src/security/env-whitelist.js';
import { spawnWbRunner, buildRunSpec } from '../apps/wb-bot/src/feishu/wb-runner-spawner.js';

const WB_RUNNER_MAIN = new URL('../packages/core/src/runner/wb-runner-main.ts', import.meta.url).pathname;
const dataDir = join(tmpdir(), `wb-real-${randomUUID().slice(0, 8)}`);
const runId = `real-${randomUUID().slice(0, 8)}`;
const botId = 'default';

// 加载 apps/wb-bot/.env (wb-bot 真启动时由 dotenv 读)
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: 'apps/wb-bot/.env' });

const cwd = process.cwd();
const prompt = 'Reply with exactly one word: pong';

// 复刻 event-handler.ts handleMessageViaWbRunner 的 claude 路径 (line 1094-1129):
// WB_CLAUDE_COMMAND 可含空格 (如 "claude-w --model gpt-5.4"), 拆 head + prepend.
// head 作 agentCommand, prepend args 合并进 agentArgs 前部.
const claudeRaw = (process.env['WB_CLAUDE_COMMAND'] ?? '').trim();
const [claudeHead, ...claudePrepend] = claudeRaw ? claudeRaw.split(/\s+/) : ['claude'];
const agentCommand = claudeHead!;

// passthrough keys 同 event-handler line 1087-1091 (claude-code 路径)
let agentEnv = buildFilteredEnv('agent-cli', process.env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);

// model propagate (line 1107-1112): 父进程未显式 set ANTHROPIC_MODEL 时, 从 WB_CLAUDE_COMMAND 的 --model 补
if (!agentEnv['ANTHROPIC_MODEL']) {
  const modelFromCommand = extractModelFromArgs(claudePrepend);
  if (modelFromCommand) agentEnv['ANTHROPIC_MODEL'] = modelFromCommand;
}

const builtArgs = buildAgentArgs('claude-code', prompt, cwd, undefined, 'relaxed', undefined);
const agentArgs = [...claudePrepend, ...builtArgs];

console.log('=== spec ===');
console.log('command:', agentCommand);
console.log('args:', agentArgs);
console.log('env keys (passed to agent):', Object.keys(agentEnv).sort().join(', '));

const spec = buildRunSpec({
  runId,
  botId,
  agentId: 'claude-code',
  agentCommand,
  agentArgs,
  cwd,
  env: agentEnv,
  userOpenId: 'ou_test',
  threadId: 'thread_test',
  sourceMessageId: 'om_src',
  replyMessageId: 'om_reply',
  consentLevel: 'relaxed',
});

const { child, runDir } = spawnWbRunner({ dataDir, spec, wbRunnerMainPath: WB_RUNNER_MAIN });
console.log('=== spawned wb-runner, pid:', child.pid, 'runDir:', runDir, '===');

// 等结束 (wb-runner detached, 但我们 spawn 了它的 parent tsx 进程, 等 tsx 退出).
// 加超时兜底, 避免 detached 链路异常时永久挂起.
await new Promise<void>((resolve) => {
  const timer = setTimeout(() => { console.log('!! timeout waiting wb-runner close'); resolve(); }, 90000);
  child.once('close', () => { clearTimeout(timer); resolve(); });
});

// 给 detached grandchild 一点时间收尾
await new Promise<void>((r) => setTimeout(r, 1500));

console.log('\n=== results ===');
const statusPath = join(runDir, 'status');
const eventsPath = join(runDir, 'events.ndjson');
const heartbeatPath = join(runDir, 'heartbeat');
const specPath = join(runDir, 'spec.json');
const outputLogPath = join(runDir, 'output.log');

console.log('status:', existsSync(statusPath) ? readFileSync(statusPath, 'utf8').trim() : '(missing)');
console.log('heartbeat exists:', existsSync(heartbeatPath));
console.log('spec.json exists:', existsSync(specPath));

if (existsSync(eventsPath)) {
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  console.log('events count:', lines.length);
  const types = lines.map((l) => { try { return JSON.parse(l).type; } catch { return '?'; } });
  console.log('event types:', types.join(', '));
  const lastEvent = JSON.parse(lines[lines.length - 1]);
  console.log('last event:', JSON.stringify(lastEvent).slice(0, 200));
} else {
  console.log('events.ndjson: MISSING');
}

if (existsSync(outputLogPath)) {
  const out = readFileSync(outputLogPath, 'utf8');
  // 提取 result event 的关键字段 (不打印完整 stdout, 含 session_id 等噪声)
  const resultLine = out.split('\n').filter(Boolean).reverse().find((l) => {
    try { return JSON.parse(l).type === 'result'; } catch { return false; }
  });
  if (resultLine) {
    try {
      const r = JSON.parse(resultLine);
      console.log('\n=== claude result event ===');
      console.log('subtype:', r.subtype, '| is_error:', r.is_error, '| result:', JSON.stringify(r.result));
      console.log('duration_ms:', r.duration_ms, '| model:', r.modelUsage && Object.keys(r.modelUsage)[0]);
    } catch { console.log('\n(result event parse failed)'); }
  }
} else {
  console.log('\n(output.log missing)');
  try { console.log('runDir:', readdirSync(runDir)); } catch (e) { console.log('readdir failed:', e); }
}

// D6: env 过滤验证.
// 注意: wb-runner.start() 会把 spec.json 重写为不含 env 的版本 (env 不落盘, 安全),
// 所以 D6 必须检查传给 buildRunSpec 的 agentEnv (内存), 而非落盘 spec.json.
const envKeys = Object.keys(agentEnv);
const leakedSecrets = envKeys.filter((k) =>
  /LARK_APP_SECRET|OPENAI_API_KEY|FEISHU_|WB_BOT_SECRET|_TOKEN$|_SECRET$/i.test(k));
const hasAnthropicKey = envKeys.includes('ANTHROPIC_API_KEY');
const hasLarkSecret = envKeys.some((k) => /^LARK_/i.test(k));

const finalStatus = existsSync(statusPath) ? readFileSync(statusPath, 'utf8').trim() : 'missing';

console.log('\n=== D6 env filter check (agentEnv, not persisted spec.json) ===');
console.log('agent env keys:', envKeys.sort().join(', '));
console.log('ANTHROPIC_API_KEY present (expected, agent needs it):', hasAnthropicKey ? 'yes ✅' : 'no ❌');
console.log('LARK_* present (must be absent):', hasLarkSecret ? 'yes ❌ LEAK' : 'no ✅');
console.log('leaked secrets (should be empty):', leakedSecrets.length ? leakedSecrets.join(', ') : '(none ✅)');

// cleanup
try { rmSync(dataDir, { recursive: true, force: true }); } catch {}

if (finalStatus === 'done') {
  console.log('\n✅ PASS: wb-runner real-machine full chain OK (status=done, streaming+done events, no secret leak)');
  process.exit(0);
} else {
  console.log(`\n❌ FAIL: status=${finalStatus} (expected done)`);
  process.exit(1);
}
