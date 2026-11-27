import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounceMsFromEnv, InboundDebouncer, mergeMessageEvents } from '../../apps/wb-bot/src/feishu/pending-queue.js';
import type { MessageEvent } from '../../apps/wb-bot/src/feishu/event-handler.js';

function msg(id: string, text: string, extra: Partial<MessageEvent> = {}): MessageEvent {
  return { eventId: `e-${id}`, userOpenId: 'u1', threadId: 't1', messageId: id, text, ...extra };
}

describe('mergeMessageEvents', () => {
  it('joins text, keeps the last message as reply target and remembers the others', () => {
    const merged = mergeMessageEvents([
      msg('m1', '报错如下', { resources: [{ type: 'image', fileKey: 'img_1' }] }),
      msg('m2', '', { parentId: 'om_p' }),
      msg('m3', '帮我看下', { resources: [{ type: 'file', fileKey: 'file_1' }] }),
    ]);
    expect(merged.messageId).toBe('m3');
    expect(merged.eventId).toBe('e-m1+2');
    expect(merged.text).toBe('报错如下\n\n帮我看下');
    expect(merged.mergedMessageIds).toEqual(['m1', 'm2']);
    expect(merged.resources).toEqual([{ type: 'image', fileKey: 'img_1' }, { type: 'file', fileKey: 'file_1' }]);
    expect(merged.parentId).toBe('om_p');
  });

  it('returns a single event unchanged', () => {
    const one = msg('m1', 'hi');
    expect(mergeMessageEvents([one])).toBe(one);
  });
});

describe('InboundDebouncer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('merges messages of one scope inside the quiet window', () => {
    const out: MessageEvent[] = [];
    const debouncer = new InboundDebouncer(600, (event) => out.push(event));
    debouncer.push(msg('m1', 'a'));
    vi.advanceTimersByTime(500);
    debouncer.push(msg('m2', 'b'));
    vi.advanceTimersByTime(500);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('a\n\nb');
  });

  it('keeps scopes apart', () => {
    const out: MessageEvent[] = [];
    const debouncer = new InboundDebouncer(600, (event) => out.push(event));
    debouncer.push(msg('m1', 'a'));
    debouncer.push(msg('m2', 'b', { threadId: 't2' }));
    vi.advanceTimersByTime(600);
    expect(out.map((event) => event.text).sort()).toEqual(['a', 'b']);
  });

  it('flushes pending text before dispatching a slash command immediately', () => {
    const out: MessageEvent[] = [];
    const debouncer = new InboundDebouncer(600, (event) => out.push(event));
    debouncer.push(msg('m1', 'a'));
    debouncer.push(msg('m2', '/stop'));
    expect(out.map((event) => event.text)).toEqual(['a', '/stop']);
  });

  it('drops redelivered event ids and dispatches directly when disabled', () => {
    const out: MessageEvent[] = [];
    const debouncer = new InboundDebouncer(0, (event) => out.push(event));
    debouncer.push(msg('m1', 'a'));
    debouncer.push(msg('m1', 'a'));
    expect(out).toHaveLength(1);
  });

  it('caps a batch at 10 messages', () => {
    const out: MessageEvent[] = [];
    const debouncer = new InboundDebouncer(600, (event) => out.push(event));
    for (let i = 0; i < 10; i++) debouncer.push(msg(`m${i}`, `t${i}`));
    expect(out).toHaveLength(1);
    expect(out[0]!.mergedMessageIds).toHaveLength(9);
  });

  it('reads WB_MESSAGE_DEBOUNCE_MS', () => {
    expect(debounceMsFromEnv({})).toBe(600);
    expect(debounceMsFromEnv({ WB_MESSAGE_DEBOUNCE_MS: '0' })).toBe(0);
    expect(debounceMsFromEnv({ WB_MESSAGE_DEBOUNCE_MS: 'x' })).toBe(600);
  });
});

describe('InboundDebouncer.drop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('removes a recalled message from the quiet window', () => {
    const out: MessageEvent[] = [];
    const debouncer = new InboundDebouncer(600, (event) => out.push(event));
    debouncer.push(msg('m1', 'a'));
    debouncer.push(msg('m2', 'b'));
    expect(debouncer.drop('m1')).toBe(true);
    expect(debouncer.drop('m9')).toBe(false);
    vi.advanceTimersByTime(600);
    expect(out.map((event) => event.text)).toEqual(['b']);
    debouncer.push(msg('m3', 'c'));
    expect(debouncer.drop('m3')).toBe(true);
    vi.advanceTimersByTime(600);
    expect(out).toHaveLength(1);
  });
});
