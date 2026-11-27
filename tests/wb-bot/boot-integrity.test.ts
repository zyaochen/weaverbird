import { mkdtempSync, mkdirSync, chmodSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ensureDataDirIntegrity } from '../../apps/wb-bot/src/boot/integrity.js';

const roots: string[] = [];
const logger = pino({ level: 'silent' });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('A9 boot-loader startup integrity', () => {
  it('creates dataDir and subdirs with mode 0700 when they do not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-boot-'));
    roots.push(dir);
    const dataDir = join(dir, 'new-data');

    ensureDataDirIntegrity(dataDir, logger);

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'data')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'runs')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'logs')).mode & 0o777).toBe(0o700);
  });

  it('fixes mode when directory exists with wrong permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-boot-'));
    roots.push(dir);
    const dataDir = join(dir, 'data-wrong-perms');
    mkdirSync(dataDir, { recursive: true, mode: 0o755 });

    ensureDataDirIntegrity(dataDir, logger);

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it('does not crash when directory already has correct mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-boot-'));
    roots.push(dir);
    const dataDir = join(dir, 'data-ok');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    expect(() => ensureDataDirIntegrity(dataDir, logger)).not.toThrow();
  });

  it('warns but does not crash on unwritable directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-boot-'));
    roots.push(dir);
    const dataDir = join(dir, 'data-exist');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const warnLogger = pino({ level: 'warn' });
    expect(() => ensureDataDirIntegrity(dataDir, warnLogger)).not.toThrow();
  });
});
