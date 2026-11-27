import type { AlertPayload } from './contracts.js';

export function renderAtUser(openId: string): string {
  if (!openId.startsWith('ou_')) return openId;
  return `<at id="${openId}"></at>`;
}

export function renderAlertCard(payload: AlertPayload, operatorOpenId: string): Record<string, unknown> {
  const mention = renderAtUser(operatorOpenId);
  const lines = [
    `${mention} run ${payload.run_id} alert`,
    `reason: ${payload.reason}`,
    `elapsed_s: ${payload.elapsed_s}`,
    payload.exit_code !== null ? `exit_code: ${payload.exit_code}` : null,
    payload.signal !== null ? `signal: ${payload.signal}` : null,
    'suggest: cancel / check logs',
  ].filter(Boolean);
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `⚠️ Run Alert · ${payload.run_id}` } },
    body: {
      elements: lines.map((line) => ({ tag: 'markdown', content: String(line) })),
    },
  };
}
