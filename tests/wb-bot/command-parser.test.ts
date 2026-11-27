import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../apps/wb-bot/src/commands/parser.js';

describe('command parser', () => {
  it('parses quoted arguments', () => {
    expect(parseCommand('/cwd "/a b"')).toEqual(['/cwd', '/a b']);
    expect(parseCommand("/cwd-add work '/tmp/my dir'" )).toEqual(['/cwd-add', 'work', '/tmp/my dir']);
  });

  it('throws on unterminated quotes', () => {
    expect(() => parseCommand('/cwd "oops')).toThrow('unterminated quote');
  });
});
