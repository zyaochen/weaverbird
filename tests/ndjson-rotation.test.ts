import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendNdjsonLine,
  listNdjsonSegments,
  NDJSON_ROTATION_DEFAULT_MAX_BYTES,
  NDJSON_ROTATION_DEFAULT_MAX_FILES,
  readNdjsonSegments,
} from '../packages/core/src/util/ndjson-rotation.js';

const roots: string[] = [];

function createTempPath(prefix = 'wb-ndjson-rotation-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return join(dir, 'events.ndjson');
}

function createFsTracker() {
  const renameOrder: string[] = [];
  const unlinks: string[] = [];
  let openCount = 0;
  let fsyncCount = 0;
  let closeCount = 0;

  return {
    fsImpl: {
      appendFileSync: nodeFs.appendFileSync,
      closeSync(fd: number) {
        closeCount += 1;
        return nodeFs.closeSync(fd);
      },
      existsSync: nodeFs.existsSync,
      fsyncSync(fd: number) {
        fsyncCount += 1;
        return nodeFs.fsyncSync(fd);
      },
      mkdirSync: nodeFs.mkdirSync,
      openSync(path: nodeFs.PathLike, flags: string | number) {
        openCount += 1;
        return nodeFs.openSync(path, flags);
      },
      readFileSync: nodeFs.readFileSync,
      readdirSync: nodeFs.readdirSync,
      renameSync(from: nodeFs.PathLike, to: nodeFs.PathLike) {
        renameOrder.push(`${String(from)}->${String(to)}`);
        return nodeFs.renameSync(from, to);
      },
      statSync: nodeFs.statSync,
      unlinkSync(path: nodeFs.PathLike) {
        unlinks.push(String(path));
        return nodeFs.unlinkSync(path);
      },
    },
    stats() {
      return {
        renameOrder,
        unlinks,
        openCount,
        fsyncCount,
        closeCount,
      };
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ndjson-rotation', () => {
  it('C1-no-rotate: appends to active file when under threshold', () => {
    const path = createTempPath();

    appendNdjsonLine(path, '{"line":1}', { maxBytes: 1024 });
    appendNdjsonLine(path, '{"line":2}', { maxBytes: 1024 });

    expect(readFileSync(path, 'utf8')).toBe('{"line":1}\n{"line":2}\n');
    expect(listNdjsonSegments(path)).toEqual([path]);
  });

  it('C1-rotate-order: rotates from oldest to newest and moves active to .1 last', () => {
    const path = createTempPath();
    appendNdjsonLine(path, 'aa', { maxBytes: 8 });
    appendNdjsonLine(path, 'bbb', { maxBytes: 8 });
    appendNdjsonLine(path, 'cccc', { maxBytes: 8 });

    const tracker = createFsTracker();
    appendNdjsonLine(path, 'ddd', { maxBytes: 8, fsImpl: tracker.fsImpl });

    expect(tracker.stats().renameOrder).toEqual([
      `${path}.1->${path}.2`,
      `${path}->${path}.1`,
    ]);
    expect(readFileSync(`${path}.2`, 'utf8')).toBe('aa\nbbb\n');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('cccc\n');
    expect(readFileSync(path, 'utf8')).toBe('ddd\n');
  });

  it('C1-max-files: trims only the oldest overflow segment after rotation', () => {
    const path = createTempPath();

    appendNdjsonLine(path, 'a', { maxBytes: 4, maxFiles: 3 });
    appendNdjsonLine(path, 'b', { maxBytes: 4, maxFiles: 3 });
    appendNdjsonLine(path, 'c', { maxBytes: 4, maxFiles: 3 });
    appendNdjsonLine(path, 'd', { maxBytes: 4, maxFiles: 3 });
    appendNdjsonLine(path, 'e', { maxBytes: 4, maxFiles: 3 });
    appendNdjsonLine(path, 'f', { maxBytes: 4, maxFiles: 3 });

    const tracker = createFsTracker();
    appendNdjsonLine(path, 'g', { maxBytes: 4, maxFiles: 3, fsImpl: tracker.fsImpl });

    expect(tracker.stats().renameOrder).toEqual([
      `${path}.2->${path}.3`,
      `${path}.1->${path}.2`,
      `${path}->${path}.1`,
    ]);
    expect(tracker.stats().unlinks).toEqual([`${path}.3`]);
    expect(listNdjsonSegments(path)).toEqual([`${path}.2`, `${path}.1`, path]);
    expect(listNdjsonSegments(path)).toHaveLength(3);
    expect(readNdjsonSegments(path)).toEqual(['c', 'd', 'e', 'f', 'g']);
  });

  it('C1-read-order: reads rotated segments oldest-first through active', () => {
    const path = createTempPath();

    appendNdjsonLine(path, '1', { maxBytes: 4, maxFiles: 4 });
    appendNdjsonLine(path, '2', { maxBytes: 4, maxFiles: 4 });
    appendNdjsonLine(path, '3', { maxBytes: 4, maxFiles: 4 });
    appendNdjsonLine(path, '4', { maxBytes: 4, maxFiles: 4 });
    appendNdjsonLine(path, '5', { maxBytes: 4, maxFiles: 4 });
    appendNdjsonLine(path, '6', { maxBytes: 4, maxFiles: 4 });
    appendNdjsonLine(path, '7', { maxBytes: 4, maxFiles: 4 });

    expect(listNdjsonSegments(path)).toEqual([`${path}.3`, `${path}.2`, `${path}.1`, path]);
    expect(readNdjsonSegments(path)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('C1-fsync-off: appends without opening the file descriptor for fsync', () => {
    const path = createTempPath();
    const tracker = createFsTracker();

    appendNdjsonLine(path, 'hello', { fsync: false, fsImpl: tracker.fsImpl });

    expect(tracker.stats().openCount).toBe(0);
    expect(tracker.stats().fsyncCount).toBe(0);
    expect(tracker.stats().closeCount).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('hello\n');
  });

  it('C1-fsync-on: fsyncs the active file after append', () => {
    const path = createTempPath();
    const tracker = createFsTracker();

    appendNdjsonLine(path, 'hello', { fsync: true, fsImpl: tracker.fsImpl });

    expect(tracker.stats().openCount).toBe(1);
    expect(tracker.stats().fsyncCount).toBe(1);
    expect(tracker.stats().closeCount).toBe(1);
  });

  it('C1-defaults: exports the frozen default retention values', () => {
    expect(NDJSON_ROTATION_DEFAULT_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(NDJSON_ROTATION_DEFAULT_MAX_FILES).toBe(5);
  });
});
