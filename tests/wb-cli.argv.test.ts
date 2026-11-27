import { describe, expect, it } from 'vitest';
import { resolveCommand, resolveRunArgv } from '../apps/wb-cli/src/main.js';

describe('wb-cli argv routing', () => {
  it('treats explicit "run" as the run command and slices argv[0]', () => {
    const argv = ['run', 'hello'];
    expect(resolveCommand(argv)).toBe('run');
    expect(resolveRunArgv(argv)).toEqual(['hello']);
  });

  it('falls through to run when no command-like argv[0] is present, preserving argv', () => {
    const argv = ['hello'];
    expect(resolveCommand(argv)).toBe('run');
    expect(resolveRunArgv(argv)).toEqual(['hello']);
  });

  it('does NOT truncate the first positional when "run" is omitted', () => {
    const argv = ['my', 'prompt'];
    expect(resolveCommand(argv)).toBe('run');
    expect(resolveRunArgv(argv)).toEqual(['my', 'prompt']);
  });

  it('recognises list-agents, --help, -h, and --version', () => {
    expect(resolveCommand(['list-agents'])).toBe('list-agents');
    expect(resolveCommand(['--help'])).toBe('--help');
    expect(resolveCommand(['-h'])).toBe('--help');
    expect(resolveCommand(['--version'])).toBe('--version');
    expect(resolveCommand([])).toBe('--help');
  });

  it('recognises logs, runs, history, status, captain, and debug commands', () => {
    expect(resolveCommand(['logs'])).toBe('logs');
    expect(resolveCommand(['runs'])).toBe('runs');
    expect(resolveCommand(['history'])).toBe('history');
    expect(resolveCommand(['status'])).toBe('status');
    expect(resolveCommand(['captain'])).toBe('captain');
    expect(resolveCommand(['debug'])).toBe('debug');
  });
});
