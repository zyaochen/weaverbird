import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPTAIN_ERROR_CODES, CaptainError, loadCaptainConfig } from '../../packages/core/src/captain/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('toml-loader', () => {
  it('loads repo captain.json config', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-captain-loader-'));
    roots.push(repo);
    writeFileSync(join(repo, 'captain.json'), JSON.stringify({ version: 1, mapping: [{ git_remote: 'github\\.com', captain_id: 'default', cwd_prefix: repo }] }));
    const config = loadCaptainConfig({ cwd: repo, homeDir: join(repo, 'home') });
    expect(config.mapping[0]?.captain_id).toBe('default');
  });

  it('local override wins on same captain_id', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-captain-loader-'));
    const home = join(repo, 'home');
    roots.push(repo);
    mkdirSync(join(home, '.weaverbird'), { recursive: true });
    writeFileSync(join(repo, 'captain.json'), JSON.stringify({ version: 1, mapping: [{ git_remote: 'github\\.com', captain_id: 'default', cwd_prefix: '/repo', home_group_id: 'old' }] }));
    writeFileSync(join(home, '.weaverbird', 'captain.json'), JSON.stringify({ version: 1, mapping: [{ git_remote: 'github\\.com', captain_id: 'default', cwd_prefix: '/override', home_group_id: 'new' }] }));
    const config = loadCaptainConfig({ cwd: repo, homeDir: home });
    expect(config.mapping).toHaveLength(1);
    expect(config.mapping[0]?.cwd_prefix).toBe('/override');
    expect(config.mapping[0]?.home_group_id).toBe('new');
  });

  it('merges local-only captain ids', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-captain-loader-'));
    const home = join(repo, 'home');
    roots.push(repo);
    mkdirSync(join(home, '.weaverbird'), { recursive: true });
    writeFileSync(join(repo, 'captain.json'), JSON.stringify({ version: 1, mapping: [{ git_remote: 'github\\.com', captain_id: 'default' }] }));
    writeFileSync(join(home, '.weaverbird', 'captain.json'), JSON.stringify({ version: 1, mapping: [{ git_remote: 'github\\.com', captain_id: 'other' }] }));
    const config = loadCaptainConfig({ cwd: repo, homeDir: home });
    expect(config.mapping.map((item) => item.captain_id).sort()).toEqual(['default', 'other']);
  });

  it('throws missing when neither repo nor local config exists', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-captain-loader-'));
    roots.push(repo);
    expect(() => loadCaptainConfig({ cwd: repo, homeDir: join(repo, 'home') })).toThrowError(CaptainError);
    try {
      loadCaptainConfig({ cwd: repo, homeDir: join(repo, 'home') });
    } catch (error) {
      expect((error as CaptainError).code).toBe(CAPTAIN_ERROR_CODES.E_TOML_MISSING);
    }
  });

  it('throws invalid on malformed captain.json', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-captain-loader-'));
    roots.push(repo);
    writeFileSync(join(repo, 'captain.json'), '{ not-json');
    expect(() => loadCaptainConfig({ cwd: repo, homeDir: join(repo, 'home') })).toThrowError(CaptainError);
  });

  it('parses captain.toml when captain.json is absent', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-captain-loader-'));
    roots.push(repo);
    writeFileSync(join(repo, 'captain.toml'), [
      '# repo root mapping (no privacy fields)',
      'version = 1',
      '',
      '[[mapping]]',
      'git_remote = ".*github\\\\.com.*/weaverbird.*"',
      'cwd_prefix = "/Users/foo/code/weaverbird"',
      'captain_id = "captain-local-default"',
      '',
      '[[mapping]]',
      'git_remote = "github\\\\.com"',
      'captain_id = "captain-oss"',
      'home_group_id = "oc_xxx"',
      '',
    ].join('\n'));
    const config = loadCaptainConfig({ cwd: repo, homeDir: join(repo, 'home') });
    expect(config.version).toBe(1);
    expect(config.mapping).toHaveLength(2);
    expect(config.mapping[0]?.captain_id).toBe('captain-local-default');
    expect(config.mapping[0]?.cwd_prefix).toBe('/Users/foo/code/weaverbird');
    expect(config.mapping[1]?.home_group_id).toBe('oc_xxx');
  });

  it('rejects unsupported TOML keys with E_TOML_INVALID', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-captain-loader-'));
    roots.push(repo);
    writeFileSync(join(repo, 'captain.toml'), 'mapping = []\n');
    try {
      loadCaptainConfig({ cwd: repo, homeDir: join(repo, 'home') });
      throw new Error('expected CaptainError');
    } catch (error) {
      expect(error).toBeInstanceOf(CaptainError);
      expect((error as CaptainError).code).toBe(CAPTAIN_ERROR_CODES.E_TOML_INVALID);
      expect((error as CaptainError).message).toContain('unsupported');
    }
  });

  it('rejects captain.toml when mapping entry is missing captain_id', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-captain-loader-'));
    roots.push(repo);
    writeFileSync(join(repo, 'captain.toml'), '[[mapping]]\ngit_remote = "github"\n');
    try {
      loadCaptainConfig({ cwd: repo, homeDir: join(repo, 'home') });
      throw new Error('expected CaptainError');
    } catch (error) {
      expect(error).toBeInstanceOf(CaptainError);
      expect((error as CaptainError).code).toBe(CAPTAIN_ERROR_CODES.E_TOML_INVALID);
    }
  });

  it('repo captain.toml and local captain.json merge, local .json wins on same captain_id', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-captain-loader-'));
    const home = join(repo, 'home');
    roots.push(repo);
    mkdirSync(join(home, '.weaverbird'), { recursive: true });
    writeFileSync(join(repo, 'captain.toml'), [
      '[[mapping]]',
      'git_remote = "github\\\\.com"',
      'captain_id = "default"',
      'cwd_prefix = "/repo"',
      '',
    ].join('\n'));
    writeFileSync(join(home, '.weaverbird', 'captain.json'), JSON.stringify({
      version: 1,
      mapping: [{ git_remote: 'github\\.com', captain_id: 'default', cwd_prefix: '/override' }],
    }));
    const config = loadCaptainConfig({ cwd: repo, homeDir: home });
    expect(config.mapping).toHaveLength(1);
    expect(config.mapping[0]?.cwd_prefix).toBe('/override');
    expect(config.mapping[0]?.git_remote).toBe('github\\.com');
  });
});
