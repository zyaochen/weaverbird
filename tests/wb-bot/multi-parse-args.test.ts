import { describe, expect, it } from 'vitest';
import { parseMultiArgs } from '../../apps/wb-bot/src/multi/parse-args.js';

describe('parseMultiArgs', () => {
  it('returns empty object for empty argv', () => {
    expect(parseMultiArgs([])).toEqual({});
  });

  it('parses --help', () => {
    expect(parseMultiArgs(['--help'])).toEqual({ help: true });
  });

  it('parses -h', () => {
    expect(parseMultiArgs(['-h'])).toEqual({ help: true });
  });

  it('parses --config <path>', () => {
    expect(parseMultiArgs(['--config', '/tmp/configs'])).toEqual({ configDir: '/tmp/configs' });
  });

  it('parses --config with help together', () => {
    expect(parseMultiArgs(['--config', '/tmp/configs', '--help'])).toEqual({ configDir: '/tmp/configs', help: true });
  });

  it('throws when --config has no value', () => {
    expect(() => parseMultiArgs(['--config'])).toThrow('--config requires a value');
  });

  it('throws when --config value starts with flag prefix', () => {
    expect(() => parseMultiArgs(['--config', '--other'])).toThrow('--config requires a value');
  });

  it('ignores unknown flags silently', () => {
    expect(parseMultiArgs(['--unknown', 'x'])).toEqual({});
  });
});
