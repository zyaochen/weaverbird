import { mkdirSync } from 'node:fs';
import { auditMirrorPath } from '../paths.js';
import { appendNdjsonLine } from '../util/ndjson-rotation.js';
import type { AuditRecord, RejectedRecord } from './contracts.js';
import { AUDIT_PIPE_ERROR_CODES } from './contracts.js';

export type MirrorSink = { write(record: AuditRecord | RejectedRecord): void; path: string };

export function createMirrorSink({ dataDir }: { dataDir: string }): MirrorSink {
  mkdirSync(dataDir, { recursive: true });
  const path = auditMirrorPath(dataDir);
  return {
    path,
    write(record): void {
      try {
        appendNdjsonLine(path, JSON.stringify(record), { fsync: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`FATAL ${AUDIT_PIPE_ERROR_CODES.E_MIRROR_WRITE_FATAL}: ${message}`);
        process.exit(2);
      }
    },
  };
}
