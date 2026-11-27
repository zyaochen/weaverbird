import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import * as os from 'node:os';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateCwd } from '../../apps/wb-bot/src/security/cwd-guard.js';

let root = '';
let allowRoot = '';
let denyRoot = '';
let nested = '';
let symlinkPath = '';
let allowlist: string[] = [];
let denylist: string[] = [];
let cases: Array<[string, boolean, string?]> = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
  allowRoot = join(root, 'allow');
  denyRoot = join(allowRoot, 'secret');
  nested = join(allowRoot, 'project', 'child');
  symlinkPath = join(root, 'link-to-secret');
  mkdirSync(nested, { recursive: true });
  mkdirSync(denyRoot, { recursive: true });
  symlinkSync(denyRoot, symlinkPath);
  allowlist = [allowRoot, root, '/tmp'];
  denylist = [denyRoot, symlinkPath];
  cases = [
    ['', false],
    ['   ', false],
    [nested, true],
    [`${nested}/..`, true],
    [`${nested}/../child`, true],
    [allowRoot, true],
    [denyRoot, false],
    [symlinkPath, false],
    [join(root, 'missing'), false],
    ['.', false, homedir()],
    ['..', false, homedir()],
    ['/etc', false],
    ['/tmp', true],
    ['/tmp/..', false],
    [join(allowRoot, 'project'), true],
    [join(allowRoot, 'project', '..'), true],
    [join(denyRoot, 'nested'), false],
    [join(root, 'other'), false],
    [join(root, 'allow', 'project', 'child', '..'), true],
    [join(root, 'allow', 'project', 'child', '.'), true],
    [join(root, 'allow', 'project', 'child', '..', '..'), true],
  ];
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('cwd guard', () => {
  it('validates the fixture matrix', () => {
    const originalCwd = process.cwd();
    try {
      for (const [input, ok, cwd] of cases) {
        process.chdir(cwd ?? originalCwd);
        const result = validateCwd(input, allowlist, denylist);
        expect(result.ok, `cwd=${process.cwd()} input=${input}`).toBe(ok);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('cwd guard — macOS production denylist defaults', () => {
  const home = homedir();

  it('rejects ~/Library/Keychains/ (macOS Keychain)', () => {
    const keychainPath = join(home, 'Library', 'Keychains');
    const result = validateCwd(keychainPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/denied \(protected\)/);
  });

  it('rejects ~/.ssh/ (SSH private keys)', () => {
    const sshPath = join(home, '.ssh');
    const result = validateCwd(sshPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/denied \(protected\)/);
  });

  it('rejects ~/.weaverbird/ (operator own state dir)', () => {
    const wbPath = join(home, '.weaverbird');
    const result = validateCwd(wbPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/denied \(protected\)/);
  });

  it('rejects /System/Library (macOS system path)', () => {
    const result = validateCwd('/System');
    expect(result.ok).toBe(false);
  });

  it('rejects /private/etc (macOS realpath of /etc)', () => {
    const result = validateCwd('/private/etc');
    expect(result.ok).toBe(false);
  });

  it('rejects /etc (denylist direct entry)', () => {
    const result = validateCwd('/etc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/denied \(protected\)|not in allowlist/);
  });

  it('rejects /root (root home)', () => {
    const result = validateCwd('/root');
    expect(result.ok).toBe(false);
  });

  it('rejects /proc (linux proc fs, in denylist)', () => {
    const result = validateCwd('/proc');
    expect(result.ok).toBe(false);
  });

  it('allows $HOME/projects subdirectory when it exists', () => {
    const projectsPath = join(home, 'projects');
    const tmp = mkdtempSync(join(tmpdir(), 'wb-cwd-projects-'));
    try {
      const result = validateCwd(tmp, [tmp], []);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allows /tmp subdirectory', () => {
    const tmp = mkdtempSync('/tmp/wb-cwd-tmp-');
    try {
      const result = validateCwd(tmp);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
