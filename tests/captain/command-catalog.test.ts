import { describe, expect, it } from 'vitest';
import { CAPTAIN_ERROR_CODES, CaptainError, COMMAND_CATALOG, validateCatalog } from '../../packages/core/src/captain/index.js';

describe('command-catalog', () => {
  it('contains the required 10 bidirectional coverage commands', () => {
    const required = ['history', 'resume', 'health', 'status', 'logs', 'list-agents', 'use', 'help', 'captain', 'captain-use'];
    for (const name of required) {
      expect(COMMAND_CATALOG[name]).toBeDefined();
    }
  });

  it('has correct visibility and belongs_to metadata', () => {
    expect(COMMAND_CATALOG['captain-use']?.belongs_to).toBe('cli');
    expect(COMMAND_CATALOG['captain-use']?.im_visible).toBe(false);
    expect(COMMAND_CATALOG['history']?.belongs_to).toBe('both');
    expect(COMMAND_CATALOG['history']?.im_visible).toBe(true);
    expect(COMMAND_CATALOG['history']?.cli_visible).toBe(true);
  });

  it('validates successfully when all registered commands are included', () => {
    expect(() => validateCatalog(Object.keys(COMMAND_CATALOG))).not.toThrow();
  });

  it('throws CaptainError when a command is missing from catalog', () => {
    const missing = Object.keys(COMMAND_CATALOG).filter((key) => key !== 'history');
    expect(() => validateCatalog([...missing, 'ghost-command'])).toThrow(CaptainError);
    try {
      validateCatalog([...missing, 'ghost-command']);
    } catch (error) {
      expect((error as CaptainError).code).toBe(CAPTAIN_ERROR_CODES.E_CATALOG_INCOMPLETE);
      expect(String((error as Error).message)).toContain('ghost-command');
    }
  });
});
