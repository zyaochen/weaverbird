import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '../audit-pipe/contracts.js';
import { createMirrorSink } from '../audit-pipe/mirror-sink.js';
import { FINALIZE_HEAD_LINES, FINALIZE_OUTPUT_MAX_BYTES, FINALIZE_TAIL_LINES, type ObservabilityStoreEntry } from './contracts.js';
import { ensureRunDoc } from '../run-registry/doc-sink.js';
import { loadRunRegistryConfig } from '../run-registry/config.js';

export type FinalizerClient = {
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  replyCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  sendCard(chatId: string, card: Record<string, unknown>): Promise<void>;
};

function truncateLines(lines: string[]): { lines: string[]; outputTruncated: boolean } {
  const raw = lines.join('\n');
  if (Buffer.byteLength(raw, 'utf8') <= FINALIZE_OUTPUT_MAX_BYTES) {
    return { lines, outputTruncated: false };
  }
  const prefix = '...（已截断）';
  let working = [...lines];
  while (working.length > 1 && Buffer.byteLength([prefix, ...working].join('\n'), 'utf8') > FINALIZE_OUTPUT_MAX_BYTES) {
    working.pop();
  }
  return { lines: [prefix, ...working], outputTruncated: true };
}

function summarizeOutput(lines: string[]): { headLines: string[]; tailLines: string[]; outputTruncated: boolean } {
  if (lines.length === 0) return { headLines: ['(no output)'], tailLines: [], outputTruncated: false };
  const headLines = lines.slice(0, FINALIZE_HEAD_LINES);
  const tailLines = lines.slice(-FINALIZE_TAIL_LINES);
  const deduped = [...headLines, ...tailLines.slice(Math.max(0, headLines.length + tailLines.length - lines.length))];
  const truncated = truncateLines(deduped);
  return {
    headLines: truncated.lines.slice(0, Math.min(headLines.length, truncated.lines.length)),
    tailLines: truncated.lines.slice(Math.min(headLines.length, truncated.lines.length)),
    outputTruncated: truncated.outputTruncated,
  };
}

function renderFinalizeCard(entry: ObservabilityStoreEntry, lines: string[], nowIso: string): Record<string, unknown> {
  const summary = summarizeOutput(lines);
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `✅ Run Finalized · ${entry.run_id}` } },
    body: {
      elements: [
        { tag: 'markdown', content: `status: ${entry.status}` },
        { tag: 'markdown', content: `elapsed_at: ${nowIso}` },
        { tag: 'markdown', content: summary.headLines.join('\n') },
        { tag: 'markdown', content: summary.tailLines.join('\n') },
      ],
    },
  };
}

export async function finalizeRun(
  entry: ObservabilityStoreEntry,
  lines: string[],
  options: {
    client: FinalizerClient;
    dataDir: string;
    nowIso?: string;
    onFinalized?: () => void;
    botId?: string;
    larkEnv?: NodeJS.ProcessEnv;
    /** Disable the auto doc-sink call (tests / hot-path short-circuit). */
    skipDocSink?: boolean;
  },
): Promise<boolean> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const finalCard = renderFinalizeCard(entry, lines, nowIso);

  if (entry.card_message_id) {
    try {
      await options.client.updateCard(entry.card_message_id, finalCard);
    } catch {
      return false;
    }
  }

  if (entry.origin_message_id) {
    await options.client.replyCard(entry.origin_message_id, finalCard);
  } else if (entry.home_group_id) {
    await options.client.sendCard(entry.home_group_id, finalCard);
  }

  options.onFinalized?.();

  // C1 (2026-08-04 owner-authorized): finalize 完成后触发 auto doc-sink (prereq: status terminal)
  // reason 'not_terminal' 直接 passthrough, 不打扰已 finalized 的卡; succeeded/created 写入
  // produced_doc_urls 并回写 store (caller 已持久化 entry, via onFinalized).
  if (!options.skipDocSink) {
    try {
      const config = loadRunRegistryConfig({ env: options.larkEnv });
      const sinkStatus = entry.status as 'succeeded' | 'failed' | 'cancelled';
      const result = await ensureRunDoc({
        dataDir: options.dataDir,
        runId: entry.run_id,
        botId: options.botId ?? 'default',
        status: sinkStatus,
        existingDocUrls: entry.produced_doc_urls ?? [],
        config,
        env: options.larkEnv,
      });
      entry.produced_doc_urls = result.produced_doc_urls;
      entry.doc_sink_attempted_at = nowIso;
      entry.doc_sink_last_reason = result.reason;
    } catch (error) {
      // doc-sink 失败不阻塞 finalize 主路径, 但记录上次原因便于排障.
      entry.doc_sink_attempted_at = nowIso;
      entry.doc_sink_last_reason = `error:${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const sink = createMirrorSink({ dataDir: options.dataDir });
  const record: AuditRecord = {
    audit_record_id: randomUUID(),
    session_id: entry.session_id,
    run_id: entry.run_id,
    revision: 0,
    actor: entry.session_id,
    action: 'network_call',
    resource: `run-observability:finalize:${entry.run_id}`,
    ts: nowIso,
      entry_form: 'im',
      entry_detail: {
        source_message_id: entry.origin_message_id ?? entry.run_id,
        user_open_id: entry.session_id,
        thread_id: entry.home_group_id ?? entry.card_message_id ?? '',
      },
    agent_id: 'claude-code',
    raw_tool_use_id: `${entry.run_id}:finalize`,
    raw_tool_name: 'finalizer',
  };
  sink.write(record);
  return true;
}
