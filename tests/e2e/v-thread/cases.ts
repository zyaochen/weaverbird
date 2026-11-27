export const V_THREAD_CASE_IDS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'] as const;

export type VThreadCaseId = typeof V_THREAD_CASE_IDS[number];

export type VThreadCaseMode = 'automated' | 'manual';

export type VThreadEvidence = 'binding' | 'continuation' | 'inflight' | 'message' | 'audit' | 'cleanup';

export type VThreadCaseDefinition = {
  id: VThreadCaseId;
  title: string;
  mode: VThreadCaseMode;
  firstEgressSurface: string;
  description: string;
  storeAssertion: string;
  messageAssertion?: string;
  auditAssertion?: string;
  cleanupAssertion?: string;
  evidence: readonly VThreadEvidence[];
};

export function buildVThreadCases(): readonly VThreadCaseDefinition[] {
  return [
    {
      id: 'E1',
      title: 'group top-level root topic',
      mode: 'automated',
      firstEgressSurface: 'lark-cli im +messages-send --as user --chat-id <chat_id> --text <prompt>',
      description: 'Send a top-level group message and assert the canonical topic becomes root:<message_id>.',
      storeAssertion: 'binding/inflight resolve on root:<message_id> and create a new canonical topic for the owner.',
      messageAssertion: 'the owner-sent root message gets an om_* id that is reused as the canonical topic root.',
      evidence: ['binding', 'inflight', 'message'],
    },
    {
      id: 'E2',
      title: 'reply stays on same topic',
      mode: 'automated',
      firstEgressSurface: 'lark-cli im +messages-reply --as user --message-id <root_message_id> --reply-in-thread --text <prompt>',
      description: 'Reply inside the root thread and assert chat_id -> root_id normalization does not allocate a second topic.',
      storeAssertion: 'binding/continuation/inflight queried via reply topic resolve to the same root:<root_id> topic and same stored row.',
      messageAssertion: 'reply message root_id matches the original root message id.',
      evidence: ['binding', 'continuation', 'inflight', 'message'],
    },
    {
      id: 'E3',
      title: 'session continuation survives follow-up',
      mode: 'automated',
      firstEgressSurface: 'lark-cli im +messages-reply --as user --message-id <root_message_id> --reply-in-thread --text <follow_up>',
      description: 'Send another thread reply and assert continuation stays on the same canonical topic identity.',
      storeAssertion: 'continuation remains reachable by the same root topic key and the derived session id stays bot:user:root:<root_id>.',
      messageAssertion: 'the second follow-up is still attached to the same root thread, not a new top-level message.',
      evidence: ['binding', 'continuation', 'message'],
    },
    {
      id: 'E4',
      title: 'finalizer without origin uses send',
      mode: 'automated',
      firstEgressSurface: 'finalizeRun(entry.origin_message_id=null) -> client.sendCard(chat_id, card)',
      description: 'Drive the no-origin finalizer branch and assert it sends a top-level card instead of a thread reply.',
      storeAssertion: 'the owner/root topic binding, continuation, and inflight state stay unchanged while the finalizer emits a top-level send.',
      messageAssertion: 'the finalized card is a top-level chat message with no root_id/parent_id relation to the root thread.',
      evidence: ['binding', 'continuation', 'inflight', 'message'],
    },
    {
      id: 'E5',
      title: 'finalizer with origin uses reply_in_thread',
      mode: 'automated',
      firstEgressSurface: 'finalizeRun(entry.origin_message_id=<root>) -> client.replyCard(<root>, card)',
      description: 'Drive the origin-aware finalizer branch and assert it replies inside the existing thread.',
      storeAssertion: 'the owner/root topic binding, continuation, and inflight state stay unchanged while the finalizer emits a thread reply.',
      messageAssertion: 'the finalized card lands under the root thread with root_id=<root_message_id>.',
      evidence: ['binding', 'continuation', 'inflight', 'message'],
    },
    {
      id: 'E6',
      title: 'operator admin_cancel shortcut',
      mode: 'manual',
      firstEgressSurface: 'owner clicks the admin_cancel callback on the live card',
      description: 'Use the real card callback path and assert operator shortcut stays on the local stop path without widening ingress contracts.',
      storeAssertion: 'the active session tied to the live card transitions to stopping without rebinding the topic.',
      auditAssertion: 'no admin_cancel audit entry is written for the operator shortcut path.',
      evidence: ['binding', 'audit'],
    },
    {
      id: 'E7',
      title: 'cleanup is idempotent',
      mode: 'automated',
      firstEgressSurface: 'store cleanup + optional message revoke of tracked test artifacts',
      description: 'Clean only the test-created store rows and messages, then rerun cleanup to prove idempotence.',
      storeAssertion: 'tracked binding/continuation/inflight/alias rows are gone after cleanup and remain gone on a second cleanup pass.',
      cleanupAssertion: 'only tracked test message ids are targeted for revoke; unrelated rows/messages are left untouched.',
      evidence: ['binding', 'continuation', 'inflight', 'cleanup'],
    },
  ];
}
