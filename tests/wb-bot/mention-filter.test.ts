import { describe, expect, it } from 'vitest';
import { parseLarkMessagePayload, readChatType, readMentions, shouldDispatchMessageForBot } from '../../apps/wb-bot/src/feishu/transport.js';

function makePayload(message: Record<string, unknown>) {
  return parseLarkMessagePayload({
    header: { event_id: 'evt-1' },
    sender: { sender_id: { open_id: 'ou_user' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      root_id: 'or_1',
      content: JSON.stringify({ text: 'hello' }),
      ...message,
    },
  });
}

describe('mention filter', () => {
  it('dispatches p2p messages without mentions', () => {
    const payload = makePayload({ chat_type: 'p2p' });
    expect(shouldDispatchMessageForBot(payload, 'ou_self')).toBe(true);
  });

  it('dispatches group messages when self is mentioned', () => {
    const payload = makePayload({
      chat_type: 'group',
      mentions: [{ id: { open_id: 'ou_self' } }],
    });
    expect(shouldDispatchMessageForBot(payload, 'ou_self')).toBe(true);
  });

  it('does not dispatch group messages mentioned to another bot', () => {
    const payload = makePayload({
      chat_type: 'group',
      mentions: [{ id: { open_id: 'ou_other_bot' } }],
    });
    expect(shouldDispatchMessageForBot(payload, 'ou_self')).toBe(false);
  });

  it('does not dispatch group messages with no mentions', () => {
    const payload = makePayload({ chat_type: 'group' });
    expect(shouldDispatchMessageForBot(payload, 'ou_self')).toBe(false);
  });

  it('does not dispatch group messages with empty mentions array', () => {
    const payload = makePayload({ chat_type: 'group', mentions: [] });
    expect(shouldDispatchMessageForBot(payload, 'ou_self')).toBe(false);
  });

  it('dispatches topic messages when self is mentioned', () => {
    const payload = makePayload({
      chat_type: 'topic',
      mentions: [{ id: { open_id: 'ou_self' } }],
    });
    expect(shouldDispatchMessageForBot(payload, 'ou_self')).toBe(true);
  });

  it('defaults to safe false when chat_type is missing', () => {
    const payload = makePayload({
      mentions: [{ id: { open_id: 'ou_self' } }],
    });
    expect(shouldDispatchMessageForBot(payload, 'ou_self')).toBe(false);
  });

  it('defaults to safe false when event is malformed', () => {
    const payload = parseLarkMessagePayload({
      header: { event_id: 'evt-bad' },
      sender: { sender_id: { open_id: 'ou_user' } },
    });
    expect(shouldDispatchMessageForBot(payload, 'ou_self')).toBe(false);
  });

  it('requires strict open_id equality', () => {
    const payload = makePayload({
      chat_type: 'group',
      mentions: [{ id: { open_id: 'ou_self_extra' } }],
    });
    expect(shouldDispatchMessageForBot(payload, 'ou_self')).toBe(false);
  });

  it('reads chat type from top-level message payload', () => {
    const payload = makePayload({ chat_type: 'group' });
    expect(readChatType(payload)).toBe('group');
  });

  it('reads mentions from top-level message payload', () => {
    const mentions = [{ id: { open_id: 'ou_self' } }];
    const payload = makePayload({ chat_type: 'group', mentions });
    expect(readMentions(payload)).toEqual(mentions);
  });

  it('returns empty mentions array when missing', () => {
    const payload = makePayload({ chat_type: 'group' });
    expect(readMentions(payload)).toEqual([]);
  });
});
