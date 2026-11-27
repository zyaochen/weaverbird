import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../apps/wb-bot/src/cli/parse-args.js';

describe('parseArgs', () => {
  it('returns empty object for empty argv', () => {
    expect(parseArgs([])).toEqual({});
  });

  it('parses --help', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('parses -h', () => {
    expect(parseArgs(['-h'])).toEqual({ help: true });
  });

  it('parses --bot <id>', () => {
    expect(parseArgs(['--bot', 'claude'])).toEqual({ botId: 'claude' });
  });

  it('parses --bot with --help together', () => {
    expect(parseArgs(['--bot', 'claude', '--help'])).toEqual({ botId: 'claude', help: true });
  });

  it('throws when --bot has no value', () => {
    expect(() => parseArgs(['--bot'])).toThrow('--bot requires a value');
  });

  it('throws when --bot value starts with -', () => {
    expect(() => parseArgs(['--bot', '--other'])).toThrow('--bot requires a value');
  });

  it('ignores unknown flags silently', () => {
    expect(parseArgs(['--unknown-flag', 'x'])).toEqual({});
  });

  it('ignores positional arguments', () => {
    expect(parseArgs(['some', 'positional', 'args'])).toEqual({});
  });
});
