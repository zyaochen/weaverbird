import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';

export type Tailer = { tick(): AsyncIterable<string> };
export type CreateTailerOptions = { eventsPath: string; offsetPath: string };

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function readOffset(path: string): number {
  if (!existsSync(path)) return 0;
  const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function createTailer({ eventsPath, offsetPath }: CreateTailerOptions): Tailer {
  let offset = readOffset(offsetPath);
  return {
    async *tick(): AsyncIterable<string> {
      if (!existsSync(eventsPath)) return;
      const size = statSync(eventsPath).size;
      if (size < offset) offset = 0;
      if (size <= offset) return;
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const fd = openSync(eventsPath, 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, offset);
      } finally {
        closeSync(fd);
      }
      const chunk = buffer.toString('utf8');
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline < 0) return;
      const complete = chunk.slice(0, lastNewline + 1);
      offset += Buffer.byteLength(complete, 'utf8');
      atomicWrite(offsetPath, String(offset));
      for (const line of complete.split('\n')) {
        if (line.trim()) yield line;
      }
    },
  };
}
