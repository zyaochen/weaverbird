import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { errorSerializers, serializeError } from '../../apps/wb-bot/src/feishu/log-redact.js';

function axiosLikeError(): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    name: 'AxiosError',
    config: { url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply', method: 'post', headers: { Authorization: 'Bearer t-secret-token' } },
    response: { status: 400, data: { code: 230011, msg: 'The message was withdrawn.' } },
  });
}

describe('log-redact', () => {
  it('keeps the fields needed for triage and drops request headers', () => {
    const serialized = serializeError(axiosLikeError()) as Record<string, unknown>;
    expect(serialized).toMatchObject({ type: 'AxiosError', status: 400, data: { code: 230011 }, method: 'post' });
    expect(JSON.stringify(serialized)).not.toContain('t-secret-token');
  });

  it('applies to both err and error keys of a pino logger', () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const logger = pino({ serializers: errorSerializers }, sink);
    logger.error({ error: axiosLikeError() }, 'a');
    logger.error({ err: axiosLikeError() }, 'b');
    expect(lines).toHaveLength(2);
    expect(lines.join('')).not.toContain('t-secret-token');
    expect(lines.join('')).toContain('230011');
  });

  it('passes non-error values through', () => {
    expect(serializeError('plain')).toBe('plain');
  });
});
