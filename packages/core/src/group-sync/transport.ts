import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { groupSyncMockLedgerPath } from '../paths.js';
import type { DocSinkTransport } from '../run-registry/index.js';
import { appendNdjsonLine } from '../util/ndjson-rotation.js';
import {
  GroupSyncAutoDocInputSchema,
  GroupSyncCommandReceivedSchema,
  GroupSyncCrossGroupReferenceSchema,
  GroupSyncReviewDiffReplySchema,
  type GroupSyncCommandReceived,
  type GroupSyncReferenceTransport,
  type GroupSyncReviewDiffTransport,
  type GroupSyncTransport,
} from './contracts.js';
import { groupSyncMockAutoDocLedgerPath } from './autodoc.js';
import { groupSyncMockReferenceLedgerPath } from './xref.js';
import { groupSyncMockReviewDiffLedgerPath } from './revdiff.js';

export function createMockGroupSyncTransport(dataDir: string): GroupSyncTransport {
  const ledgerPath = groupSyncMockLedgerPath(dataDir);
  return {
    async syncCommand(input: GroupSyncCommandReceived): Promise<void> {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendNdjsonLine(ledgerPath, JSON.stringify(GroupSyncCommandReceivedSchema.parse(input)));
    },
  };
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function createGuardedCliGroupSyncTransport(): GroupSyncTransport {
  return {
    async syncCommand(): Promise<void> {
      throw new Error('group sync real egress requires explicit real-device authorization');
    },
  };
}

export function createMockGroupSyncReferenceTransport(dataDir: string): GroupSyncReferenceTransport {
  const ledgerPath = groupSyncMockReferenceLedgerPath(dataDir);
  return {
    async publishReference(input): Promise<void> {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendNdjsonLine(ledgerPath, JSON.stringify(GroupSyncCrossGroupReferenceSchema.parse(input)));
    },
  };
}

export function createGuardedCliGroupSyncReferenceTransport(): GroupSyncReferenceTransport {
  return {
    async publishReference(): Promise<void> {
      throw new Error('group sync cross-group reference egress requires explicit real-device authorization');
    },
  };
}

export function createMockGroupSyncReviewDiffTransport(dataDir: string): GroupSyncReviewDiffTransport {
  const ledgerPath = groupSyncMockReviewDiffLedgerPath(dataDir);
  return {
    async publishReviewDiff(input): Promise<void> {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendNdjsonLine(ledgerPath, JSON.stringify(GroupSyncReviewDiffReplySchema.parse(input)));
    },
  };
}

export function createGuardedCliGroupSyncReviewDiffTransport(): GroupSyncReviewDiffTransport {
  return {
    async publishReviewDiff(): Promise<void> {
      throw new Error('group sync review diff reply egress requires explicit real-device authorization');
    },
  };
}

export function createMockGroupSyncAutoDocTransport(dataDir: string): DocSinkTransport {
  const ledgerPath = groupSyncMockAutoDocLedgerPath(dataDir);
  return {
    async create(input) {
      const url = `https://mock.larkoffice.com/suite/docx/${encodeURIComponent(input.runId)}`;
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendNdjsonLine(ledgerPath, JSON.stringify(GroupSyncAutoDocInputSchema.parse({
        request_id: `mock-${input.runId}`,
        session_id: `mock-${input.runId}`,
        run_id: input.runId,
        revision: 0,
        artifact_id: input.runId,
        artifact_label: input.title,
        artifact_path: null,
        sink_run_id: input.runId,
        terminal_status: 'succeeded',
        existing_doc_urls: [url],
      })));
      return { url, rawOutput: url };
    },
  };
}

export function createGuardedCliGroupSyncAutoDocTransport(): DocSinkTransport {
  return {
    async create(): Promise<{ url: string; rawOutput: string }> {
      throw new Error('group sync auto doc egress requires explicit real-device authorization');
    },
  };
}
