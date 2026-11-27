import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentArgs, extractModelFromArgs } from '../../apps/wb-bot/src/feishu/event-handler.js';

describe('buildAgentArgs', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['ANTHROPIC_MODEL'];
    delete process.env['WB_CLAUDE_APPEND_SYSTEM_PROMPT'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('claude-code', () => {
    it('default consent (undefined) appends --dangerously-skip-permissions + permission-mode=default', () => {
      const args = buildAgentArgs('claude-code', 'hello', '/tmp/x');
      expect(args).toEqual([
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'default',
        '--dangerously-skip-permissions',
        'hello',
      ]);
    });

    it('auto consent → bypassPermissions + --dangerously-skip-permissions', () => {
      const args = buildAgentArgs('claude-code', 'hello', '/tmp/x', undefined, 'auto');
      expect(args).toEqual([
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--dangerously-skip-permissions',
        'hello',
      ]);
    });

    it('relaxed consent → acceptEdits + --dangerously-skip-permissions', () => {
      const args = buildAgentArgs('claude-code', 'hello', '/tmp/x', undefined, 'relaxed');
      expect(args).toEqual([
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--dangerously-skip-permissions',
        'hello',
      ]);
    });

    it('plan-only consent → permission-mode=plan WITHOUT --dangerously-skip-permissions', () => {
      // plan-only: claude 只 plan 不执行任何工具, trust 风险 = 0, 不需要 skip permissions
      const args = buildAgentArgs('claude-code', 'design X', '/tmp/x', undefined, 'plan-only');
      expect(args).toEqual([
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'plan',
        'design X',
      ]);
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('continuationToken passes --resume <token>', () => {
      const args = buildAgentArgs('claude-code', 'hello', '/tmp/x', 'tok-abc-123');
      expect(args).toContain('--resume');
      const idx = args.indexOf('--resume');
      expect(args[idx + 1]).toBe('tok-abc-123');
    });

    it('ANTHROPIC_MODEL env adds --model <name>', () => {
      process.env['ANTHROPIC_MODEL'] = 'gpt-5.4';
      const args = buildAgentArgs('claude-code', 'hello', '/tmp/x');
      expect(args).toContain('--model');
      const idx = args.indexOf('--model');
      expect(args[idx + 1]).toBe('gpt-5.4');
    });

    it('prompt always last', () => {
      process.env['ANTHROPIC_MODEL'] = 'gpt-5.4';
      const args = buildAgentArgs('claude-code', 'tail prompt', '/tmp/x', 'tok', 'auto');
      expect(args[args.length - 1]).toBe('tail prompt');
    });

    it('dangerously-skip-permissions precedes prompt (so prompt is not eaten as flag arg)', () => {
      const args = buildAgentArgs('claude-code', 'hello', '/tmp/x', undefined, 'auto');
      const skipIdx = args.indexOf('--dangerously-skip-permissions');
      const promptIdx = args.indexOf('hello');
      expect(skipIdx).toBeGreaterThanOrEqual(0);
      expect(promptIdx).toBe(args.length - 1);
      expect(skipIdx).toBeLessThan(promptIdx);
    });

    describe('WB_CLAUDE_APPEND_SYSTEM_PROMPT env', () => {
      it('no env → no --append-system-prompt in args', () => {
        const args = buildAgentArgs('claude-code', 'hello', '/tmp/x');
        expect(args).not.toContain('--append-system-prompt');
      });

      it('empty / whitespace-only env → no --append-system-prompt', () => {
        process.env['WB_CLAUDE_APPEND_SYSTEM_PROMPT'] = '';
        expect(buildAgentArgs('claude-code', 'hello', '/tmp/x')).not.toContain('--append-system-prompt');
        process.env['WB_CLAUDE_APPEND_SYSTEM_PROMPT'] = '   \n  ';
        expect(buildAgentArgs('claude-code', 'hello', '/tmp/x')).not.toContain('--append-system-prompt');
      });

      it('non-empty env → adds --append-system-prompt <env value> right before prompt', () => {
        process.env['WB_CLAUDE_APPEND_SYSTEM_PROMPT'] = '遇到 数据平台 auth 直接 fail-fast 不要 retry';
        const args = buildAgentArgs('claude-code', 'hello', '/tmp/x');
        const idx = args.indexOf('--append-system-prompt');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(args[idx + 1]).toBe('遇到 数据平台 auth 直接 fail-fast 不要 retry');
        // prompt 仍在末尾
        expect(args.at(-1)).toBe('hello');
        // append-system-prompt 在 prompt 之前
        expect(idx).toBeLessThan(args.length - 1);
      });

      it('multi-line system prompt 原样传 (dotenv multi-line / \\n escape 在 dotenv 层处理)', () => {
        process.env['WB_CLAUDE_APPEND_SYSTEM_PROMPT'] = 'line1\nline2\nline3';
        const args = buildAgentArgs('claude-code', 'p', '/tmp/x');
        const idx = args.indexOf('--append-system-prompt');
        expect(args[idx + 1]).toBe('line1\nline2\nline3');
      });

      it('与 ConsentLevel 正交 — auto / plan-only 都能 carry append-system-prompt', () => {
        process.env['WB_CLAUDE_APPEND_SYSTEM_PROMPT'] = 'guard';
        expect(buildAgentArgs('claude-code', 'p', '/x', undefined, 'auto')).toContain('--append-system-prompt');
        expect(buildAgentArgs('claude-code', 'p', '/x', undefined, 'plan-only')).toContain('--append-system-prompt');
        expect(buildAgentArgs('claude-code', 'p', '/x', undefined, 'relaxed')).toContain('--append-system-prompt');
      });
    });
  });

  // D1: codex argv 跟 core CodexAgent.buildProcessSpec 对齐
  // (packages/core/src/agent/codex.ts:186-196). prompt 不再在 argv,
  // 由 caller 通过 stdin pipe 写给 grandchild.
  describe('codex (D1 alignment)', () => {
    it('default: exec --json --skip-git-repo-check - (prompt NOT in argv)', () => {
      const args = buildAgentArgs('codex', 'codex prompt', '/tmp/x');
      expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', '-']);
      expect(args).not.toContain('codex prompt');
    });

    it('continuationToken: exec resume --json --skip-git-repo-check <token> -', () => {
      const args = buildAgentArgs('codex', 'p', '/tmp/x', 'tok-xyz');
      expect(args).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', 'tok-xyz', '-']);
      expect(args).not.toContain('p');
    });

    it('model splices --model <m> between --json and --skip-git-repo-check (default form)', () => {
      const args = buildAgentArgs('codex', 'p', '/tmp/x', undefined, undefined, 'gpt-5-codex');
      expect(args).toEqual(['exec', '--json', '--model', 'gpt-5-codex', '--skip-git-repo-check', '-']);
    });

    it('model + continuationToken splices --model after --json, before --skip-git-repo-check', () => {
      const args = buildAgentArgs('codex', 'p', '/tmp/x', 'tok-abc', undefined, 'gpt-5-codex');
      expect(args).toEqual(['exec', 'resume', '--json', '--model', 'gpt-5-codex', '--skip-git-repo-check', 'tok-abc', '-']);
    });

    it('consentLevel param is ignored for codex (no consent mapping yet)', () => {
      const args = buildAgentArgs('codex', 'p', '/tmp/x', undefined, 'auto');
      expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', '-']);
    });

    it('prompt literal NEVER appears in returned args', () => {
      const a1 = buildAgentArgs('codex', 'literal-1', '/cwd');
      const a2 = buildAgentArgs('codex', 'literal-2', '/cwd', 'tok');
      const a3 = buildAgentArgs('codex', 'literal-3', '/cwd', undefined, undefined, 'gpt-5');
      expect(a1).not.toContain('literal-1');
      expect(a2).not.toContain('literal-2');
      expect(a3).not.toContain('literal-3');
    });

    it('trailing `-` is always the last arg (signals codex to read prompt from stdin)', () => {
      expect(buildAgentArgs('codex', 'p', '/x').at(-1)).toBe('-');
      expect(buildAgentArgs('codex', 'p', '/x', 'tok').at(-1)).toBe('-');
      expect(buildAgentArgs('codex', 'p', '/x', undefined, undefined, 'm').at(-1)).toBe('-');
      expect(buildAgentArgs('codex', 'p', '/x', 'tok', undefined, 'm').at(-1)).toBe('-');
    });
  });
});

describe('extractModelFromArgs', () => {
  it('parses --model <value> (separated form)', () => {
    expect(extractModelFromArgs(['--model', 'gpt-5.4'])).toBe('gpt-5.4');
  });

  it('parses --model=<value> (equal-sign form)', () => {
    expect(extractModelFromArgs(['--model=gpt-5.4'])).toBe('gpt-5.4');
  });

  it('parses -m <value> (short separated)', () => {
    expect(extractModelFromArgs(['-m', 'gpt-5.4'])).toBe('gpt-5.4');
  });

  it('parses -m<value> (short concat)', () => {
    expect(extractModelFromArgs(['-mgpt-5.4'])).toBe('gpt-5.4');
  });

  it('returns first match when multiple --model present', () => {
    expect(extractModelFromArgs(['--model', 'first', '--model', 'second'])).toBe('first');
  });

  it('returns undefined when no --model in args', () => {
    expect(extractModelFromArgs(['--print', '--verbose'])).toBeUndefined();
    expect(extractModelFromArgs([])).toBeUndefined();
  });

  it('returns undefined when --model is last arg (no value follows)', () => {
    expect(extractModelFromArgs(['--print', '--model'])).toBeUndefined();
  });

  it('skips --model when next token looks like a flag (avoid eating flags)', () => {
    expect(extractModelFromArgs(['--model', '--print'])).toBeUndefined();
  });

  it('handles real WB_CLAUDE_COMMAND prepend (claude-w wrapper form)', () => {
    // 实测 2026-06-03: WB_CLAUDE_COMMAND="claude-w --model gpt-5.4"
    // split('\s+') → ['claude-w', '--model', 'gpt-5.4']
    // 第一段是 head (binary), 余下是 prepend (传给 extractModelFromArgs)
    expect(extractModelFromArgs(['--model', 'gpt-5.4'])).toBe('gpt-5.4');
  });

  it('does NOT match unrelated -prefix flags', () => {
    expect(extractModelFromArgs(['--mode', 'something'])).toBeUndefined();
    expect(extractModelFromArgs(['-x', 'val'])).toBeUndefined();
  });
});
