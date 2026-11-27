import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCliPid } from '../../packages/core/src/reverse-channel/pid-resolver.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-pid-resolver-'));
  roots.push(root);
  return root;
}

function writePid(root: string, botId: string, runId: string, value: string): void {
  const dir = join(root, 'runs', botId, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pid'), value);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pid-resolver', () => {
  it('returns pid for the matching runId', () => {
    const root = makeRoot();
    writePid(root, 'default', 'run-001', '12345');
    expect(resolveCliPid(root, 'run-001')).toBe(12345);
  });

  it('returns null when runs directory is missing', () => {
    const root = makeRoot();
    expect(resolveCliPid(root, 'run-001')).toBeNull();
  });

  it('scans multiple bot directories and finds the matching runId', () => {
    const root = makeRoot();
    writePid(root, 'default', 'run-other', '23456');
    writePid(root, 'claude', 'run-001', '34567');
    expect(resolveCliPid(root, 'run-001')).toBe(34567);
  });

  it('returns null when pid file is empty', () => {
    const root = makeRoot();
    writePid(root, 'default', 'run-001', '');
    expect(resolveCliPid(root, 'run-001')).toBeNull();
  });

  it('returns null when pid file is not numeric', () => {
    const root = makeRoot();
    writePid(root, 'default', 'run-001', 'abc');
    expect(resolveCliPid(root, 'run-001')).toBeNull();
  });

  it('returns null when pid is zero or negative', () => {
    const root = makeRoot();
    writePid(root, 'default', 'run-zero', '0');
    writePid(root, 'default', 'run-negative', '-42');
    expect(resolveCliPid(root, 'run-zero')).toBeNull();
    expect(resolveCliPid(root, 'run-negative')).toBeNull();
  });
});
