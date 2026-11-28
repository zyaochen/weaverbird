import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCodeAgent,
  CodexAgent,
  DefaultAgentRegistry,
  type AgentRegistry,
  type RunRequest,
} from '../../../packages/core/src/index.js';
import { isCommandOnPath } from '../../../packages/core/src/agent/registry.js';
import { buildClaudeAgentEnv, shouldPreferClaudeOAuth } from './security/env-whitelist.js';
import { extractModelFromArgs, stripModelArgs } from './feishu/event-handler.js';

type ClaudeAuthStatus = {
  loggedIn?: boolean;
  authMethod?: string;
};

type BotRegistryOptions = {
  dataDir: string;
  claudeCommand: string;
  codexCommand: string;
};

/**
 * `WB_CLAUDE_COMMAND="claude-w --model X"` 这类带参数的写法: 第一个词是可执行文件, 其余前置到 argv.
 * 与 wb-runner 路径 (event-handler) 的拆分规则一致; 不拆的话可用性检查找不到 `claude-w --model X`
 * 这个文件, 所有 agent 都被判为不可用.
 */
function splitCommand(command: string): { head: string; prepend: string[] } {
  const [head, ...prepend] = command.trim().split(/\s+/);
  return { head: head ?? command, prepend };
}

function commandExists(command: string): boolean {
  return command.includes('/') ? existsSync(command) : isCommandOnPath(command);
}

function supportsAuthStatus(command: string): boolean {
  const result = spawnSync(command, ['auth', 'status', '--json'], {
    encoding: 'utf8',
    timeout: 3000,
    env: buildClaudeAgentEnv(process.env, false),
  });
  return result.status === 0 && result.stdout.trim().startsWith('{');
}

function readClaudeAuthStatus(command: string, env: NodeJS.ProcessEnv): ClaudeAuthStatus | null {
  const result = spawnSync(command, ['auth', 'status', '--json'], {
    encoding: 'utf8',
    timeout: 3000,
    env: buildClaudeAgentEnv(env, false),
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout) as ClaudeAuthStatus;
  } catch {
    return null;
  }
}

const DEFAULT_CODEX_HOME = join(homedir(), '.codex');
const DEPRECATED_CODEX_HOOKS_PATTERN = /^\s*codex_hooks\s*=.*$/m;

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const override = env['CODEX_HOME'];
  return override && override.trim() ? override : DEFAULT_CODEX_HOME;
}

function hasDeprecatedCodexHooksConfig(codexHome: string): boolean {
  const configPath = join(codexHome, 'config.toml');
  if (!existsSync(configPath)) return false;
  return DEPRECATED_CODEX_HOOKS_PATTERN.test(readFileSync(configPath, 'utf8'));
}

function sanitizeCodexConfig(content: string): string {
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line, index, source) => {
    if (DEPRECATED_CODEX_HOOKS_PATTERN.test(line)) return false;
    return !(index === source.length - 1 && line === '');
  });
  return `${filtered.join('\n')}${content.endsWith('\n') ? '\n' : ''}`;
}

function getSymlinkType(path: string): 'dir' | 'file' | 'other' {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile() || stat.isSymbolicLink()) return 'file';
  return 'other';
}

function syncCodexHome(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(sourceDir)) return;

  for (const entry of readdirSync(targetDir)) {
    const targetPath = join(targetDir, entry);
    if (!existsSync(join(sourceDir, entry))) rmSync(targetPath, { recursive: true, force: true });
  }

  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);

    if (entry === 'config.toml') {
      const sanitized = sanitizeCodexConfig(readFileSync(sourcePath, 'utf8'));
      writeFileSync(targetPath, sanitized);
      continue;
    }

    const sourceType = getSymlinkType(sourcePath);
    if (sourceType === 'other') continue;

    if (existsSync(targetPath)) {
      const targetType = getSymlinkType(targetPath);
      if (targetType === 'file' && sourceType === 'file') continue;
      if (targetType === 'dir' && sourceType === 'dir') continue;
      rmSync(targetPath, { recursive: true, force: true });
    }

    symlinkSync(sourcePath, targetPath, sourceType);
  }
}

class OAuthFirstClaudeCodeAgent extends ClaudeCodeAgent {
  private preferOAuth?: boolean;
  private readonly command: string;
  private readonly prepend: string[];

  constructor(
    command: string,
    private readonly authStatusSupported: boolean,
  ) {
    super();
    ({ head: this.command, prepend: this.prepend } = splitCommand(command));
  }

  override async isAvailable(): Promise<boolean> {
    if (!commandExists(this.command)) return false;
    if (!this.authStatusSupported) return true;
    const result = spawnSync(this.command, ['--version'], { encoding: 'utf8', timeout: 3000 });
    return result.status === 0;
  }

  protected override buildProcessSpec(req: RunRequest) {
    // claude-w skips interactive model selection only when --model is in $@.
    // If ANTHROPIC_MODEL env is set and no explicit model was requested,
    // inject it so the wrapper sees the flag and skips the TTY picker.
    // A model written into the command itself is moved into the single --model slot.
    const commandModel = extractModelFromArgs(this.prepend);
    const prepend = commandModel ? stripModelArgs(this.prepend) : this.prepend;
    const effectiveModel = req.model ?? commandModel ?? process.env['ANTHROPIC_MODEL'];
    const spec = super.buildProcessSpec({ ...req, model: effectiveModel });
    return { ...spec, command: this.command, args: [...prepend, ...spec.args] };
  }

  protected override envFilter(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!this.authStatusSupported) return buildClaudeAgentEnv(env, false);
    this.preferOAuth ??= shouldPreferClaudeOAuth(readClaudeAuthStatus(this.command, env));
    return buildClaudeAgentEnv(env, this.preferOAuth);
  }
}

class ConfigurableCodexAgent extends CodexAgent {
  private readonly isolatedCodexHome: string;
  private readonly command: string;
  private readonly prepend: string[];

  constructor(
    command: string,
    dataDir: string,
  ) {
    super();
    ({ head: this.command, prepend: this.prepend } = splitCommand(command));
    this.isolatedCodexHome = join(dataDir, 'wb-bot-codex-home');
  }

  override async isAvailable(): Promise<boolean> {
    if (!commandExists(this.command)) return false;
    if (this.command !== 'codex') return true;
    const result = spawnSync(this.command, ['--version'], { encoding: 'utf8', timeout: 3000 });
    return result.status === 0 && result.stdout.toLowerCase().includes('codex');
  }

  protected override buildProcessSpec(req: RunRequest) {
    // codex-w skips interactive model selection only when -c model=... is in $@.
    // Fall back to CODEX_MODEL env so the wrapper sees the flag and skips the TTY picker.
    // `--model X` written into the command goes through the same slot; `-c model=X` stays in prepend.
    const commandModel = extractModelFromArgs(this.prepend);
    const prepend = commandModel ? stripModelArgs(this.prepend) : this.prepend;
    const effectiveModel = req.model ?? commandModel ?? (this.command !== 'codex' ? process.env['CODEX_MODEL'] : undefined);
    const spec = super.buildProcessSpec({ ...req, model: effectiveModel });
    if (!effectiveModel || this.command === 'codex') return { ...spec, command: this.command, args: [...prepend, ...spec.args] };
    const args = spec.args.filter((arg, index, source) => arg !== '--model' && source[index - 1] !== '--model');
    return { ...spec, command: this.command, args: [...prepend, '-c', `model=${effectiveModel}`, ...args] };
  }

  protected override envFilter(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const filtered = { ...env };
    const sourceCodexHome = resolveCodexHome(filtered);
    if (!hasDeprecatedCodexHooksConfig(sourceCodexHome)) return filtered;
    syncCodexHome(sourceCodexHome, this.isolatedCodexHome);
    filtered['CODEX_HOME'] = this.isolatedCodexHome;
    delete filtered['CODEX_CONFIG_DIR'];
    return filtered;
  }
}

export function createBotAgentRegistry(options: BotRegistryOptions): AgentRegistry {
  return new DefaultAgentRegistry([
    {
      agent: new OAuthFirstClaudeCodeAgent(
        options.claudeCommand,
        supportsAuthStatus(splitCommand(options.claudeCommand).head),
      ),
    },
    { agent: new ConfigurableCodexAgent(options.codexCommand, options.dataDir) },
  ]);
}
