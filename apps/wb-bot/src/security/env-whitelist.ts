import type { RunRequest } from '../../../../packages/core/src/index.js';

export type FilteredEnv<Target extends 'wb-runner' | 'agent-cli'> = NodeJS.ProcessEnv & { __wbFiltered: Target };

const SECRET_PATTERNS = [
  /_TOKEN$/,
  /_SECRET$/,
  /_KEY$/,
  /_PASSWORD$/,
  /^LARK_/,
  /^FEISHU_/,
  /^AWS_/,
  /^GITHUB_TOKEN$/,
  /^SSH_/,
  /^GPG_/,
  /^GCP_/,
  /^WB_/,
  /^BOT_ID$/,
];

const DEFAULT_BASE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'NO_COLOR',
  'FORCE_COLOR',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
] as const;

const WB_RUNNER_ALLOW = [
  'WB_DATA_DIR',
  'WB_HEARTBEAT_STALE_MS',
  'WB_PUSH_THRESHOLD_MS',
  'WB_TOOL_PROGRESS_INTERVAL_MS',
] as const;

export function filterBaseEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(key))) continue;
    if (DEFAULT_BASE_ENV.includes(key as (typeof DEFAULT_BASE_ENV)[number]) || key.startsWith('LC_')) {
      output[key] = value;
    }
  }
  return output;
}

export function buildFilteredEnv<T extends 'wb-runner' | 'agent-cli'>(
  target: T,
  input: NodeJS.ProcessEnv,
  passthrough?: readonly string[],
): FilteredEnv<T> {
  const env = filterBaseEnv(input);
  if (target === 'wb-runner') {
    for (const key of WB_RUNNER_ALLOW) {
      const value = input[key];
      if (value !== undefined) env[key] = value;
    }
  }
  if (passthrough) {
    for (const key of passthrough) {
      const value = input[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env as FilteredEnv<T>;
}

export function buildAgentEnv(input: NodeJS.ProcessEnv, passthrough: readonly string[]): FilteredEnv<'agent-cli'> {
  const env = filterBaseEnv(input);
  for (const key of passthrough) {
    const value = input[key];
    if (value !== undefined) env[key] = value;
  }
  return env as FilteredEnv<'agent-cli'>;
}

type ClaudeAuthStatus = {
  loggedIn?: boolean;
  authMethod?: string;
};

const CLAUDE_OAUTH_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] as const;
const CLAUDE_MODEL_KEYS = ['ANTHROPIC_MODEL'] as const;

export function shouldPreferClaudeOAuth(status: ClaudeAuthStatus | null): boolean {
  return status?.loggedIn === true && status.authMethod === 'oauth_token';
}

export function buildClaudeAgentEnv(input: NodeJS.ProcessEnv, preferOAuth: boolean): FilteredEnv<'agent-cli'> {
  const passthrough = preferOAuth ? CLAUDE_MODEL_KEYS : [...CLAUDE_OAUTH_KEYS, ...CLAUDE_MODEL_KEYS];
  return buildAgentEnv(input, passthrough);
}

export function attachEnvFilter<T extends { envFilter?: (env: NodeJS.ProcessEnv, req: RunRequest) => NodeJS.ProcessEnv }>(
  agent: T,
  passthrough: readonly string[],
): T {
  agent.envFilter = (env) => buildAgentEnv(env, passthrough);
  return agent;
}
