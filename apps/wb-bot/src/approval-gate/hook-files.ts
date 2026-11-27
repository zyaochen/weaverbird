import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvalGateDir } from '../../../../packages/core/src/paths.js';

const DEFAULT_CODEX_HOME = join(homedir(), '.codex');
const DEPRECATED_CODEX_HOOKS_PATTERN = /^\s*codex_hooks\s*=.*$/m;
const CODEX_HOME_EXCLUDED_ENTRIES = new Set(['config.toml', 'hooks.json']);

function isTomlTableHeader(trimmed: string): boolean {
  return /^\[\[?.+\]\]?(?:\s+#.*)?$/.test(trimmed);
}

function isHookTableHeader(trimmed: string): boolean {
  return /^\[\[?hooks(?:\.|\])/.test(trimmed);
}

function buildNodeInvocation(scriptPath: string): string {
  const absScriptPath = resolve(scriptPath);
  if (absScriptPath.endsWith('.js')) {
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(absScriptPath)}`;
  }
  let dir = dirname(absScriptPath);
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
  if (tsxLoader) {
    return `${JSON.stringify(process.execPath)} --import ${JSON.stringify(tsxLoader)} ${JSON.stringify(absScriptPath)}`;
  }
  return `${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(absScriptPath)}`;
}

export type ApprovalHookFiles = {
  wrapperScriptPath: string;
  claudeSettingsPath: string;
  codexHome: string;
  codexRuntimeArgs: string[];
};

type ParsedCodexConfig = {
  root: Map<string, string>;
  modelProviders: Map<string, Map<string, string>>;
};

function resolveSourceCodexHome(): string {
  const override = process.env['CODEX_HOME'];
  return override && override.trim() ? override.trim() : DEFAULT_CODEX_HOME;
}

function sanitizeCodexConfig(content: string): string {
  const lines = content.split(/\r?\n/);
  const filtered: string[] = [];
  let skippingHookTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (isHookTableHeader(trimmed)) {
      skippingHookTable = true;
      continue;
    }
    if (skippingHookTable && isTomlTableHeader(trimmed)) {
      skippingHookTable = false;
    }
    if (skippingHookTable) continue;
    if (DEPRECATED_CODEX_HOOKS_PATTERN.test(line)) continue;
    filtered.push(line);
  }

  while (filtered.length > 0 && filtered.at(-1) === '') filtered.pop();
  return filtered.join('\n');
}

function withHooksEnabled(content: string): string {
  const sanitized = sanitizeCodexConfig(content).trimEnd();
  if (!sanitized) return '[features]\nhooks = true\n';

  const lines = sanitized.split('\n');
  const out: string[] = [];
  let insideFeatures = false;
  let featureHooksPatched = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (insideFeatures && !featureHooksPatched) out.push('hooks = true');
      insideFeatures = trimmed === '[features]';
      featureHooksPatched = false;
      out.push(line);
      continue;
    }

    if (insideFeatures && /^\s*hooks\s*=/.test(line)) {
      out.push('hooks = true');
      featureHooksPatched = true;
      continue;
    }

    out.push(line);
  }

  if (insideFeatures && !featureHooksPatched) out.push('hooks = true');
  if (out.some((line) => line.trim() === '[features]')) return `${out.join('\n')}\n`;
  return `${out.join('\n')}\n\n[features]\nhooks = true\n`;
}

function stripTomlInlineComment(value: string): string {
  let quote: '"' | '\'' | null = null;
  let escaped = false;
  let out = '';

  for (const ch of value) {
    if (quote === '"' && escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '#') break;
    if (ch === '"' || ch === '\'') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }

  return out.trim();
}

function parseCodexConfig(content: string): ParsedCodexConfig {
  const root = new Map<string, string>();
  const modelProviders = new Map<string, Map<string, string>>();
  let currentProvider: string | null = null;
  let currentIsRoot = true;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const tableMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      const tableName = tableMatch[1]!.trim();
      const providerMatch = tableName.match(/^model_providers\.([^\.]+)$/);
      if (providerMatch) {
        currentProvider = providerMatch[1]!;
        currentIsRoot = false;
        if (!modelProviders.has(currentProvider)) modelProviders.set(currentProvider, new Map());
      } else {
        currentProvider = null;
        currentIsRoot = false;
      }
      continue;
    }

    if (trimmed.startsWith('[[')) {
      currentProvider = null;
      currentIsRoot = false;
      continue;
    }

    const kvMatch = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1]!;
    const value = stripTomlInlineComment(kvMatch[2]!);
    if (!value) continue;

    if (currentProvider) {
      modelProviders.get(currentProvider)!.set(key, value);
      continue;
    }

    if (currentIsRoot) {
      const dottedProviderMatch = key.match(/^model_providers\.([^\.]+)\.(.+)$/);
      if (dottedProviderMatch) {
        const providerName = dottedProviderMatch[1]!;
        const providerKey = dottedProviderMatch[2]!;
        if (!modelProviders.has(providerName)) modelProviders.set(providerName, new Map());
        modelProviders.get(providerName)!.set(providerKey, value);
        continue;
      }
      root.set(key, value);
    }
  }

  return { root, modelProviders };
}

function buildCodexPreToolUseOverride(wrapperScriptPath: string): string {
  return `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(wrapperScriptPath)},timeout=3605,statusMessage="Checking approval gate"}]}]`;
}

// Runtime argv that carries codex config under the approval-gate path.
//
// Why `-c` and not config.toml: codex runs with `--ignore-user-config`, which
// makes `$CODEX_HOME/config.toml` a no-op for runtime config (auth still uses
// CODEX_HOME). The config.toml written by buildCodexConfig is therefore
// inert at runtime; hooks / model / model_providers survive only because they
// are re-injected here as `-c key=value`. codex parses each `-c` value as TOML,
// so values must be TOML literals (quoted strings stay quoted; booleans bare).
//
// model_provider has two sources: an explicit `model_provider` root key (its
// value is already a TOML literal, e.g. `"llmgw"`, so it is passed through
// verbatim) or, when absent and exactly one provider is defined, the provider
// table name (a bare TOML key, so JSON.stringify wraps it into a string
// literal). Both paths yield a valid `model_provider=<toml-string>` form.
function buildCodexRuntimeArgs(wrapperScriptPath: string, sourceConfigRaw: string): string[] {
  const parsed = parseCodexConfig(sourceConfigRaw);
  const args = ['--ignore-user-config', '--dangerously-bypass-hook-trust'];

  for (const key of ['model_catalog_json', 'model', 'model_reasoning_effort'] as const) {
    const value = parsed.root.get(key);
    if (value) args.push('-c', `${key}=${value}`);
  }

  for (const [providerName, entries] of parsed.modelProviders) {
    for (const [key, value] of entries) {
      args.push('-c', `model_providers.${providerName}.${key}=${value}`);
    }
  }

  const explicitProvider = parsed.root.get('model_provider');
  if (explicitProvider) {
    args.push('-c', `model_provider=${explicitProvider}`);
  } else if (parsed.modelProviders.size === 1) {
    const inferredProvider = parsed.modelProviders.keys().next().value as string | undefined;
    if (inferredProvider) args.push('-c', `model_provider=${JSON.stringify(inferredProvider)}`);
  }

  args.push('-c', 'features.hooks=true');
  args.push('-c', buildCodexPreToolUseOverride(wrapperScriptPath));
  return args;
}

function getEntryKind(path: string): 'dir' | 'file' | 'other' {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile() || stat.isSymbolicLink()) return 'file';
  return 'other';
}

function syncCodexHome(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(sourceDir)) return;

  for (const entry of readdirSync(targetDir)) {
    if (CODEX_HOME_EXCLUDED_ENTRIES.has(entry)) continue;
    const targetPath = join(targetDir, entry);
    if (!existsSync(join(sourceDir, entry))) rmSync(targetPath, { recursive: true, force: true });
  }

  for (const entry of CODEX_HOME_EXCLUDED_ENTRIES) {
    rmSync(join(targetDir, entry), { recursive: true, force: true });
  }

  for (const entry of readdirSync(sourceDir)) {
    if (CODEX_HOME_EXCLUDED_ENTRIES.has(entry)) continue;
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const sourceKind = getEntryKind(sourcePath);
    if (sourceKind === 'other') continue;

    if (existsSync(targetPath)) {
      const targetKind = getEntryKind(targetPath);
      if (targetKind === sourceKind) continue;
      rmSync(targetPath, { recursive: true, force: true });
    }

    if (!existsSync(targetPath)) symlinkSync(sourcePath, targetPath, sourceKind);
  }
}

function buildCodexConfig(wrapperScriptPath: string, sourceConfigRaw: string): string {
  const base = withHooksEnabled(sourceConfigRaw).trimEnd();
  return `${base}\n\n[[hooks.PreToolUse]]\nmatcher = "*"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(wrapperScriptPath)}\ntimeout = 3605\nstatusMessage = "Checking approval gate"\n`;
}

export function prepareApprovalHookFiles(options: {
  dataDir: string;
  hookScriptPath: string;
}): ApprovalHookFiles {
  const root = approvalGateDir(options.dataDir);
  const hooksDir = join(root, 'hooks');
  const claudeDir = join(root, 'claude');
  const codexHome = join(root, 'codex-home');
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  const wrapperScriptPath = join(hooksDir, 'approval-gate-hook.sh');
  const invocation = buildNodeInvocation(options.hookScriptPath);
  writeFileSync(wrapperScriptPath, `#!/bin/sh\nexec ${invocation} "$@"\n`, { mode: 0o755 });
  chmodSync(wrapperScriptPath, 0o755);

  const claudeSettingsPath = join(claudeDir, 'settings.json');
  writeFileSync(claudeSettingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: wrapperScriptPath,
              timeout: 3605,
              statusMessage: 'Checking approval gate',
            },
          ],
        },
      ],
    },
  }, null, 2));

  const sourceCodexHome = resolveSourceCodexHome();
  syncCodexHome(sourceCodexHome, codexHome);
  const codexConfigPath = join(codexHome, 'config.toml');
  const sourceConfigPath = join(sourceCodexHome, 'config.toml');
  const sourceConfigRaw = existsSync(sourceConfigPath) ? readFileSync(sourceConfigPath, 'utf8') : '';
  // config.toml is written for completeness/debuggability, but at runtime it is
  // inert: codex runs with --ignore-user-config (see buildCodexRuntimeArgs), so
  // the live hooks/model/model_providers come from the `-c` argv, not this file.
  writeFileSync(codexConfigPath, buildCodexConfig(wrapperScriptPath, sourceConfigRaw));
  const codexRuntimeArgs = buildCodexRuntimeArgs(wrapperScriptPath, sourceConfigRaw);

  return { wrapperScriptPath, claudeSettingsPath, codexHome, codexRuntimeArgs };
}
