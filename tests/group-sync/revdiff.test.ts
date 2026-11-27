import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMockGroupSyncReviewDiffTransport,
  groupSyncMockReviewDiffLedgerPath,
  publishReviewDiffReply,
  type GroupSyncConfig,
  type GroupSyncReviewDiffReplyInput,
  type GroupSyncReviewDiffTransport,
} from '../../packages/core/src/group-sync/index.js';

const roots: string[] = [];
const config: GroupSyncConfig = {
  enabled: true,
  transport: 'mock',
  rpc_timeout_ms: 50,
  sweep_interval_ms: 10_000,
};

function statePath(root: string, runId: string): string {
  return join(root, 'runs', 'default', runId, 'group-sync-review-diffs.json');
}

function replyFixture(overrides: Partial<GroupSyncReviewDiffReplyInput> = {}): GroupSyncReviewDiffReplyInput {
  return {
    request_id: 'req-revdiff-1',
    session_id: 'sid-revdiff-1',
    run_id: 'run-revdiff-1',
    revision: 3,
    source_thread_id: 'oc_source_thread',
    source_message_id: 'om_source_message',
    review_id: 'review-diff-1',
    title: 'Review diff summary',
    summary: '- touched group-sync\n- kept router redlines intact',
    diff_paths: ['/tmp/review-diff-1.md'],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('group-sync review diff reply', () => {
  it('publishes a review diff reply once and preserves the triad', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-revdiff-'));
    roots.push(root);
    const reply = replyFixture();
    const transport = createMockGroupSyncReviewDiffTransport(root);

    const first = await publishReviewDiffReply({ dataDir: root, reply, config, transport });
    const second = await publishReviewDiffReply({ dataDir: root, reply, config, transport });

    expect(first.sync_failed).toBe(false);
    expect(second.sync_failed).toBe(false);
    expect(second.reply.reply_id).toBe(first.reply.reply_id);

    const state = JSON.parse(readFileSync(statePath(root, reply.run_id), 'utf8')) as Record<string, unknown>;
    expect(state['session_id']).toBe(reply.session_id);
    expect(state['run_id']).toBe(reply.run_id);
    expect(state['last_revision']).toBe(reply.revision);
    expect(readFileSync(groupSyncMockReviewDiffLedgerPath(root), 'utf8')).toContain(`"review_id":"${reply.review_id}"`);
    expect(readFileSync(groupSyncMockReviewDiffLedgerPath(root), 'utf8')).toContain(`"source_thread_id":"${reply.source_thread_id}"`);
    expect((state['replies'] as Array<Record<string, unknown>>)).toHaveLength(1);
  });

  it('records a fail-safe reply state when transport rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-revdiff-'));
    roots.push(root);
    const reply = replyFixture({ request_id: 'req-revdiff-2', run_id: 'run-revdiff-2', review_id: 'review-diff-2' });
    const transport: GroupSyncReviewDiffTransport = {
      publishReviewDiff: vi.fn().mockRejectedValue(new Error('review diff boom')),
    };

    const result = await publishReviewDiffReply({ dataDir: root, reply, config, transport });

    expect(result.sync_failed).toBe(true);
    expect(result.reply.sync_failed).toBe(true);
    expect(result.reply.last_error).toBe('review diff boom');
    const state = JSON.parse(readFileSync(statePath(root, reply.run_id), 'utf8')) as Record<string, unknown>;
    expect((state['replies'] as Array<Record<string, unknown>>)[0]?.['sync_failed']).toBe(true);
    expect((state['replies'] as Array<Record<string, unknown>>)[0]?.['last_error']).toBe('review diff boom');
  });

  it('keeps run identity stable while allowing multiple diff replies to coexist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-revdiff-'));
    roots.push(root);
    const firstReply = replyFixture({ request_id: 'req-revdiff-3', run_id: 'run-revdiff-3', review_id: 'review-diff-3a' });
    const secondReply = replyFixture({
      request_id: 'req-revdiff-4',
      run_id: 'run-revdiff-3',
      review_id: 'review-diff-3b',
      title: 'Follow-up diff summary',
      summary: '- second diff block',
      diff_paths: ['/tmp/review-diff-3b.md'],
    });
    const transport = createMockGroupSyncReviewDiffTransport(root);

    await publishReviewDiffReply({ dataDir: root, reply: firstReply, config, transport });
    const result = await publishReviewDiffReply({ dataDir: root, reply: secondReply, config, transport });

    expect(result.sync_failed).toBe(false);
    const state = JSON.parse(readFileSync(statePath(root, firstReply.run_id), 'utf8')) as Record<string, unknown>;
    const replies = state['replies'] as Array<Record<string, unknown>>;
    expect(replies).toHaveLength(2);
    expect(replies.map((item) => item['review_id'])).toEqual(['review-diff-3a', 'review-diff-3b']);
    expect(new Set(replies.map((item) => item['session_id']))).toEqual(new Set([firstReply.session_id]));
    expect(new Set(replies.map((item) => item['run_id']))).toEqual(new Set([firstReply.run_id]));
    expect(new Set(replies.map((item) => item['revision']))).toEqual(new Set([firstReply.revision]));
  });
});
