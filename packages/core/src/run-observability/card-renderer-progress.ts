import { CARD_LINE_MAX_CHARS, type ObservabilityStoreEntry } from './contracts.js';

function truncateLine(text: string, maxChars = CARD_LINE_MAX_CHARS): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function formatElapsed(createdAt: string, nowIso: string): string {
  const elapsedMs = Math.max(0, Date.parse(nowIso) - Date.parse(createdAt));
  const seconds = Math.floor(elapsedMs / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function renderProgressCard(entry: ObservabilityStoreEntry, latestLine: string | null, nowIso = new Date().toISOString()): Record<string, unknown> {
  const text = latestLine ? truncateLine(latestLine) : '(no output yet)';
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `📡 Run Progress · ${entry.run_id}`,
      },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `status: ${entry.status}` },
        { tag: 'markdown', content: `step_index: ${entry.step_index}` },
        { tag: 'markdown', content: `token_usage: ${entry.token_usage}` },
        { tag: 'markdown', content: `elapsed: ${formatElapsed(entry.created_at, nowIso)}` },
        { tag: 'markdown', content: text },
      ],
    },
  };
}
