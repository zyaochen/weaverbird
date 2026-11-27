import { describe, expect, it } from 'vitest';
import { parseLarkCardActionPayload, parseLarkMessagePayload } from '../../apps/wb-bot/src/feishu/transport.js';

describe('lark payload parsing', () => {
  it('parses top-level message payloads from EventDispatcher', () => {
    const payload = parseLarkMessagePayload({
      header: { event_id: 'evt-1' },
      sender: { sender_id: { open_id: 'ou_123' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        root_id: 'or_1',
        content: '{"text":"hello"}',
      },
    });

    expect(payload.header?.event_id).toBe('evt-1');
    expect(payload.sender?.sender_id?.open_id).toBe('ou_123');
    expect(payload.message?.content).toBe('{"text":"hello"}');
  });

  it('parses top-level card action payloads from EventDispatcher', () => {
    const payload = parseLarkCardActionPayload({
      header: { event_id: 'evt-2' },
      operator: { open_id: 'ou_456' },
      context: { open_message_id: 'om_2', open_chat_id: 'oc_2' },
      action: { value: { action: 'admin_cancel', shortId: 'sess-001', requestId: 'req-001' } },
    });

    expect(payload.operator?.open_id).toBe('ou_456');
    expect(payload.context?.open_message_id).toBe('om_2');
    expect(payload.action?.value?.action).toBe('admin_cancel');
    expect(payload.action?.value?.shortId).toBe('sess-001');
    expect(payload.action?.value?.requestId).toBe('req-001');
  });

  it('rejects invalid payload shapes', () => {
    expect(() => parseLarkMessagePayload({ header: { event_id: 1 } })).toThrow();
    expect(() => parseLarkCardActionPayload({ event: { action: { value: 'stop' } } })).toThrow();
  });
});
