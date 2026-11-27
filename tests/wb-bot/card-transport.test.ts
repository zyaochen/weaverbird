import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BindingStore, type CardEntity } from '../../apps/wb-bot/src/binding/store.js';
import { renderCard } from '../../apps/wb-bot/src/feishu/card-renderer.js';
import { FeishuApiError, FeishuCardTransport, type CardKitApi } from '../../apps/wb-bot/src/feishu/card-transport.js';
import { createInitialState, type StreamState } from '../../apps/wb-bot/src/feishu/stream-state.js';

type Call = { op: string; args: unknown[] };

function fakeApi(overrides: Partial<CardKitApi> = {}): { api: CardKitApi; calls: Call[] } {
  const calls: Call[] = [];
  const record = (op: string) => async (...args: unknown[]) => { calls.push({ op, args }); };
  const api: CardKitApi = {
    createCard: async (...args) => { calls.push({ op: 'createCard', args }); return 'card_1'; },
    updateCard: record('updateCard'),
    setStreaming: record('setStreaming'),
    setElementContent: record('setElementContent'),
    replyWithCardId: async (...args) => { calls.push({ op: 'replyWithCardId', args }); return 'om_reply'; },
    replyMessageCard: async (...args) => { calls.push({ op: 'replyMessageCard', args }); return 'om_legacy'; },
    patchMessageCard: record('patchMessageCard'),
    ...overrides,
  };
  return { api, calls };
}

function memoryStore(): { get(id: string): CardEntity | null; save(id: string, entity: CardEntity): void; rows: Map<string, CardEntity> } {
  const rows = new Map<string, CardEntity>();
  return { rows, get: (id) => rows.get(id) ?? null, save: (id, entity) => { rows.set(id, { ...entity }); } };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function live(patch: Partial<StreamState> = {}): StreamState {
  return { ...createInitialState('codex', 'Codex', 'Codex'), startedAt: Date.now(), ...patch };
}

describe('FeishuCardTransport', () => {
  it('creates a CardKit entity for live cards and streams only changed slots', async () => {
    const { api, calls } = fakeApi();
    const store = memoryStore();
    const transport = new FeishuCardTransport(api, store, { streaming: true, logger });
    const state = live();
    expect(await transport.reply('om_src', renderCard(state))).toBe('om_reply');
    expect(transport.isStreamingCard('om_reply')).toBe(true);

    calls.length = 0;
    await transport.update('om_reply', renderCard({ ...state, text: 'hello' }));
    await transport.update('om_reply', renderCard({ ...state, text: 'hello world' }));
    const mainWrites = calls.filter((call) => call.op === 'setElementContent' && call.args[1] === 'wb_main');
    expect(mainWrites.map((call) => call.args[2])).toEqual(['hello', 'hello world']);
    expect(calls.some((call) => call.op === 'updateCard')).toBe(false);
    const sequences = calls.map((call) => call.args.at(-1) as number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(store.rows.get('om_reply')?.sequence).toBe(sequences.at(-1));
  });

  it('closes streaming before the final full update', async () => {
    const { api, calls } = fakeApi();
    const transport = new FeishuCardTransport(api, memoryStore(), { streaming: true, logger });
    const state = live();
    await transport.reply('om_src', renderCard(state));
    calls.length = 0;
    await transport.update('om_reply', renderCard({ ...state, text: 'done', terminalState: 'done' }));
    expect(calls.map((call) => call.op)).toEqual(['setStreaming', 'updateCard']);
    expect(calls[0]!.args[1]).toBe(false);
    expect(JSON.parse(calls[1]!.args[1] as string).config.streaming_mode).toBeUndefined();
    expect(transport.isStreamingCard('om_reply')).toBe(false);
  });

  it('re-enables streaming once when the platform closed it (200850)', async () => {
    let failed = false;
    const { api, calls } = fakeApi({
      async setElementContent(...args) {
        calls.push({ op: 'setElementContent', args });
        if (!failed) { failed = true; throw new FeishuApiError('cardkit.cardElement.content', 200850, 'streaming timeout'); }
      },
    });
    const transport = new FeishuCardTransport(api, memoryStore(), { streaming: true, logger });
    const state = live();
    await transport.reply('om_src', renderCard(state));
    calls.length = 0;
    await transport.update('om_reply', renderCard({ ...state, text: 'hi' }));
    expect(calls.map((call) => call.op)).toEqual(['setElementContent', 'setStreaming', 'setElementContent', 'setElementContent']);
    expect(calls[1]!.args[1]).toBe(true);
  });

  it('falls back to a full update when element streaming fails, then to message patch', async () => {
    const { api, calls } = fakeApi({
      async setElementContent() { throw new FeishuApiError('cardkit.cardElement.content', 300500, 'element not found'); },
      async updateCard() { throw new FeishuApiError('cardkit.card.update', 300400, 'bad card'); },
    });
    const transport = new FeishuCardTransport(api, memoryStore(), { streaming: true, logger });
    const state = live();
    await transport.reply('om_src', renderCard(state));
    calls.length = 0;
    await transport.update('om_reply', renderCard({ ...state, text: 'x' }));
    expect(calls.map((call) => call.op)).toEqual(['patchMessageCard']);
    // 实体已不可用, 之后直接走消息接口
    await transport.update('om_reply', renderCard({ ...state, text: 'xy' }));
    expect(calls.map((call) => call.op)).toEqual(['patchMessageCard', 'patchMessageCard']);
  });

  it('rethrows rate limits so the pipeline can back off', async () => {
    const { api } = fakeApi({
      async setElementContent() { throw new FeishuApiError('cardkit.cardElement.content', 230020, 'rate limited'); },
    });
    const transport = new FeishuCardTransport(api, memoryStore(), { streaming: true, logger });
    const state = live();
    await transport.reply('om_src', renderCard(state));
    await expect(transport.update('om_reply', renderCard({ ...state, text: 'x' }))).rejects.toMatchObject({ code: 230020 });
  });

  it('uses message cards when streaming is disabled, the card is static, or create fails', async () => {
    const disabled = fakeApi();
    const off = new FeishuCardTransport(disabled.api, memoryStore(), { streaming: false, logger });
    expect(await off.reply('om_src', renderCard(live()))).toBe('om_legacy');
    const sent = disabled.calls[0]!.args[1] as { config: Record<string, unknown> };
    expect(sent.config['streaming_mode']).toBeUndefined();
    await off.update('om_legacy', renderCard(live({ text: 'a' })));
    expect(disabled.calls.map((call) => call.op)).toEqual(['replyMessageCard', 'patchMessageCard']);

    const failing = fakeApi({ async createCard() { throw new FeishuApiError('cardkit.card.create', 99991672, 'no scope'); } });
    const on = new FeishuCardTransport(failing.api, memoryStore(), { streaming: true, logger });
    expect(await on.reply('om_src', renderCard(live()))).toBe('om_legacy');
    expect(await on.reply('om_src', renderCard({ ...createInitialState('system', 'Weaverbird', 'bot'), text: 'help' }))).toBe('om_legacy');
  });

  it('resumes the sequence from the store after a restart', async () => {
    const { api, calls } = fakeApi();
    const store = memoryStore();
    store.save('om_reply', { cardId: 'card_9', sequence: 41, streaming: true });
    const transport = new FeishuCardTransport(api, store, { streaming: true, logger });
    await transport.update('om_reply', renderCard({ ...live(), terminalState: 'error', errorMessage: '服务重启' }));
    expect(calls.map((call) => [call.op, call.args[0], call.args.at(-1)])).toEqual([
      ['setStreaming', 'card_9', 42],
      ['updateCard', 'card_9', 43],
    ]);
  });
});

describe('BindingStore card_entity', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wb-card-entity-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persists, isolates by bot and prunes card entities', () => {
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    try {
      store.saveCardEntity('default', 'om_1', { cardId: 'card_1', sequence: 3, streaming: true });
      store.saveCardEntity('default', 'om_1', { cardId: 'card_1', sequence: 4, streaming: false });
      expect(store.getCardEntity('default', 'om_1')).toEqual({ cardId: 'card_1', sequence: 4, streaming: false });
      expect(store.getCardEntity('other', 'om_1')).toBeNull();
      expect(store.pruneCardEntities(60_000)).toBe(0);
      expect(store.pruneCardEntities(-1)).toBe(1);
      expect(store.getCardEntity('default', 'om_1')).toBeNull();
    } finally {
      store.close();
    }
    const reopened = new BindingStore(join(dir, 'wb-bot.db'));
    expect(reopened.migrationResult.success).toBe(true);
    reopened.close();
  });
});
