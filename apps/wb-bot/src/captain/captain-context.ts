import { resolveConfigDir } from '../config/config-paths.js';
import { resolveDataDir } from '../../../../packages/core/src/paths.js';
import { isCaptainEnabled } from './captain-gate.js';
import { discoverBotsWithStatus, type BotStatus } from './bot-discovery.js';

export interface CaptainContextInput {
  botId: string;
}

export type CaptainContext =
  | { enabled: false }
  | { enabled: true; configDir: string; dataDir: string; bots: BotStatus[] };

/**
 * 统一 Captain 上下文解析: 把 router.ts 里 4+ 处重复展开 (gate +
 * resolveConfigDir + dataDir + discoverBotsWithStatus) 合到一处.
 * 副作用: 仅 file IO (bot discovery), 不写状态, 不持久化.
 * 不变量: enabled=false 时不会调 discover (省 file IO).
 *
 * Pure refactor (W2.5-Hotfix-batch-C P1-6): 不改变 Captain 启用判定 / discovery
 * 行为, 只把 4 个 router.ts 命令分支的重复逻辑提到一处.
 */
export function resolveCaptainContext(input: CaptainContextInput): CaptainContext {
  const enabled = isCaptainEnabled({
    mode: process.env['WB_MODE'] === 'multi-bot' ? 'multi-bot' : 'single',
    botId: input.botId,
    disableCaptainEnv: process.env['WB_DISABLE_CAPTAIN'],
  });
  if (!enabled) return { enabled: false };
  const configDir = resolveConfigDir();
  const dataDir = resolveDataDir();
  const { bots } = discoverBotsWithStatus({ configDir, dataDir });
  return { enabled: true, configDir, dataDir, bots };
}
