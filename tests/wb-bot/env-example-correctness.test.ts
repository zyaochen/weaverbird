import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// D5 hotfix · 锁住 apps/wb-bot/.env.example 里 wrapper 用法的正确形式.
//
// 背景: D1 (MR #39) 对齐了 wb-bot 给 codex CLI 的 argv 跟 core CodexAgent, 但
// 用户从 .env.example 复制的 `WB_CODEX_COMMAND=codex-w --model gpt-5.3-codex`
// 仍会 crash: codex-w wrapper **不认 `--model`**, 只认 codex 上层 `-c key=value`
// config override (`-c model=xxx` / `-cmodel=xxx`). args 不对就走 wrapper 内
// interactive `select_model` → 撞 no-TTY → child exit code 1, D1 argv 都没机会
// 到 codex CLI 本体. 详见 D5 MR.
//
// 这条 test 直接读 .env.example 文本, assert:
//   1. codex-w 用 `-c model=` 形式 (正确)
//   2. codex-w 不再写 `--model` 形式 (错误形式 · 锁不回退)
//   3. claude-w 仍用 `--model` 形式 (claude-w wrapper API 跟 codex-w 不同, 不动)

const envExamplePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../apps/wb-bot/.env.example',
);

describe('D5 .env.example wrapper-form correctness (claude-w / codex-w API divergence)', () => {
  const content = readFileSync(envExamplePath, 'utf8');

  it('WB_CODEX_COMMAND uses codex-w `-c model=` form (codex-w wrapper API)', () => {
    expect(content).toMatch(/^WB_CODEX_COMMAND=codex-w -c model=/m);
  });

  it('WB_CODEX_COMMAND does NOT use `codex-w --model` form (would hit no-TTY picker)', () => {
    // 锁不回退. codex-w 不识别 --model, 会走 select_model → /dev/tty → exit 1.
    expect(content).not.toMatch(/^WB_CODEX_COMMAND=codex-w --model\b/m);
  });

  it('WB_CLAUDE_COMMAND keeps `claude-w --model` form (claude-w wrapper API)', () => {
    expect(content).toMatch(/^WB_CLAUDE_COMMAND=claude-w --model /m);
  });

  it('comment block explains wrapper API divergence (claude-w vs codex-w 不是同一套)', () => {
    expect(content).toContain('claude-w');
    expect(content).toContain('codex-w');
    expect(content).toContain('-c model=');
    expect(content).toContain('不是同一套');
  });
});
