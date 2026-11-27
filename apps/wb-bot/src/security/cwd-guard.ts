import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

export const DEFAULT_CWD_ALLOWLIST = [
  '$HOME/projects',
  '$HOME/code',
  '$HOME/work',
  '/tmp',
  '/private/tmp',
] as const;

export const CWD_DENYLIST = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/root',
  '$HOME/.ssh',
  '$HOME/.gnupg',
  '$HOME/.aws',
  '$HOME/.docker',
  '$HOME/.kube',
  '$HOME/.netrc',
  '$HOME/.config/gh',
  '$HOME/.weaverbird',
  '$HOME/Library/Keychains',
  '/Library/Keychains',
  '$HOME/Library/Cookies',
] as const;

export type CwdValidation = { ok: true; path: string } | { ok: false; reason: string };

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`;
  return path.replace('$HOME', home);
}

function normalizePath(path: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path;
}

function canonicalizePath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

export function validateCwd(
  input: string,
  allowlist: readonly string[] = DEFAULT_CWD_ALLOWLIST,
  denylist: readonly string[] = CWD_DENYLIST,
): CwdValidation {
  if (!input || input.trim() === '') return { ok: false, reason: 'empty path' };
  const home = homedir();
  const resolved = resolve(expandHome(input.trim(), home));
  if (!existsSync(resolved)) return { ok: false, reason: 'path does not exist' };
  let canonical = '';
  try {
    canonical = realpathSync(resolved);
  } catch {
    return { ok: false, reason: 'cannot resolve realpath' };
  }
  const target = normalizePath(canonical);
  for (const entry of denylist) {
    const denied = normalizePath(canonicalizePath(expandHome(entry, home)));
    if (isWithin(denied, target)) return { ok: false, reason: `denied (protected): ${entry}` };
  }
  for (const entry of allowlist) {
    const allowed = normalizePath(canonicalizePath(expandHome(entry, home)));
    if (isWithin(allowed, target)) return { ok: true, path: canonical };
  }
  return { ok: false, reason: 'not in allowlist; use /cwd-add to allow a prefix' };
}
