export const CODES = {
  E_CONFIG_MISSING: 'config.missing',
  E_CONFIG_PARSE: 'config.parse_error',
  E_CAPTAIN_QUEUE_PARSE: 'captain.queue_parse_error',
} as const;

export type ConfigErrorCode = typeof CODES[keyof typeof CODES];

export class ConfigError extends Error {
  constructor(
    public readonly code: ConfigErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ConfigError';
  }
}
