import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAuditPipe } from '../../apps/wb-bot/src/commands/health.js';

let dir = '';
let plistPath = '';

function installPlist(path: string): void {
  mkdirSync(join(path, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(path, 'Library', 'LaunchAgents', 'com.weaverbird.audit-pipe.plist'), '<plist/>');
}

function writeMirror(path: string, content = '{"audit_record_id":"r1"}\n'): string {
  const mirrorPath = join(path, 'audit-mirror.ndjson');
  writeFileSync(mirrorPath, content);
  return mirrorPath;
}

function writeWalFiles(path: string, count: number): void {
  const walDir = join(path, 'wal', 'audit');
  mkdirSync(walDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(walDir, `${String(i).padStart(4, '0')}.jsonl`), '{"seq":1}\n');
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-audit-health-'));
  plistPath = join(dir, 'Library', 'LaunchAgents', 'com.weaverbird.audit-pipe.plist');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['WB_AUDIT_MIRROR_STALE_MS'];
  delete process.env['WB_AUDIT_WAL_WARN_THRESHOLD'];
});

describe('checkAuditPipe', () => {
  it('returns warn when plist does not exist', () => {
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.status).toBe('warn');
    expect(result.label).toBe('Audit Pipe');
    expect(result.detail).toMatch(/未安装/);
    expect(result.detail).toMatch(/可选/);
    expect(result.detail).toMatch(/audit-pipe-setup/);
  });

  it('returns warn when plist exists but mirror does not', () => {
    installPlist(dir);
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/尚无审计记录/);
  });

  it('includes WAL count when plist exists but mirror does not and WAL has entries', () => {
    installPlist(dir);
    writeWalFiles(dir, 3);
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/WAL 积压 3 条/);
  });

  it('returns ok when mirror is fresh and WAL is empty', () => {
    installPlist(dir);
    writeMirror(dir);
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.status).toBe('ok');
    expect(result.detail).toMatch(/0 pending/);
  });

  it('treats rotated audit-mirror shards as existing mirror records', () => {
    installPlist(dir);
    writeFileSync(join(dir, 'audit-mirror.ndjson.1'), '{"audit_record_id":"r0"}\n');
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.status).toBe('ok');
  });

  it('returns ok with small WAL count below threshold', () => {
    installPlist(dir);
    writeMirror(dir);
    writeWalFiles(dir, 5);
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.status).toBe('ok');
    expect(result.detail).toMatch(/5 pending/);
  });

  it('returns warn when mirror is stale', () => {
    installPlist(dir);
    const mirrorPath = writeMirror(dir);
    const staleTime = new Date(Date.now() - 15 * 60 * 1000);
    utimesSync(mirrorPath, staleTime, staleTime);
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/> 240s/);
    expect(result.detail).toMatch(/可能未运行/);
  });

  it('includes WAL count in stale state', () => {
    installPlist(dir);
    const mirrorPath = writeMirror(dir);
    writeWalFiles(dir, 2);
    const staleTime = new Date(Date.now() - 15 * 60 * 1000);
    utimesSync(mirrorPath, staleTime, staleTime);
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.detail).toMatch(/WAL 积压 2 条/);
  });

  it('returns warn when WAL backlog meets default threshold', () => {
    installPlist(dir);
    writeMirror(dir);
    writeWalFiles(dir, 100);
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/WAL 积压 100 条/);
    expect(result.detail).toMatch(/≥ 100/);
  });

  it('respects WB_AUDIT_WAL_WARN_THRESHOLD env override', () => {
    process.env['WB_AUDIT_WAL_WARN_THRESHOLD'] = '5';
    installPlist(dir);
    writeMirror(dir);
    writeWalFiles(dir, 5);
    const result = checkAuditPipe(dir, () => Date.now(), plistPath);
    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/≥ 5/);
  });

  it('does not throw on fs errors', () => {
    installPlist(dir);
    const badPath = join(dir, 'not-a-dir');
    writeFileSync(badPath, 'x');
    expect(() => checkAuditPipe(badPath, () => Date.now(), plistPath)).not.toThrow();
    const result = checkAuditPipe(badPath, () => Date.now(), plistPath);
    expect(result.status).toBe('warn');
  });
});
