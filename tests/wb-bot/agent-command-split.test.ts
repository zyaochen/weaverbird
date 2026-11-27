import { describe, expect, it } from 'vitest';

function parseAgentCommand(raw: string | undefined, defaultCmd: string): { head: string; prepend: string[] } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { head: defaultCmd, prepend: [] };
  const [head, ...prepend] = trimmed.split(/\s+/);
  return { head: head!, prepend };
}

describe('agent command split (WB_CLAUDE_COMMAND / WB_CODEX_COMMAND)', () => {
  it('unset → fallback to default', () => {
    const r = parseAgentCommand(undefined, 'claude');
    expect(r).toEqual({ head: 'claude', prepend: [] });
  });

  it('empty string → fallback', () => {
    const r = parseAgentCommand('', 'claude');
    expect(r).toEqual({ head: 'claude', prepend: [] });
  });

  it('whitespace-only → fallback', () => {
    const r = parseAgentCommand('   ', 'claude');
    expect(r).toEqual({ head: 'claude', prepend: [] });
  });

  it('single word → no prepend', () => {
    const r = parseAgentCommand('claude', 'claude');
    expect(r).toEqual({ head: 'claude', prepend: [] });
  });

  it('single wrapper → no prepend', () => {
    const r = parseAgentCommand('claude-w', 'claude');
    expect(r).toEqual({ head: 'claude-w', prepend: [] });
  });

  it('wrapper + flag', () => {
    const r = parseAgentCommand('claude-w --model X', 'claude');
    expect(r).toEqual({ head: 'claude-w', prepend: ['--model', 'X'] });
  });

  it('multi-space trim', () => {
    const r = parseAgentCommand('  claude-w   --model   X  ', 'claude');
    expect(r).toEqual({ head: 'claude-w', prepend: ['--model', 'X'] });
  });

  it('codex path mirror', () => {
    const r = parseAgentCommand('codex-w --foo', 'codex');
    expect(r).toEqual({ head: 'codex-w', prepend: ['--foo'] });
  });
});
