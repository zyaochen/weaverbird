import { describe, expect, it } from 'vitest';
import { normalizeTopic } from '../../apps/wb-bot/src/feishu/topic-key.js';

describe('topic key normalization', () => {
  it('derives an idempotent canonical topic key for group thread roots and dm fallbacks', () => {
    const groupRoot = normalizeTopic({ chatId: 'oc_group', messageId: 'om_root', chatType: 'group' });
    expect(groupRoot).toBe('root:om_root');
    expect(normalizeTopic({ chatId: 'oc_group', rootId: 'om_root', messageId: 'om_reply', chatType: 'group' })).toBe(groupRoot);
    expect(normalizeTopic({ rootId: groupRoot, chatId: 'oc_group' })).toBe(groupRoot);

    const dmTopic = normalizeTopic({ chatId: 'oc_dm', messageId: 'om_dm', chatType: 'p2p' });
    expect(dmTopic).toBe('chat:oc_dm');
    expect(normalizeTopic({ chatId: dmTopic, chatType: 'p2p' })).toBe(dmTopic);
  });
});
