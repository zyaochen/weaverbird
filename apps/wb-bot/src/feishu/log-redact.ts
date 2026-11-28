/**
 * pino 的 err / error 序列化: SDK 抛出的 AxiosError 自带 config.headers.Authorization (tenant token),
 * 原样打进日志就泄露了 token. 只保留排障需要的字段.
 */
export function serializeError(value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  const record = value as Error & {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown; data?: unknown };
    config?: { url?: unknown; method?: unknown };
  };
  return {
    type: record.name,
    message: record.message,
    code: record.code,
    status: record.response?.status ?? record.status,
    data: record.response?.data,
    url: record.config?.url,
    method: record.config?.method,
    stack: record.stack,
  };
}

export const errorSerializers = { err: serializeError, error: serializeError };
