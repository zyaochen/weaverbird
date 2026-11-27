import { describe, expect, it } from 'vitest';
import { buildAgentArgs, stripModelArgs } from '../../apps/wb-bot/src/feishu/event-handler.js';

// D1 hotfix · 验证 wb-bot 给 codex 的 argv 跟 core CodexAgent.buildProcessSpec
// (packages/core/src/agent/codex.ts:186-196) 严格对齐. 之前 `--quiet -p <prompt>`
// 不吐 JSON 流, wb-runner events.ndjson 拿不到 done, 卡片冻 running.
describe('D1 codex argv alignment with core CodexAgent', () => {
  it('default invocation matches core: exec --json --skip-git-repo-check -', () => {
    const args = buildAgentArgs('codex', 'p', '/tmp');
    expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', '-']);
  });

  it('contains exec / --json / --skip-git-repo-check', () => {
    const args = buildAgentArgs('codex', 'p', '/tmp');
    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('continuationToken inserts `resume` + token immediately before trailing `-`', () => {
    const args = buildAgentArgs('codex', 'p', '/tmp', 'tok-abc-123');
    expect(args).toContain('exec');
    expect(args).toContain('resume');
    expect(args).toContain('tok-abc-123');
    // token 位置: 倒数第二 (trailing `-` 永远最后)
    expect(args[args.length - 2]).toBe('tok-abc-123');
    expect(args.at(-1)).toBe('-');
  });

  it('model splices --model <m> in the right position (default form)', () => {
    const args = buildAgentArgs('codex', 'p', '/tmp', undefined, undefined, 'gpt-5-codex');
    expect(args).toContain('--model');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    // --model 必须在 --skip-git-repo-check 之前 (codex `exec` 子命令 args order)
    expect(modelIdx).toBeLessThan(args.indexOf('--skip-git-repo-check'));
  });

  it('model splices --model <m> in the right position (resume form)', () => {
    const args = buildAgentArgs('codex', 'p', '/tmp', 'tok', undefined, 'gpt-5-codex');
    expect(args).toContain('--model');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    // resume 形态: --model 仍在 --skip-git-repo-check 之前
    expect(modelIdx).toBeLessThan(args.indexOf('--skip-git-repo-check'));
  });

  it('prompt literal does NOT appear in args (must travel via stdin)', () => {
    const variants = [
      buildAgentArgs('codex', 'PROMPT-A', '/tmp'),
      buildAgentArgs('codex', 'PROMPT-B', '/tmp', 'tok'),
      buildAgentArgs('codex', 'PROMPT-C', '/tmp', undefined, undefined, 'm'),
      buildAgentArgs('codex', 'PROMPT-D', '/tmp', 'tok', 'auto', 'm'),
    ];
    for (const args of variants) {
      expect(args.some((a) => a.startsWith('PROMPT-'))).toBe(false);
    }
  });

  it('does NOT include legacy --quiet / -p flags', () => {
    const args = buildAgentArgs('codex', 'p', '/tmp');
    expect(args).not.toContain('--quiet');
    expect(args).not.toContain('-p');
  });
});

describe('stripModelArgs (D1 helper for codex --model extraction from WB_CODEX_COMMAND prepend)', () => {
  it('strips `--model X` (separated form)', () => {
    expect(stripModelArgs(['--model', 'gpt-5', '--verbose'])).toEqual(['--verbose']);
  });

  it('strips `--model=X` (equal-sign form)', () => {
    expect(stripModelArgs(['--model=gpt-5', '--verbose'])).toEqual(['--verbose']);
  });

  it('strips `-m X` (short separated)', () => {
    expect(stripModelArgs(['-m', 'gpt-5', '--verbose'])).toEqual(['--verbose']);
  });

  it('strips `-mX` (short concat)', () => {
    expect(stripModelArgs(['-mgpt-5', '--verbose'])).toEqual(['--verbose']);
  });

  it('returns unchanged when no --model present', () => {
    expect(stripModelArgs(['--verbose', '--foo'])).toEqual(['--verbose', '--foo']);
    expect(stripModelArgs([])).toEqual([]);
  });

  it('does NOT eat unrelated -m-prefix flags', () => {
    expect(stripModelArgs(['--mode', 'something'])).toEqual(['--mode', 'something']);
  });
});
