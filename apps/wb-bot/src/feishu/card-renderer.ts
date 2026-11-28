import type { StreamState, ToolEntry } from './stream-state.js';
import { getAgentDisplay } from '../agent-display.js';
import { splitMarkdown, toFeishuMarkdown } from './markdown-style.js';

/**
 * 运行卡两种形态:
 *
 * - 进行中 (live): 结构固定、带 element_id 槽位 + `config.streaming_mode`. 传输层
 *   (card-transport.ts) 发现结构没变就只把槽位文本推给 `cardElement.content`,
 *   正文得到飞书原生打字机效果; 所以 live 卡里会变的内容 (耗时、阶段、工具) 都只能放在槽位里,
 *   header 与按钮在进行中保持不变.
 * - 结束 / 停止中 / 系统卡 (static): 完整重排, 思考与工具收进折叠面板, 页脚带用量.
 */

export const CARD_ELEMENT_IDS = {
  process: 'wb_process',
  main: 'wb_main',
  status: 'wb_status',
} as const;

export const STREAMING_CONFIG = {
  print_frequency_ms: { default: 30, android: 25, ios: 40, pc: 50 },
  print_step: { default: 2, android: 3, ios: 4, pc: 5 },
  print_strategy: 'fast',
};

/** 单个 markdown 组件的安全长度; 超出部分由续卡接着发. */
export const MAIN_TEXT_MAX = 12000;
const THINKING_LIVE_TAIL = 300;
const THINKING_FINAL_MAX = 1500;
const LIVE_TOOL_LINES = 3;
const TOOL_SUMMARY_MAX = 80;
const CARD_SIZE_LIMIT = 28 * 1024;

function formatElapsed(startedAt: number): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function shortCwd(cwd: string | undefined): string {
  if (!cwd) return '-';
  const home = process.env['HOME'] ?? '';
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function statusBadge(state: StreamState): string {
  if (state.stopState === 'stopped') return '⏹ stopped';
  if (state.stopState === 'stopping') return '🟡 stopping';
  if (state.terminalState === 'error') return '🔴 error';
  if (state.terminalState === 'done') return '✅ 完成';
  return '🟢 running';
}

function agentLine(state: StreamState): string {
  return `${getAgentDisplay(state.agentId).emoji} ${state.agentDisplayName} · ${state.agentId}`;
}

function buildHeader(state: StreamState, withElapsed: boolean): string {
  const sessionLine = state.sessionShortId ? ` · #${state.sessionShortId}` : '';
  const elapsed = withElapsed ? ` · ${formatElapsed(state.startedAt)}` : '';
  return `${agentLine(state)}\n${statusBadge(state)}${sessionLine}${elapsed} · ${shortCwd(state.cwd)}`;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…`;
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars)}`;
}

function showThinking(): boolean {
  return process.env['WB_CARD_SHOW_THINKING'] !== '0';
}

/** 进行中的 agent 卡走流式形态; 系统提示卡 / 停止中 / 已结束都走完整卡. */
export function isLiveState(state: StreamState): boolean {
  return state.agentId !== 'system' && state.terminalState === 'running' && state.stopState === 'running';
}

const INPUT_SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt'];

/** 工具参数的一句话摘要: 优先取常见的语义字段, 否则退回 JSON. */
export function toolSummary(tool: ToolEntry): string {
  const input = tool.input;
  let summary = '';
  if (typeof input === 'string') {
    summary = input;
  } else if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const key = INPUT_SUMMARY_KEYS.find((candidate) => typeof record[candidate] === 'string' && record[candidate] !== '');
    summary = key ? String(record[key]) : JSON.stringify(record);
  }
  summary = summary.replace(/\s+/g, ' ').trim();
  if (summary === '{}') return '';
  return summary.length > TOOL_SUMMARY_MAX ? `${summary.slice(0, TOOL_SUMMARY_MAX)}…` : summary;
}

function toolLine(tool: ToolEntry, finished: boolean): string {
  const icon = tool.isError ? '❌' : tool.output !== undefined || finished ? '✅' : '⏳';
  const summary = toolSummary(tool).replace(/`/g, "'");
  return `${icon} **${tool.name}**${summary ? ` \`${summary}\`` : ''}`;
}

function liveProcessText(state: StreamState): string {
  const lines: string[] = [];
  const thinking = state.thinking.trim();
  if (thinking && showThinking()) lines.push(`🧠 ${tail(thinking, THINKING_LIVE_TAIL).replace(/\s*\n+\s*/g, ' ')}`);
  if (state.tools.length > LIVE_TOOL_LINES) lines.push(`☕ 已调用 ${state.tools.length} 个工具, 最近 ${LIVE_TOOL_LINES} 个:`);
  for (const tool of state.tools.slice(-LIVE_TOOL_LINES)) lines.push(toolLine(tool, false));
  return lines.join('\n');
}

function livePhase(state: StreamState): string {
  const lastTool = state.tools.at(-1);
  if (lastTool && lastTool.output === undefined && !lastTool.isError) return '🧰 调用工具中';
  if (state.text.trim()) return '✍️ 输出中';
  return '🧠 思考中';
}

function noticeLines(state: StreamState): string[] {
  const lines = (state.notices ?? []).map((notice) => `⚠️ ${notice}`);
  if (state.queuedCount && state.terminalState === 'running') {
    lines.push(`📥 已排队 ${state.queuedCount} 条, 本轮结束后自动接着处理`);
  }
  return lines;
}

function liveStatusText(state: StreamState): string {
  const lines = [`${livePhase(state)} · ${formatElapsed(state.startedAt)}`, ...noticeLines(state)];
  if (state.text.trim().length > MAIN_TEXT_MAX) lines.push('📄 输出较长, 结束后分卡发送全文');
  return lines.join('\n');
}

/** 结束卡正文按长度切块 (不切在代码块中间); 第一块留在运行卡里, 其余作为续卡发出. */
export function answerChunks(state: StreamState): string[] {
  const text = state.text.trim();
  if (!text) return [];
  if (state.agentId === 'system') return [toFeishuMarkdown(text)];
  return splitMarkdown(toFeishuMarkdown(text), MAIN_TEXT_MAX);
}

export function renderContinuationCard(state: StreamState, chunk: string, index: number, total: number): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, summary: { content: `续 ${index}/${total}` } },
    header: { title: { tag: 'plain_text', content: `${agentLine(state)} · 续 ${index}/${total}` } },
    body: { elements: [{ tag: 'markdown', content: chunk }] },
  };
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function usageText(state: StreamState): string {
  const usage = state.usage;
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(`tokens ${formatTokens(usage.inputTokens ?? 0)} in / ${formatTokens(usage.outputTokens ?? 0)} out`);
  }
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 1 ? 3 : 2)}`);
  return parts.join(' · ');
}

function stopButtonText(state: StreamState): string {
  if (state.stopState === 'stopped') return '已停止';
  if (state.stopState === 'stopping') return '停止中...';
  return '停止';
}

function buttonRow(buttons: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    tag: 'column_set',
    columns: buttons.map((button) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [button],
    })),
  };
}

function callbackButton(label: string, action: string, type: 'default' | 'primary_filled' = 'default'): Record<string, unknown> {
  return { tag: 'button', text: { tag: 'plain_text', content: label }, type, behaviors: [{ type: 'callback', value: { action } }] };
}

/** 结束卡的后续操作; 回调里校验发起人, 见 EventHandler.handleRunFollowUpAction. */
export const RUN_FOLLOW_UP_ACTIONS = { retry: 'run_retry', continue: 'run_continue', reset: 'run_reset' } as const;
export const SEND_ARTIFACT_ACTION = 'send_artifact';

function artifactElements(state: StreamState): Array<Record<string, unknown>> {
  const artifacts = state.artifacts ?? [];
  if (artifacts.length === 0) return [];
  return [
    { tag: 'markdown', content: `📎 本轮产物: ${artifacts.map((artifact) => `\`${artifact.label}\``).join(' ')}`, text_size: 'notation' },
    buttonRow(artifacts.map((artifact, index) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: `发送 ${artifact.label.split('/').pop()}` },
      type: 'default',
      behaviors: [{ type: 'callback', value: { action: SEND_ARTIFACT_ACTION, index } }],
    }))),
  ];
}

function buildActionElements(state: StreamState): Array<Record<string, unknown>> {
  if (state.terminalState !== 'running' && state.stopState === 'running') {
    if (state.agentId === 'system') return [];
    return [buttonRow([
      callbackButton('继续', RUN_FOLLOW_UP_ACTIONS.continue, 'primary_filled'),
      callbackButton('重试', RUN_FOLLOW_UP_ACTIONS.retry),
      callbackButton('新会话', RUN_FOLLOW_UP_ACTIONS.reset),
    ])];
  }
  if (state.stopState !== 'running') {
    return [{
      tag: 'markdown',
      content: `操作: ${stopButtonText(state)}`,
    }];
  }

  const buttons: Array<Record<string, unknown>> = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: stopButtonText(state) },
      type: 'primary_filled',
      behaviors: [{ type: 'callback', value: { action: 'stop' } }],
    },
  ];

  if (state.adminCancelEnabled && state.sessionShortId) {
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '叫停' },
      type: 'default',
      behaviors: [{ type: 'callback', value: { action: 'admin_cancel', shortId: state.sessionShortId } }],
    });
  }

  return [buttonRow(buttons)];
}

function collapsiblePanel(title: string, content: string, border: 'grey' | 'red' = 'grey'): Record<string, unknown> {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: title },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content, text_size: 'notation' }],
  };
}

/** 会话列表 / 通知里的预览文字. */
function summaryText(state: StreamState): string {
  if (isLiveState(state)) return `${state.agentDisplayName} 处理中…`;
  if (state.stopState === 'stopping') return '停止中…';
  if (state.stopState === 'stopped') return '已停止';
  if (state.terminalState === 'error') return `出错: ${(state.errorMessage ?? '').slice(0, 50)}`;
  const firstLine = state.text.split('\n').find((line) => line.trim()) ?? '';
  return firstLine.replace(/[#*`>|]/g, '').trim().slice(0, 60) || '已完成';
}

function renderLiveCard(state: StreamState): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      streaming_mode: true,
      streaming_config: STREAMING_CONFIG,
      summary: { content: summaryText(state) },
    },
    header: { title: { tag: 'plain_text', content: buildHeader(state, false) } },
    body: {
      elements: [
        { tag: 'markdown', element_id: CARD_ELEMENT_IDS.process, content: liveProcessText(state), text_size: 'notation' },
        { tag: 'markdown', element_id: CARD_ELEMENT_IDS.main, content: toFeishuMarkdown(truncate(state.text.trim(), MAIN_TEXT_MAX)) },
        { tag: 'markdown', element_id: CARD_ELEMENT_IDS.status, content: liveStatusText(state), text_size: 'notation' },
        ...buildActionElements(state),
      ],
    },
  };
}

function toolsPanel(state: StreamState): Record<string, unknown> {
  const finished = state.terminalState !== 'running' || state.stopState !== 'running';
  const failed = state.tools.filter((tool) => tool.isError).length;
  const title = `🧰 **${state.tools.length} 个工具调用**${failed > 0 ? ` · ${failed} 个失败` : ''}`;
  const body = state.tools.map((tool) => {
    const line = `- ${toolLine(tool, finished)}`;
    return tool.isError && tool.output ? `${line}\n  ${truncate(tool.output.replace(/\s*\n+\s*/g, ' '), 200)}` : line;
  }).join('\n');
  return collapsiblePanel(title, body, failed > 0 ? 'red' : 'grey');
}

function renderStaticCard(state: StreamState): Record<string, unknown> {
  const sections: Array<Record<string, unknown>> = [];
  const text = state.text.trim();
  const isAgentCard = state.agentId !== 'system';
  const notices = noticeLines(state);
  if (notices.length > 0) sections.push({ tag: 'markdown', content: notices.join('\n'), text_size: 'notation' });
  const thinking = state.thinking.trim();
  if (isAgentCard && thinking && showThinking()) {
    sections.push(collapsiblePanel('🧠 **思考过程**', truncate(thinking, THINKING_FINAL_MAX)));
  }
  // 被停止的 run 工具记录没有参考价值, 只留结论.
  if (isAgentCard && state.tools.length > 0 && state.stopState === 'running') sections.push(toolsPanel(state));
  const chunks = answerChunks(state);
  if (chunks.length > 0) sections.push({ tag: 'markdown', content: truncate(chunks[0]!, MAIN_TEXT_MAX) });
  if (chunks.length > 1) sections.push({ tag: 'markdown', content: `📄 输出较长, 共 ${chunks.length} 张卡, 后续见下方「续」卡`, text_size: 'notation' });
  // claude 遇到 API 错误时会把同一句错误也作为正文输出, 正文已经以它结尾就不再重复一遍.
  const errorMessage = state.errorMessage?.trim();
  if (errorMessage && !text.endsWith(errorMessage)) sections.push({ tag: 'markdown', content: `**Error**\n${truncate(errorMessage, 2000)}` });
  if (state.includeMeta) {
    const meta = [
      `agent: ${state.agentId}`,
      `cwd: ${state.cwd ?? '-'}`,
      `context: ${state.hasContext ? '有' : '无'}`,
      `model: ${state.model ?? '-'}`,
    ];
    const usage = usageText(state);
    if (usage) meta.push(`usage: ${usage}`);
    sections.push({ tag: 'markdown', content: meta.join('\n'), text_size: 'notation' });
  }
  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true, summary: { content: summaryText(state) } },
    header: { title: { tag: 'plain_text', content: buildHeader(state, true) } },
    body: {
      elements: [...sections, ...artifactElements(state), ...buildActionElements(state)],
    },
  } satisfies Record<string, unknown>;
  if (JSON.stringify(card).length <= CARD_SIZE_LIMIT) return card;
  return {
    ...card,
    body: {
      elements: [
        { tag: 'markdown', content: toFeishuMarkdown(truncate(text || state.errorMessage || '结果过长，已降级显示。', 6000)) },
        { tag: 'markdown', content: '完整结果过长，当前卡片已降级显示。' },
        ...buildActionElements(state),
      ],
    },
  };
}

/** 走 im.message 接口 (非 CardKit 实体) 时去掉流式配置; 消息卡片不认 streaming_mode. */
export function withoutStreaming(card: Record<string, unknown>): Record<string, unknown> {
  const config = card['config'];
  if (!config || typeof config !== 'object' || !('streaming_mode' in config)) return card;
  const { streaming_mode: _mode, streaming_config: _config, ...rest } = config as Record<string, unknown>;
  return { ...card, config: rest };
}

export function renderCard(state: StreamState): Record<string, unknown> {
  return isLiveState(state) ? renderLiveCard(state) : renderStaticCard(state);
}
