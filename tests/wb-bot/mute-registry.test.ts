import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MuteRegistry, defaultMuteRegistryPath, parseDuration } from '../../packages/core/src/reverse-channel/index.js';

describe('MuteRegistry', () => {
  let workDir: string;
  let registryFile: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'wb-mute-test-'));
    registryFile = defaultMuteRegistryPath(workDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('isMuted: 未注册时返回 false', () => {
    const r = new MuteRegistry(registryFile);
    expect(r.isMuted({ sessionId: 'bot:u:t' }).muted).toBe(false);
  });

  it('mute 后 isMuted 返回 true（未过期）', () => {
    const r = new MuteRegistry(registryFile);
    const result = r.mute('bot:u:t', '15m', { nowIso: '2026-08-13T10:00:00.000Z' });
    expect(result.ok).toBe(true);
    expect(result.expiresAtIso).toBe('2026-08-13T10:15:00.000Z');
    const q = r.isMuted({ sessionId: 'bot:u:t', nowIso: '2026-08-13T10:05:00.000Z' });
    expect(q.muted).toBe(true);
    expect(q.expiresAtIso).toBe('2026-08-13T10:15:00.000Z');
  });

  it('mute 到期后自动失效', () => {
    const r = new MuteRegistry(registryFile);
    r.mute('bot:u:t', '15m', { nowIso: '2026-08-13T10:00:00.000Z' });
    const q = r.isMuted({ sessionId: 'bot:u:t', nowIso: '2026-08-13T10:16:00.000Z' });
    expect(q.muted).toBe(false);
  });

  it('同 sid 重复 mute → 覆盖前值', () => {
    const r = new MuteRegistry(registryFile);
    r.mute('bot:u:t', '5m', { nowIso: '2026-08-13T10:00:00.000Z' });
    const second = r.mute('bot:u:t', '2h', { nowIso: '2026-08-13T10:00:00.000Z' });
    expect(second.expiresAtIso).toBe('2026-08-13T12:00:00.000Z');
    const q = r.isMuted({ sessionId: 'bot:u:t', nowIso: '2026-08-13T11:00:00.000Z' });
    expect(q.muted).toBe(true);
  });

  it('unmute 移除条目', () => {
    const r = new MuteRegistry(registryFile);
    r.mute('bot:u:t', '1h', { nowIso: '2026-08-13T10:00:00.000Z' });
    const result = r.unmute('bot:u:t');
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(1);
    expect(r.isMuted({ sessionId: 'bot:u:t', nowIso: '2026-08-13T10:00:00.000Z' }).muted).toBe(false);
  });

  it('unmute 不存在 sid 时返回 ok=false, removed=0', () => {
    const r = new MuteRegistry(registryFile);
    const result = r.unmute('nonexistent');
    expect(result.ok).toBe(false);
    expect(result.removed).toBe(0);
  });

  it('list 不包含过期 entries', () => {
    const r = new MuteRegistry(registryFile);
    r.mute('s1', '1m', { nowIso: '2026-08-13T10:00:00.000Z' });
    r.mute('s2', '1h', { nowIso: '2026-08-13T10:00:00.000Z' });
    const items = r.list({ nowIso: '2026-08-13T10:30:00.000Z' });
    expect(items.length).toBe(1);
    expect(items[0]!.sessionId).toBe('s2');
  });

  it('list includeExpired=true 返回全部', () => {
    const r = new MuteRegistry(registryFile);
    r.mute('s1', '1m', { nowIso: '2026-08-13T10:00:00.000Z' });
    r.mute('s2', '1h', { nowIso: '2026-08-13T10:00:00.000Z' });
    const items = r.list({ includeExpired: true, nowIso: '2026-08-13T10:30:00.000Z' });
    expect(items.length).toBe(2);
  });

  it('持久化 + 跨实例可见', () => {
    const r1 = new MuteRegistry(registryFile);
    r1.mute('bot:u:t', '1h', { nowIso: '2026-08-13T10:00:00.000Z', reason: 'qa' });
    const r2 = new MuteRegistry(registryFile);
    const q = r2.isMuted({ sessionId: 'bot:u:t', nowIso: '2026-08-13T10:30:00.000Z' });
    expect(q.muted).toBe(true);
    expect(q.reason).toBe('qa');
  });

  it('非法 JSON 文件 → 返回空表，不 throw', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(registryFile, 'not-json', 'utf8');
    const r = new MuteRegistry(registryFile);
    expect(r.isMuted({ sessionId: 's1' }).muted).toBe(false);
  });

  it('invalid duration 返回 ok=false + error', () => {
    const r = new MuteRegistry(registryFile);
    const result = r.mute('s1', '10x', { nowIso: '2026-08-13T10:00:00.000Z' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid duration');
  });
});

describe('parseDuration', () => {
  it('支持 s/m/h/d 单位', () => {
    const from = '2026-08-13T10:00:00.000Z';
    expect(parseDuration('30s', from)).toBe('2026-08-13T10:00:30.000Z');
    expect(parseDuration('15m', from)).toBe('2026-08-13T10:15:00.000Z');
    expect(parseDuration('2h', from)).toBe('2026-08-13T12:00:00.000Z');
    expect(parseDuration('7d', from)).toBe('2026-08-20T10:00:00.000Z');
  });

  it('size 非正数 / 单位不识别 → null', () => {
    const from = '2026-08-13T10:00:00.000Z';
    expect(parseDuration('0m', from)).toBeNull();
    expect(parseDuration('1w', from)).toBeNull();
    expect(parseDuration('', from)).toBeNull();
  });
});
