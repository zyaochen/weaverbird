const BOT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function validateBotId(input: unknown): { ok: boolean; reason?: string } {
  if (typeof input !== 'string') return { ok: false, reason: 'botId 必须是 string' };
  if (input.length === 0) return { ok: false, reason: 'botId 不能为空' };
  if (input.length > 32) return { ok: false, reason: `botId 长度超过 32 (got ${input.length})` };
  if (!BOT_ID_PATTERN.test(input)) return { ok: false, reason: 'botId 必须匹配 /^[a-z][a-z0-9_-]{0,31}$/ (lowercase, 字母开头, 含字母数字 _ -)' };
  return { ok: true };
}

export function assertValidBotId(input: unknown, context: string): string {
  const result = validateBotId(input);
  if (!result.ok) throw new Error(`invalid botId at ${context}: ${result.reason}`);
  return input as string;
}
