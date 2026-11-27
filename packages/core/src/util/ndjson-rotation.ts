import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const NDJSON_ROTATION_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const NDJSON_ROTATION_DEFAULT_MAX_FILES = 5;

type NdjsonRotationFs = Pick<typeof fs,
  | 'appendFileSync'
  | 'closeSync'
  | 'existsSync'
  | 'fsyncSync'
  | 'mkdirSync'
  | 'openSync'
  | 'readFileSync'
  | 'readdirSync'
  | 'renameSync'
  | 'statSync'
  | 'unlinkSync'
>;

export type NdjsonRotationOptions = {
  fsImpl?: NdjsonRotationFs;
  fsync?: boolean;
  maxBytes?: number;
  maxFiles?: number;
};

function normalizeLine(line: string): string {
  return line.endsWith('\n') ? line : `${line}\n`;
}

function overflowSegmentPath(path: string, maxFiles: number): string {
  return `${path}.${maxFiles}`;
}

function rotatedSegmentPath(path: string, index: number): string {
  return `${path}.${index}`;
}

function appendAndMaybeSync(path: string, line: string, options: Required<Pick<NdjsonRotationOptions, 'fsync'>> & { fsImpl: NdjsonRotationFs }): void {
  options.fsImpl.appendFileSync(path, line, 'utf8');
  if (!options.fsync) return;
  const fd = options.fsImpl.openSync(path, 'a');
  try {
    options.fsImpl.fsyncSync(fd);
  } finally {
    options.fsImpl.closeSync(fd);
  }
}

function rotateSegments(path: string, options: Required<Pick<NdjsonRotationOptions, 'maxFiles'>> & { fsImpl: NdjsonRotationFs }): void {
  const completed: Array<{ from: string; to: string }> = [];
  try {
    for (let index = options.maxFiles - 1; index >= 1; index -= 1) {
      const from = rotatedSegmentPath(path, index);
      if (!options.fsImpl.existsSync(from)) continue;
      const to = rotatedSegmentPath(path, index + 1);
      options.fsImpl.renameSync(from, to);
      completed.push({ from, to });
    }

    options.fsImpl.renameSync(path, rotatedSegmentPath(path, 1));
    completed.push({ from: path, to: rotatedSegmentPath(path, 1) });

    const overflowPath = overflowSegmentPath(path, options.maxFiles);
    if (options.fsImpl.existsSync(overflowPath)) {
      options.fsImpl.unlinkSync(overflowPath);
    }
  } catch (error) {
    for (let index = completed.length - 1; index >= 0; index -= 1) {
      const rename = completed[index];
      if (!rename || !options.fsImpl.existsSync(rename.to)) continue;
      options.fsImpl.renameSync(rename.to, rename.from);
    }
    throw error;
  }
}

export function appendNdjsonLine(path: string, line: string, options: NdjsonRotationOptions = {}): void {
  const fsImpl = options.fsImpl ?? fs;
  const maxBytes = options.maxBytes ?? NDJSON_ROTATION_DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? NDJSON_ROTATION_DEFAULT_MAX_FILES;
  const normalizedLine = normalizeLine(line);

  fsImpl.mkdirSync(dirname(path), { recursive: true });

  const currentSize = fsImpl.existsSync(path) ? fsImpl.statSync(path).size : 0;
  if (currentSize + Buffer.byteLength(normalizedLine) > maxBytes && fsImpl.existsSync(path)) {
    rotateSegments(path, { fsImpl, maxFiles });
  }

  appendAndMaybeSync(path, normalizedLine, { fsImpl, fsync: options.fsync ?? false });
}

export function listNdjsonSegments(path: string, options: Pick<NdjsonRotationOptions, 'fsImpl'> = {}): string[] {
  const fsImpl = options.fsImpl ?? fs;
  const dir = dirname(path);
  if (!fsImpl.existsSync(dir)) return [];

  const name = basename(path);
  const entries = fsImpl.readdirSync(dir)
    .map((entry) => entry.toString())
    .filter((entry) => entry === name || entry.startsWith(`${name}.`));

  const rotated = entries
    .filter((entry) => entry !== name)
    .map((entry) => ({
      entry,
      suffix: Number.parseInt(entry.slice(name.length + 1), 10),
    }))
    .filter((entry) => Number.isFinite(entry.suffix))
    .sort((a, b) => b.suffix - a.suffix)
    .map((entry) => join(dir, entry.entry));

  const active = entries.includes(name) ? [path] : [];
  return [...rotated, ...active];
}

export function readNdjsonSegments(path: string, options: Pick<NdjsonRotationOptions, 'fsImpl'> = {}): string[] {
  const fsImpl = options.fsImpl ?? fs;
  const lines: string[] = [];
  for (const segment of listNdjsonSegments(path, { fsImpl })) {
    const raw = fsImpl.readFileSync(segment, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      lines.push(line);
    }
  }
  return lines;
}
