import { describe, expect, it, vi } from 'vitest';
import { CARD_ELEMENT_IDS, MAIN_TEXT_MAX, answerChunks, renderCard, renderContinuationCard, withoutStreaming } from '../../apps/wb-bot/src/feishu/card-renderer.js';
import { createInitialState } from '../../apps/wb-bot/src/feishu/stream-state.js';

describe('card renderer', () => {
  it('renders SC-14 header and both stop/admin-cancel entry buttons when admin cancel is enabled', () => {
    const state = {
      ...createInitialState('codex', 'Codex', 'Codex'),
      text: 'Hello',
      sessionShortId: 'session-a1',
      adminCancelEnabled: true,
    };
    const card = renderCard(state) as {
      header: { title: { content: string } };
      body: { elements: Array<{ tag: string; columns?: Array<{ elements: Array<{ text?: { content: string }; behaviors?: Array<{ type: string; value: { action: string; shortId?: string } }> }> }> }> };
    };
    expect(card.header.title.content).toContain('⚡ Codex · codex');
    expect(card.header.title.content).toContain('🟢 running · #session-a1');
    const actionRow = card.body.elements.find((element) => element.tag === 'column_set');
    expect(actionRow?.columns?.[0]?.elements[0]?.text?.content).toBe('停止');
    expect(actionRow?.columns?.[0]?.elements[0]?.behaviors?.[0]).toEqual({ type: 'callback', value: { action: 'stop' } });
    expect(actionRow?.columns?.[1]?.elements[0]?.text?.content).toBe('叫停');
    expect(actionRow?.columns?.[1]?.elements[0]?.behaviors?.[0]).toEqual({ type: 'callback', value: { action: 'admin_cancel', shortId: 'session-a1' } });
  });

  it('renders stopped and done states distinctly in SC-14 header', () => {
    const stopped = renderCard({
      ...createInitialState('claude-code', 'Claude Code', 'Claude Code'),
      stopState: 'stopped',
      tools: [{ id: 'item_1', name: 'shell', input: {}, output: './README.md' }],
    }) as {
      header: { title: { content: string } };
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    const done = renderCard({ ...createInitialState('claude-code', 'Claude Code', 'Claude Code'), terminalState: 'done', stopState: 'stopped' }) as {
      header: { title: { content: string } };
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    const commandDone = renderCard({
      ...createInitialState('system', 'Weaverbird', 'bot'),
      terminalState: 'done',
      includeMeta: false,
      text: 'agent: codex\ncwd: -\n上下文: 无',
    }) as {
      header: { title: { content: string } };
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    expect(stopped.header.title.content).toContain('⏹ stopped');
    expect(done.header.title.content).toContain('⏹ stopped');
    expect(done.header.title.content).not.toContain('✅ 完成');
    expect(stopped.body.elements.at(-1)).toEqual({ tag: 'markdown', content: '操作: 已停止' });
    expect(done.body.elements.at(-1)).toEqual({ tag: 'markdown', content: '操作: 已停止' });
    expect(stopped.body.elements.some((element) => element.content?.includes('shell (item_1)'))).toBe(false);
    expect(commandDone.body.elements.some((element) => element.content === '操作: 已停止')).toBe(false);
    expect(commandDone.body.elements.some((element) => element.content?.includes('agent: system'))).toBe(false);
  });

  it('keeps thinking out of the answer: live tail in the process slot, collapsed panel when done', () => {
    const base = {
      ...createInitialState('claude-code', 'Claude Code', 'Claude Code'),
      text: 'final answer',
      thinking: 'internal reasoning',
    };
    type Element = { tag: string; element_id?: string; content?: string; expanded?: boolean; elements?: Array<{ content?: string }> };
    const live = renderCard(base) as { body: { elements: Element[] } };
    const main = live.body.elements.find((element) => element.element_id === CARD_ELEMENT_IDS.main);
    const process = live.body.elements.find((element) => element.element_id === CARD_ELEMENT_IDS.process);
    expect(main?.content).toBe('final answer');
    expect(process?.content).toContain('internal reasoning');

    const done = renderCard({ ...base, terminalState: 'done' }) as { body: { elements: Element[] } };
    const panel = done.body.elements.find((element) => element.tag === 'collapsible_panel');
    expect(panel?.expanded).toBe(false);
    expect(panel?.elements?.[0]?.content).toBe('internal reasoning');
    expect(done.body.elements.some((element) => element.tag === 'markdown' && element.content === 'final answer')).toBe(true);
  });

  it('hides thinking entirely when WB_CARD_SHOW_THINKING=0', () => {
    vi.stubEnv('WB_CARD_SHOW_THINKING', '0');
    try {
      const card = renderCard({
        ...createInitialState('claude-code', 'Claude Code', 'Claude Code'),
        terminalState: 'done',
        text: 'final answer',
        thinking: 'internal reasoning',
      });
      expect(JSON.stringify(card)).not.toContain('internal reasoning');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('live card is a streaming card with fixed slots and a static header', () => {
    const state = { ...createInitialState('codex', 'Codex', 'Codex'), text: '# Title\nbody', sessionShortId: 's1' };
    const card = renderCard(state) as {
      config: Record<string, unknown>;
      header: { title: { content: string } };
      body: { elements: Array<{ element_id?: string; content?: string }> };
    };
    expect(card.config['streaming_mode']).toBe(true);
    expect(card.body.elements.filter((element) => element.element_id).map((element) => element.element_id))
      .toEqual([CARD_ELEMENT_IDS.process, CARD_ELEMENT_IDS.main, CARD_ELEMENT_IDS.status]);
    expect(card.body.elements.find((element) => element.element_id === CARD_ELEMENT_IDS.main)?.content).toBe('#### Title\nbody');
    expect(card.body.elements.find((element) => element.element_id === CARD_ELEMENT_IDS.status)?.content).toMatch(/^✍️ 输出中 · \d\d:\d\d$/);
    // 耗时只在槽位里, header 进行中不变, 才能走元素级更新
    expect(renderCard({ ...state, startedAt: state.startedAt - 65_000 })).toMatchObject({ header: card.header });
    expect(withoutStreaming(card)['config']).toEqual({ wide_screen_mode: true, summary: { content: 'Codex 处理中…' } });
  });

  it('folds older tools while live and lists all of them in a collapsed panel when done', () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      name: i === 4 ? 'Bash' : 'Read',
      input: i === 4 ? { command: 'npm   test\n--run' } : { file_path: `/repo/f${i}.ts` },
      ...(i < 4 ? { output: 'ok' } : {}),
      ...(i === 2 ? { isError: true, output: 'ENOENT' } : {}),
    }));
    const state = { ...createInitialState('claude-code', 'Claude Code', 'Claude Code'), tools };
    const live = renderCard(state) as { body: { elements: Array<{ element_id?: string; content?: string }> } };
    const process = live.body.elements.find((element) => element.element_id === CARD_ELEMENT_IDS.process)?.content ?? '';
    expect(process.split('\n')).toEqual([
      '☕ 已调用 5 个工具, 最近 3 个:',
      '❌ **Read** `/repo/f2.ts`',
      '✅ **Read** `/repo/f3.ts`',
      '⏳ **Bash** `npm test --run`',
    ]);
    expect(live.body.elements.find((element) => element.element_id === CARD_ELEMENT_IDS.status)?.content).toContain('🧰 调用工具中');

    const done = renderCard({ ...state, terminalState: 'done', usage: { inputTokens: 12345, outputTokens: 678, costUsd: 0.0421 } }) as {
      body: { elements: Array<{ tag: string; content?: string; header?: { title: { content: string } }; elements?: Array<{ content: string }> }> };
    };
    const panel = done.body.elements.find((element) => element.tag === 'collapsible_panel');
    expect(panel?.header?.title.content).toBe('🧰 **5 个工具调用** · 1 个失败');
    expect(panel?.elements?.[0]?.content.split('\n')).toHaveLength(6);
    expect(panel?.elements?.[0]?.content).toContain('ENOENT');
    expect(done.body.elements.some((element) => element.content?.includes('usage: tokens 12.3k in / 678 out · $0.042'))).toBe(true);
  });

  it('shows input notices and the queued count', () => {
    const live = renderCard({ ...createInitialState('codex', 'Codex', 'Codex'), notices: ['附件未下载'], queuedCount: 2 });
    expect(JSON.stringify(live)).toContain('⚠️ 附件未下载');
    expect(JSON.stringify(live)).toContain('📥 已排队 2 条');
  });

  it('P2 #10: suppresses error badge when stopState is stopping or stopped', () => {
    const stoppingWithError = renderCard({
      ...createInitialState('claude-code', 'Claude Code', 'Claude Code'),
      stopState: 'stopping',
      terminalState: 'error',
      errorMessage: 'aborted',
    }) as { header: { title: { content: string } } };
    const stoppedWithError = renderCard({
      ...createInitialState('claude-code', 'Claude Code', 'Claude Code'),
      stopState: 'stopped',
      terminalState: 'error',
      errorMessage: 'aborted',
    }) as { header: { title: { content: string } } };
    const restartCard = renderCard({
      ...createInitialState('system', 'Weaverbird', 'bot'),
      stopState: 'running',
      terminalState: 'error',
      errorMessage: '服务重启',
    }) as { header: { title: { content: string } } };

    expect(stoppingWithError.header.title.content).toContain('🟡 stopping');
    expect(stoppingWithError.header.title.content).not.toContain('🔴 error');
    expect(stoppedWithError.header.title.content).toContain('⏹ stopped');
    expect(stoppedWithError.header.title.content).not.toContain('🔴 error');
    expect(restartCard.header.title.content).toContain('🔴 error');
  });
});

describe('long answers', () => {
  it('keeps the first chunk on the run card and renders the rest as continuation cards', () => {
    const paragraph = `${'很长的输出 '.repeat(200)}\n\n`;
    const text = `${paragraph.repeat(8)}\`\`\`ts\n${'const x = 1;\n'.repeat(800)}\`\`\`\n${paragraph.repeat(4)}`;
    const state = { ...createInitialState('claude-code', 'Claude Code', 'Claude Code'), text, terminalState: 'done' as const };
    const chunks = answerChunks(state);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAIN_TEXT_MAX);
      expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    const main = JSON.stringify(renderCard(state));
    expect(main).toContain(`共 ${chunks.length} 张卡`);
    expect(main).not.toContain('已降级显示');
    const continuation = renderContinuationCard(state, chunks[1]!, 2, chunks.length) as { header: { title: { content: string } } };
    expect(continuation.header.title.content).toBe(`🧠 Claude Code · claude-code · 续 2/${chunks.length}`);

    const liveCard = JSON.stringify(renderCard({ ...state, terminalState: 'running' }));
    expect(liveCard).toContain('结束后分卡发送全文');
  });
});
