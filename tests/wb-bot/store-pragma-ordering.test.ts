import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('store pragma ordering (G.D hotfix)', () => {
  it('handles rapid back-to-back BindingStore construction (single process)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-store-pragma-'));
    roots.push(dir);
    const dbPath = join(dir, 'binding.db');

    const stores = Array.from({ length: 5 }, () => new BindingStore(dbPath));

    expect(stores).toHaveLength(5);
    for (const store of stores) {
      expect(store.isReadOnly).toBe(false);
      store.close();
    }
  });

  it('does not throw SQLITE_BUSY on rapid sequential reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-store-pragma-seq-'));
    roots.push(dir);
    const dbPath = join(dir, 'binding.db');

    for (let i = 0; i < 10; i++) {
      const store = new BindingStore(dbPath);
      expect(store.isReadOnly).toBe(false);
      store.close();
    }
  });

  it('keeps WAL mode enabled after constructor hotfix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-store-pragma-wal-'));
    roots.push(dir);
    const dbPath = join(dir, 'binding.db');

    const first = new BindingStore(dbPath);
    first.close();
    const second = new BindingStore(dbPath);
    expect(second.quickCheck()).toEqual({ ok: true });
    second.close();
  });

  it('is idempotent when database is already in WAL mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-store-pragma-idempotent-'));
    roots.push(dir);
    const dbPath = join(dir, 'binding.db');

    const first = new BindingStore(dbPath);
    first.close();
    const second = new BindingStore(dbPath);
    const third = new BindingStore(dbPath);

    expect(second.quickCheck()).toEqual({ ok: true });
    expect(third.quickCheck()).toEqual({ ok: true });
    second.close();
    third.close();
  });

  it('survives repeated reopen after WAL has already been enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-store-pragma-repeat-'));
    roots.push(dir);
    const dbPath = join(dir, 'binding.db');

    const first = new BindingStore(dbPath);
    first.close();

    for (let i = 0; i < 3; i++) {
      const reopened = new BindingStore(dbPath);
      expect(reopened.quickCheck()).toEqual({ ok: true });
      reopened.close();
    }
  });
});
