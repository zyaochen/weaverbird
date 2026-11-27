import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { groupSyncDir, runDir } from '../paths.js';
import {
  GroupSyncReviewDiffReplyInputSchema,
  GroupSyncReviewDiffReplySchema,
  GroupSyncReviewDiffReplySetSchema,
  type GroupSyncConfig,
  type GroupSyncReviewDiffReply,
  type GroupSyncReviewDiffReplyInput,
  type GroupSyncReviewDiffReplySet,
  type GroupSyncReviewDiffTransport,
} from './contracts.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

function runGroupSyncReviewDiffPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'group-sync-review-diffs.json');
}

function readReplySet(path: string, input: GroupSyncReviewDiffReplyInput, nowIso: string): GroupSyncReviewDiffReplySet {
  if (!existsSync(path)) {
    return GroupSyncReviewDiffReplySetSchema.parse({
      session_id: input.session_id,
      run_id: input.run_id,
      last_revision: input.revision,
      updated_at: nowIso,
      replies: [],
    });
  }
  return GroupSyncReviewDiffReplySetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeReplySet(path: string, state: GroupSyncReviewDiffReplySet): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

function sanitizeIdPart(value: string | null | undefined): string {
  const raw = value?.trim() ?? '';
  if (raw.length === 0) return 'none';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function buildReplyId(input: GroupSyncReviewDiffReplyInput): string {
  return [
    'revdiff',
    sanitizeIdPart(input.request_id),
    sanitizeIdPart(input.review_id),
    sanitizeIdPart(input.source_thread_id),
    sanitizeIdPart(input.source_message_id ?? null),
  ].join(':');
}

function toReply(
  input: GroupSyncReviewDiffReplyInput,
  nowIso: string,
  patch: Partial<Pick<GroupSyncReviewDiffReply, 'created_at' | 'synced_at' | 'sync_failed' | 'last_error'>> = {},
): GroupSyncReviewDiffReply {
  return GroupSyncReviewDiffReplySchema.parse({
    request_id: input.request_id,
    session_id: input.session_id,
    run_id: input.run_id,
    revision: input.revision,
    source_thread_id: input.source_thread_id,
    source_message_id: input.source_message_id ?? null,
    review_id: input.review_id,
    title: input.title,
    summary: input.summary,
    diff_paths: input.diff_paths,
    reply_id: buildReplyId(input),
    created_at: patch.created_at ?? nowIso,
    synced_at: patch.synced_at ?? null,
    sync_failed: patch.sync_failed ?? false,
    last_error: patch.last_error ?? null,
  });
}

function mergeReplySet(state: GroupSyncReviewDiffReplySet, reply: GroupSyncReviewDiffReply, nowIso: string): GroupSyncReviewDiffReplySet {
  const replies = state.replies.filter((item) => item.reply_id !== reply.reply_id);
  replies.push(reply);
  replies.sort((left, right) => left.reply_id.localeCompare(right.reply_id));
  return GroupSyncReviewDiffReplySetSchema.parse({
    session_id: state.session_id,
    run_id: state.run_id,
    last_revision: Math.max(state.last_revision, reply.revision),
    updated_at: nowIso,
    replies,
  });
}

export type PublishReviewDiffReplyOptions = {
  dataDir: string;
  botId?: string;
  reply: GroupSyncReviewDiffReplyInput;
  config: GroupSyncConfig;
  transport: GroupSyncReviewDiffTransport;
  nowFn?: () => number;
};

export type PublishReviewDiffReplyResult = {
  sync_failed: boolean;
  reply: GroupSyncReviewDiffReply;
  state: GroupSyncReviewDiffReplySet;
  statePath: string;
};

export function groupSyncMockReviewDiffLedgerPath(dataDir: string): string {
  return join(groupSyncDir(dataDir), 'mock-review-diffs.ndjson');
}

export async function publishReviewDiffReply(options: PublishReviewDiffReplyOptions): Promise<PublishReviewDiffReplyResult> {
  const input = GroupSyncReviewDiffReplyInputSchema.parse(options.reply);
  const nowFn = options.nowFn ?? Date.now;
  const nowIso = new Date(nowFn()).toISOString();
  const statePath = runGroupSyncReviewDiffPath(options.dataDir, input.run_id, options.botId ?? 'default');
  const current = readReplySet(statePath, input, nowIso);
  const existing = current.replies.find((item) => item.reply_id === buildReplyId(input));
  if (existing && existing.sync_failed === false) {
    return {
      sync_failed: false,
      reply: existing,
      state: current,
      statePath,
    };
  }

  try {
    const reply = toReply(input, nowIso, {
      created_at: existing?.created_at ?? nowIso,
      synced_at: nowIso,
      sync_failed: false,
      last_error: null,
    });
    await withTimeout(options.transport.publishReviewDiff(reply), options.config.rpc_timeout_ms, 'group sync review diff timeout');
    const nextState = mergeReplySet(current, reply, nowIso);
    writeReplySet(statePath, nextState);
    return {
      sync_failed: false,
      reply,
      state: nextState,
      statePath,
    };
  } catch (error) {
    const reply = toReply(input, nowIso, {
      created_at: existing?.created_at ?? nowIso,
      synced_at: null,
      sync_failed: true,
      last_error: error instanceof Error ? error.message : String(error),
    });
    const nextState = mergeReplySet(current, reply, nowIso);
    writeReplySet(statePath, nextState);
    return {
      sync_failed: true,
      reply,
      state: nextState,
      statePath,
    };
  }
}
