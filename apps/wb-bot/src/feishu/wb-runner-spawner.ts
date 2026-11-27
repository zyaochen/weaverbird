import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDir as resolveRunDir, runSpecPath } from '../../../../packages/core/src/paths.js';
import { buildFilteredEnv, type FilteredEnv } from '../security/env-whitelist.js';
import type { RunSpec } from '../../../../packages/core/src/runner/wb-runner.js';

/**
 * 决定如何 spawn wb-runner subprocess.
 *
 * - `.js` (dist build output): 直接 `node <path>` (production / npm run build 后跑)
 * - `.ts` (src source): 用 tsx loader `node --import tsx <path>` (dev mode, 无需 build)
 *
 * 背景: child 是 fresh Node 进程, 不继承父进程 tsx loader hook. 直接 `node foo.ts`
 * 会 ERR_MODULE_NOT_FOUND (.ts source 用 `.js` import suffix 给 TS 的 bundle target).
 * 必须 (a) 跑 build 后的 .js, 或 (b) 显式加 tsx loader.
 *
 * tsx 的 loader 模块: `node_modules/tsx/dist/esm/index.mjs`. 用 `--import` flag (Node 20+)
 * 把 loader 在 user code 跑前 register.
 */
export function buildRunnerSpawnArgs(wbRunnerMainPath: string, specJsonPath: string): { cmd: string; args: string[] } {
  const absRunnerPath = resolve(wbRunnerMainPath);
  if (absRunnerPath.endsWith('.js')) {
    return { cmd: process.execPath, args: [absRunnerPath, specJsonPath] };
  }
  // .ts source mode: locate tsx ESM loader (walk up from runner path 找 node_modules/tsx)
  let dir = dirname(absRunnerPath);
  let tsxLoader: string | undefined;
  while (true) {
    const candidate = join(dir, 'node_modules/tsx/dist/esm/index.mjs');
    if (existsSync(candidate)) {
      tsxLoader = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!tsxLoader) {
    // 兜底: 依赖 child 进程能从 cwd resolve tsx (大多 dev 路径 OK)
    return { cmd: process.execPath, args: ['--import', 'tsx', absRunnerPath, specJsonPath] };
  }
  return { cmd: process.execPath, args: ['--import', tsxLoader, absRunnerPath, specJsonPath] };
}

export type SpawnResult = {
  runId: string;
  runDir: string;
  specJsonPath: string;
  child: ChildProcess;
};

export function generateRunId(): string {
  return randomUUID();
}

export function buildRunSpec(opts: {
  runId: string;
  botId: string;
  agentId: string;
  agentCommand: string;
  agentArgs: string[];
  cwd: string;
  env: FilteredEnv<'agent-cli'>;
  userOpenId: string;
  threadId: string;
  sourceMessageId: string;
  replyMessageId: string;
  continuationToken?: string;
  consentLevel?: string;
  model?: string;
  stdinInput?: string;
}): RunSpec {
  return {
    runId: opts.runId,
    botId: opts.botId,
    agentId: opts.agentId,
    agentCommand: opts.agentCommand,
    agentArgs: opts.agentArgs,
    cwd: opts.cwd,
    env: opts.env,
    userOpenId: opts.userOpenId,
    threadId: opts.threadId,
    sourceMessageId: opts.sourceMessageId,
    replyMessageId: opts.replyMessageId,
    continuationToken: opts.continuationToken,
    consentLevel: opts.consentLevel,
    model: opts.model,
    ...(opts.stdinInput !== undefined ? { stdinInput: opts.stdinInput } : {}),
  };
}

export function spawnWbRunner(opts: {
  dataDir: string;
  spec: RunSpec;
  wbRunnerMainPath: string;
}): SpawnResult {
  const { dataDir, spec, wbRunnerMainPath } = opts;
  const runDir = resolveRunDir(dataDir, spec.runId, spec.botId);
  mkdirSync(runDir, { recursive: true });

  const specJsonPath = runSpecPath(dataDir, spec.runId, spec.botId);
  writeFileSync(specJsonPath, JSON.stringify(spec, null, 2));

  const outputFd = openSync(join(runDir, 'wb-runner.stdout'), 'a');
  const errFd = openSync(join(runDir, 'wb-runner.stderr'), 'a');

  const wbRunnerEnv = buildFilteredEnv('wb-runner', process.env);

  const { cmd, args } = buildRunnerSpawnArgs(wbRunnerMainPath, specJsonPath);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', outputFd, errFd],
    env: wbRunnerEnv,
  });
  child.unref();

  return { runId: spec.runId, runDir, specJsonPath, child };
}
