#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDefaultAgentRegistry, type AgentEvent, type ConsentLevel } from '../../../packages/core/src/index.js';
import { logsCommand } from './commands/logs.js';
import { runsCommand } from './commands/runs.js';
import { debugCommand } from './commands/debug.js';
import { historyCommand } from './commands/history.js';
import { statusCommand } from './commands/status.js';
import { captainCommand } from './commands/captain.js';
import { attachCommand } from './commands/attach.js';
import { resumeInheritCommand } from './commands/resume.js';
import { listCommand } from './commands/list.js';
import { auditCommand } from './commands/audit.js';
import { approvalCommand } from './commands/approval.js';
import { watchCommand } from './commands/watch.js';
import { COMMAND_CATALOG, type CommandCatalogEntry } from '../../../packages/core/src/captain/index.js';

// M12-B (2026-08-04 owner-authorized): wb-cli 的命令面应该来自 COMMAND_CATALOG
// 单源 (bot/cli/both 三态)。resolveCommand 当 catalog 条目可见时直接通道;
// run / debug / list-agents 是 non-catalog 特例 (不属于 catalog 维度) 走原路径。
const CLI_CATALOG_KEYS = Object.keys(COMMAND_CATALOG).filter((name) => COMMAND_CATALOG[name]?.cli_visible);

type CatalogCommand = 'attach' | 'captain' | 'health' | 'help' | 'history' | 'list' | 'list-agents' | 'resume' | 'runs' | 'status' | 'use' | 'logs' | 'captain-use';
type NonCatalogCommand = 'run' | 'debug' | '--help' | '--version';
type Command = CatalogCommand | NonCatalogCommand;

function catalogLookup(command: string): CommandCatalogEntry | null {
  if (CLI_CATALOG_KEYS.includes(command)) return COMMAND_CATALOG[command] ?? null;
  for (const [name, entry] of Object.entries(COMMAND_CATALOG)) {
    if (name === 'resume-im' || name === 'pause-im' || name === 'cancel-im') continue;
    if (entry.cli_visible && entry.aliases.some((alias) => alias === command || alias.startsWith(`${command} `))) {
      return entry;
    }
  }
  return null;
}

type RunOptions = {
  agent: string;
  consentLevel: ConsentLevel;
  resume?: string;
  cwd?: string;
  model?: string;
};

function printHelp(): void {
  const cliCommands = Object.entries(COMMAND_CATALOG)
    .filter(([, entry]) => entry.cli_visible)
    .map(([name, entry]) => `  ${name.padEnd(12)} ${entry.description}`)
    .join('\n');
  process.stdout.write(`Usage: wb-cli <command> [options]

Commands (catalog-driven):
${cliCommands}
  run          Run an agent with the given prompt
  resume       Resume from an inherited run: wb-cli resume --inherit <run_id>
  --help, -h   Show this help
  --version    Show CLI version

Options for 'run':
  --agent <id>          Agent id (default: claude-code)
  --consent-level <l>   Permission level (default: normal)
                        Values: plan-only, strict, normal, relaxed, auto
  --resume <token>      Resume previous session (token from prior [done] line)
  --cwd <path>          Working directory for agent (default: current dir)
  --model <id>          Model id (agent-specific, e.g. claude-sonnet-4-20250514)

Options for 'history':
  --all-captains       Aggregate view across captains
  --json                NDJSON per run
  --keyword / --agent / --status / --after / --before / --limit / --cursor

Examples:
  wb-cli run "explain this file"
  wb-cli run --consent-level plan-only "review code in src/"
  wb-cli resume --inherit run-abc123
  wb-cli list --all-captains
  wb-cli history --all-captains --limit 20
`);
}

function readVersion(): string {
  const pkgUrl = new URL('../../../package.json', import.meta.url);
  const raw = readFileSync(pkgUrl, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? '0.0.0';
}

export function resolveCommand(argv: string[]): Command {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return '--help';
  if (command === '--version') return '--version';
  if (command === 'run') return 'run';
  if (command === 'debug') return 'debug';
  // catalog-driven path: any cli_visible entry routes directly, no hard-coded switch.
  if (catalogLookup(command) !== null) return command as CatalogCommand;
  return 'run';
}

export function resolveRunArgv(argv: string[]): string[] {
  return argv[0] === 'run' ? argv.slice(1) : argv;
}

function parseConsentLevel(value: string | undefined): ConsentLevel {
  if (value === 'plan-only' || value === 'strict' || value === 'normal' || value === 'relaxed' || value === 'auto') {
    return value;
  }
  throw new Error(`invalid consent level: "${value ?? ''}"\nValid values: plan-only, strict, normal, relaxed, auto`);
}

function parseRunArgs(argv: string[]): { options: RunOptions; prompt: string } {
  const values = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string', default: 'claude-code' },
      'consent-level': { type: 'string', default: 'normal' },
      resume: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' },
    },
  });
  const prompt = values.positionals.join(' ').trim();
  if (!prompt) {
    throw new Error('prompt is required\nUsage: wb-cli run [options] <prompt>\nExample: wb-cli run "explain this file"');
  }
  return {
    prompt,
    options: {
      agent: values.values.agent,
      consentLevel: parseConsentLevel(values.values['consent-level']),
      resume: values.values.resume,
      cwd: values.values.cwd,
      model: values.values.model,
    },
  };
}

function formatToolResult(event: Extract<AgentEvent, { type: 'tool_result' }>): string {
  const prefix = event.isError ? 'ERROR ' : '';
  return `${prefix}${event.output.slice(0, 200)}`;
}

/**
 * Per-agent unavailable hint (W2.5-Hotfix-batch-C P1-8).
 *
 * R2 review M3: wb-cli 的 unavailable 分支不区分 agent, 统一提示
 * "Install claude CLI" — 用户跑 `--agent codex` 时这个提示是错误的, 影响工具可信度.
 *
 * 这里按 agent.id 给出对应的安装/验证指引. 新加 agent 时也需在此补一条.
 */
export function unavailableHint(agentId: string): string {
  if (agentId === 'claude-code') {
    return [
      'Install claude CLI: npm install -g @anthropic-ai/claude-code',
      'Then verify: claude --version',
    ].join('\n');
  }
  if (agentId === 'codex') {
    return [
      'Install codex CLI: see https://github.com/openai/codex',
      'Then verify: codex --version',
    ].join('\n');
  }
  return [
    `No install hint registered for agent: ${agentId}`,
    "Run 'wb-cli list-agents' to see registered agents and availability.",
  ].join('\n');
}

function writeMeta(event: Exclude<AgentEvent, { type: 'text' | 'thinking' }>): void {
  if (event.type === 'system') process.stderr.write(`[session] ${event.continuationToken ?? '-'}\n`);
  else if (event.type === 'tool_use') process.stderr.write(`[tool] ${event.name}\n`);
  else if (event.type === 'tool_result') process.stderr.write(`[tool result] ${formatToolResult(event)}\n`);
  else if (event.type === 'usage') process.stderr.write(`[usage] in=${event.inputTokens ?? '-'} out=${event.outputTokens ?? '-'} cost=$${event.costUsd ?? '-'}\n`);
  else if (event.type === 'done') process.stderr.write(`[done] ${event.continuationToken ?? '-'}\n`);
  else if (event.type === 'error') process.stderr.write(`[error] ${event.message}\n`);
}

async function runCommand(argv: string[]): Promise<number> {
  const { options, prompt } = parseRunArgs(argv);
  const registry = createDefaultAgentRegistry();
  const adapter = registry.lookup(options.agent);
  if (!adapter) {
    const registered = registry.list().map((a) => a.id).join(', ') || '(none)';
    process.stderr.write(`agent not registered: ${options.agent}\nRegistered agents: ${registered}\nRun 'wb-cli list-agents' to see availability.\n`);
    return 1;
  }
  const available = await registry.isAvailable(options.agent);
  if (!available) {
    process.stderr.write(`agent not available: ${options.agent}\n${unavailableHint(options.agent)}\n`);
    return 2;
  }
  const run = adapter.run({
    prompt,
    cwd: options.cwd ?? process.cwd(),
    consentLevel: options.consentLevel,
    continuationToken: options.resume,
    model: options.model,
  });
  let exitCode = 0;
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    void run.stop().then(() => run.waitForExit(2000)).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSigint);
  for await (const event of run.events) {
    if (event.type === 'text' || event.type === 'thinking') process.stdout.write(event.delta);
    else writeMeta(event);
    if (event.type === 'error') exitCode = 1;
    if (event.type === 'done' || event.type === 'error') break;
  }
  process.removeListener('SIGINT', onSigint);
  if (!interrupted) await run.waitForExit(2000);
  return exitCode;
}

async function listAgents(): Promise<number> {
  const registry = createDefaultAgentRegistry();
  for (const agent of registry.list()) {
    const available = await registry.isAvailable(agent.id);
    process.stdout.write(`${agent.id}\t${agent.displayName}\t${available ? 'available' : 'unavailable'}\n`);
  }
  return 0;
}

/**
 * M12-B (2026-08-04 owner-authorized): catalog-driven dispatch. `resolveCommand`
 * 命中一个 cli_visible 的 catalog 条目时由这张表执行;新增 catalog 条目不必改 main.ts,
 * 只需在这里登记一个 handler (或先用 default handler 报 "not yet implemented")。
 * 特例:`run` / `debug` / `--help` / `--version` 不是 catalog 条目,保留 hard-coded 分支。
 */
const CATALOG_HANDLERS: Record<string, (argv: string[]) => Promise<number> | number> = {
  history: historyCommand,
  status: () => statusCommand(),
  captain: (argv) => captainCommand(argv),
  attach: attachCommand,
  resume: resumeInheritCommand,
  list: listCommand,
  'list-agents': listAgents,
  help: () => { printHelp(); return 0; },
  use: () => 2,
  audit: auditCommand,
  approval: approvalCommand,
  watch: watchCommand,
  logs: () => 2,
  runs: () => runsCommand(),
  'captain-use': () => 2,
};

async function dispatchCatalogCommand(command: string, argv: string[]): Promise<number> {
  const handler = CATALOG_HANDLERS[command];
  if (!handler) {
    process.stderr.write(`wb-cli: catalog entry "${command}" not yet implemented (cli)\n`);
    return 2;
  }
  return await handler(argv);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = resolveCommand(argv);
  if (command === '--help') {
    printHelp();
    return;
  }
  if (command === '--version') {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (command === 'logs') {
    const logsArgv = argv.slice(1);
    const follow = logsArgv.includes('-f') || logsArgv.includes('--follow');
    let tail = 0;
    const tailIdx = logsArgv.indexOf('--tail');
    if (tailIdx >= 0 && logsArgv[tailIdx + 1]) tail = parseInt(logsArgv[tailIdx + 1]!, 10) || 0;
    let runId: string | undefined;
    const runIdIdx = logsArgv.indexOf('--run-id');
    if (runIdIdx >= 0 && logsArgv[runIdIdx + 1]) runId = logsArgv[runIdIdx + 1];
    const code = logsCommand({ follow, tail, runId });
    if (!follow) process.exit(code);
    return;
  }
  if (command === 'debug') {
    const parsed = debugCommand(argv.slice(1));
    if (!parsed) {
      process.stderr.write('Usage: wb-cli debug [agentId] -- <prompt>\n');
      process.exit(1);
    }
    const code = await runCommand(['--agent', parsed.agentId, parsed.prompt]);
    process.exit(code);
  }
  // catalog-driven path: any command that has been registered under COMMAND_CATALOG
  // with cli_visible=true is routed here. Special argv order for `captain use <id>`
  // hands straight to captainCommand.
  if (command === 'captain' && argv[1] === 'use') {
    process.exit(captainCommand(argv.slice(1)));
  }
  if (command === 'captain-use') {
    process.exit(captainCommand(['use', ...argv.slice(1)]));
  }
  if (catalogLookup(command) !== null) {
    process.exit(await dispatchCatalogCommand(command, argv.slice(1)));
  }
  const exitCode = command === 'list-agents' ? await listAgents() : await runCommand(resolveRunArgv(argv));
  process.exit(exitCode);
}

const isEntry = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isEntry) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
