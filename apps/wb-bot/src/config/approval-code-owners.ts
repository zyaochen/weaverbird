import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;

const RuleSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  codeOwnerOpenIds: z.array(z.string().regex(OPEN_ID_PATTERN)).min(1),
});

const BranchSchema = z.object({
  name: z.string().min(1),
  rules: z.array(RuleSchema).min(1),
});

const RepositorySchema = z.object({
  repoRoot: z.string().min(1),
  branches: z.array(BranchSchema).min(1),
});

export const ApprovalCodeOwnerConfigSchema = z.object({
  version: z.literal(1),
  repositories: z.array(RepositorySchema).min(1),
});

export type ApprovalCodeOwnerConfig = z.infer<typeof ApprovalCodeOwnerConfigSchema>;

export class ApprovalCodeOwnerConfigError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ApprovalCodeOwnerConfigError';
  }
}

function validateMode(path: string): void {
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new ApprovalCodeOwnerConfigError(`${path} permissions are too open (${(stat.mode & 0o777).toString(8)}), expected 600`);
  }
}

export function resolveApprovalCodeOwnerConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env['WB_APPROVAL_CODE_OWNER_CONFIG_PATH'];
  return raw && raw.trim() ? resolve(raw.trim()) : undefined;
}

export function loadApprovalCodeOwnerConfig(options: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): ApprovalCodeOwnerConfig {
  const env = options.env ?? process.env;
  const rawPath = options.configPath ?? resolveApprovalCodeOwnerConfigPath(env);
  if (!rawPath) {
    throw new ApprovalCodeOwnerConfigError('approval code owner config path is missing');
  }
  const path = resolve(rawPath);
  if (!existsSync(path)) {
    throw new ApprovalCodeOwnerConfigError(`approval code owner config not found: ${path}`);
  }
  validateMode(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ApprovalCodeOwnerConfigError(`failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  try {
    return ApprovalCodeOwnerConfigSchema.parse(parsed);
  } catch (error) {
    throw new ApprovalCodeOwnerConfigError('approval code owner config is invalid', error);
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withGlob = escaped
    .replace(/\*\*/g, '§§DOUBLESTAR§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§DOUBLESTAR§§/g, '.*');
  return new RegExp(`^${withGlob}$`);
}

export function resolveConfiguredCodeOwners(config: ApprovalCodeOwnerConfig, input: {
  repoRoot: string;
  branch: string;
  changedPaths: string[];
}): string[] {
  const repository = config.repositories.find((entry) => resolve(entry.repoRoot) === resolve(input.repoRoot));
  if (!repository) {
    throw new ApprovalCodeOwnerConfigError(`no approval repository config for ${input.repoRoot}`);
  }
  const branch = repository.branches.find((entry) => entry.name === input.branch);
  if (!branch) {
    throw new ApprovalCodeOwnerConfigError(`no approval branch config for ${input.branch}`);
  }
  const owners = new Set<string>();
  for (const changedPath of input.changedPaths) {
    const normalizedPath = changedPath.replace(/^\.\//, '');
    const matchingRule = branch.rules.find((rule) => rule.paths.some((pattern) => globToRegex(pattern).test(normalizedPath)));
    if (!matchingRule) {
      throw new ApprovalCodeOwnerConfigError(`no approval rule matched path ${normalizedPath}`);
    }
    for (const openId of matchingRule.codeOwnerOpenIds) owners.add(openId);
  }
  if (owners.size === 0) {
    throw new ApprovalCodeOwnerConfigError('resolved code owner set is empty');
  }
  return [...owners].sort();
}
