export const ERROR_CODES = {
  config: {
    E_CONFIG_MISSING: 'config.missing',
    E_CONFIG_PARSE: 'config.parse_error',
  },
  captain: {
    E_CAPTAIN_QUEUE_PARSE: 'captain.queue_parse_error',
    E_TOML_MISSING: 'captain.toml.missing',
    E_TOML_INVALID: 'captain.toml.invalid',
    E_INFERENCE_MISS: 'captain.cwd.inference_miss',
    E_SESSION_NOT_FOUND: 'captain.session.not_found',
    E_STORE_WRITE: 'captain.store.write_failed',
    E_STORE_RETRY_EXHAUSTED: 'captain.store.retry_exhausted',
    E_CATALOG_INCOMPLETE: 'captain.catalog.incomplete',
    E_CONFIG_MISSING: 'captain.config.missing',
    E_CONFIG_INCOMPLETE: 'captain.config.incomplete',
  },
  'run-observability': {
    E_STORE_WRITE: 'run-observability.store.write_failed',
    E_STORE_TRUNCATED: 'run-observability.store.truncated',
    E_IM_SEND_FAILED: 'run-observability.im.send_failed',
    E_IM_PATCH_FAILED: 'run-observability.im.patch_failed',
    E_RUN_STALE_NOOP: 'run-observability.alert.stale_noop',
    E_NO_ACTIVE_SESSION: 'run-observability.session.not_found',
  },
  'run-registry': {
    E_CFG_MISSING: 'registry.config.missing',
    E_CFG_INVALID: 'registry.config.invalid',
    E_SCHEMA_MISMATCH: 'registry.schema.mismatch',
    E_BITABLE_WRITE: 'registry.bitable.write_failed',
    E_BITABLE_RETRY_EXHAUSTED: 'registry.bitable.retry_exhausted',
    E_WAL_WRITE: 'registry.wal.write_failed',
    E_TAILER_READ: 'registry.tailer.read_error',
    E_INHERIT_NOT_FOUND: 'registry.inherit.run_not_found',
    E_QUERY_TIMEOUT: 'registry.query.timeout',
    E_DOC_SINK_WRITE: 'registry.doc_sink.write_failed',
  },
  audit: {
    E_CFG_MISSING_FILE: 'audit.config.missing_file',
    E_CFG_INVALID_JSON: 'audit.config.invalid_json',
    E_CFG_MISSING_ENV: 'audit.config.missing_env',
    E_CFG_PLACEHOLDER: 'audit.config.placeholder',
    E_CFG_BAD_SOURCE_TYPE: 'audit.config.bad_source_type',
    E_CFG_PERM_TOO_OPEN: 'audit.config.perm_too_open',
    E_PARSE_BAD_LINE: 'audit.parse.bad_line',
    E_NORM_MISSING_SPEC: 'audit.normalizer.missing_spec',
    E_NORM_INVALID_ENTRY_FORM: 'audit.normalizer.invalid_entry_form',
    E_MIRROR_WRITE_FATAL: 'audit.mirror.write_fatal',
    E_WAL_WRITE: 'audit.wal.write',
    E_BITABLE_HTTP_4XX: 'audit.bitable.http_4xx',
    E_BITABLE_HTTP_5XX: 'audit.bitable.http_5xx',
    E_BITABLE_LARK_CODE: 'audit.bitable.lark_code_nonzero',
    E_BITABLE_RETRY_EXHAUSTED: 'audit.bitable.retry_exhausted',
  },
  reverse: {
    E_ATTACH_TIMEOUT: 'reverse.attach.timeout',
    E_ATTACH_NOT_FOUND: 'reverse.attach.not_found',
    E_ATTACH_MUTEX: 'reverse.attach.mutex_conflict',
    E_ATTACH_FLUSH_FAILED: 'reverse.attach.flush_failed',
    E_IPC_CONNECT_FAILED: 'reverse.ipc.connect_failed',
    E_IPC_SEND_TIMEOUT: 'reverse.ipc.send_timeout',
    E_IPC_PARSE: 'reverse.ipc.parse_error',
    E_ECHO_SEND_FAILED: 'reverse.echo.send_failed',
    E_REVERSE_AT_PARSE: 'reverse.at.parse_error',
    E_REVERSE_AT_RUN_GONE: 'reverse.at.run_not_found',
    E_SIGNAL_FAILED: 'reverse.signal.send_failed',
    E_CAPTAIN_HANDED_OVER: 'reverse.attach.handed_over',
  },
} as const;

export type ErrorCodeRegistryKey = keyof typeof ERROR_CODES;
export type ErrorCodeGroup = typeof ERROR_CODES[ErrorCodeRegistryKey];
export type ErrorCodeEntry = {
  registryKey: ErrorCodeRegistryKey;
  symbol: string;
  value: string;
};

export const ERROR_CODE_ALLOWED_DOMAINS = {
  config: ['config'],
  captain: ['captain'],
  'run-observability': ['run-observability'],
  'run-registry': ['registry'],
  audit: ['audit'],
  reverse: ['reverse'],
} as const satisfies Record<ErrorCodeRegistryKey, readonly string[]>;

export function flattenErrorCodes(): string[] {
  return Object.values(ERROR_CODES).flatMap((group) => Object.values(group));
}

export function getErrorCodeEntries(): ErrorCodeEntry[] {
  return Object.entries(ERROR_CODES).flatMap(([registryKey, group]) =>
    Object.entries(group).map(([symbol, value]) => ({
      registryKey: registryKey as ErrorCodeRegistryKey,
      symbol,
      value,
    })),
  );
}

export function extractErrorCodeDomain(code: string): string {
  const [domain = ''] = code.split('.');
  return domain;
}

export function matchesAllowedErrorCodeDomain(registryKey: ErrorCodeRegistryKey, code: string): boolean {
  const allowedDomains = ERROR_CODE_ALLOWED_DOMAINS[registryKey] as readonly string[];
  return allowedDomains.includes(extractErrorCodeDomain(code));
}

export const ERROR_CODE_VALUES = flattenErrorCodes();
export const ERROR_CODE_ENTRIES = getErrorCodeEntries();
export const ERROR_CODE_INDEX = Object.fromEntries(
  ERROR_CODE_ENTRIES.map((entry) => [entry.value, entry]),
) as Record<string, ErrorCodeEntry>;
