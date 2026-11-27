import { existsSync } from 'node:fs';
import pino from 'pino';
import { adminAlertsPath } from '../../../../packages/core/src/paths.js';
import { appendNdjsonLine, listNdjsonSegments, readNdjsonSegments } from '../../../../packages/core/src/util/ndjson-rotation.js';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

export type AlertSeverity = 'warn' | 'error' | 'fatal';

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  warn: '⚠️',
  error: '⛔',
  fatal: '🔥',
};

export interface AlertSink {
  sendText(chatId: string, text: string): Promise<void>;
  sendCard?(chatId: string, card: Record<string, unknown>): Promise<void>;
  sendDm?(openId: string, text: string): Promise<void>;
}
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;
// Lark chat_id 形态: oc_ + 数字小写字母加下划线 / 中划线 (例 oc_a1b2c3_xxx).
// 旧的 /^oc_[a-zA-Z0-9]+$/ 不含 "_" 把"oc_cluster_1" 这类合法 id 判否, M13-C 修掉.
const CHAT_ID_PATTERN = /^oc_[a-zA-Z0-9_-]+$/;

/**
 * M13-C (2026-08-04 owner-authorized): owner DM 兜底通道。
 * 优先用 `WB_OWNER_OPEN_ID` (ou_*) DM 到 owner,失败 → 原 `WB_ADMIN_THREAD_ID`
 * 群回退,仍失败 → 落 admin-alerts.ndjson。失败不抛 — 告警通道不能反过来砸主流程。
 */
export async function sendAdminAlert(
  sink: AlertSink | null,
  dataDir: string,
  message: string,
  severity: AlertSeverity = 'error',
): Promise<void> {
  const ownerOpenId = (process.env['WB_OWNER_OPEN_ID'] ?? '').trim();
  const threadId = (process.env['WB_ADMIN_THREAD_ID'] ?? '').trim();
  const emoji = SEVERITY_EMOJI[severity];
  const fullMessage = `${emoji} [wb-bot] ${message}`;

  if (sink?.sendDm && ownerOpenId && OPEN_ID_PATTERN.test(ownerOpenId)) {
    try {
      await sink.sendDm(ownerOpenId, fullMessage);
      return;
    } catch (err) {
      logger.warn({ err, ownerOpenId, message }, 'admin alert DM to owner failed, falling back to cluster channel');
    }
  }

  if (sink && threadId && CHAT_ID_PATTERN.test(threadId)) {
    try {
      await sink.sendText(threadId, fullMessage);
      return;
    } catch (textErr) {
      // M13-H A3: sendText 失败时改走 sendCard 同 chatId (rich card 也能在 group 里
      // 呈现,不会因为 text pipe 坏掉就完全静默).
      if (sink.sendCard) {
        try {
          await sink.sendCard(threadId, {
            schema: '2.0',
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: emoji + ' Admin alert' } },
            body: { elements: [{ tag: 'markdown', content: fullMessage }] },
          });
          return;
        } catch (cardErr) {
          logger.error({ textErr, cardErr, threadId, message }, 'admin alert cluster channel failed both text and card');
        }
      } else {
        logger.error({ err: textErr, threadId, message }, 'admin alert feishu send failed, falling back to file');
      }
    }
  }

  appendAlertToFile(dataDir, fullMessage, severity);
}

function emitLastResortAlert(message: string, severity: AlertSeverity, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  const line = `[wb-bot][admin-alert][last-resort][${severity}] ${message} :: ${detail}\n`;
  try {
    process.stderr.write(line);
  } catch {
    // stderr itself may be unavailable; keep fail-open
  }
}

function appendAlertToFile(dataDir: string, message: string, severity: AlertSeverity): void {
  try {
    const alertFile = adminAlertsPath(dataDir);
    const entry = JSON.stringify({ ts: new Date().toISOString(), severity, message });
    appendNdjsonLine(alertFile, entry);
  } catch (err) {
    logger.error({ err, message }, 'admin alert file write failed');
    emitLastResortAlert(message, severity, err);
  }
}

export function getPendingAlertCount(dataDir: string): number {
  try {
    const alertFile = adminAlertsPath(dataDir);
    if (!existsSync(alertFile) && listNdjsonSegments(alertFile).length === 0) return 0;
    return readNdjsonSegments(alertFile).length;
  } catch {
    return 0;
  }
}
