import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ERROR_CODE_ALLOWED_DOMAINS,
  ERROR_CODES,
  ERROR_CODE_VALUES,
  extractErrorCodeDomain,
  matchesAllowedErrorCodeDomain,
} from '../../packages/core/src/errors/codes.js';

const ROOT = process.cwd();
const SOURCE_DIRS = ['packages', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', 'tests']);
const CODE_LITERAL = /E_[A-Z0-9_]+\s*:\s*['"]([a-z][a-z0-9-]*\.[a-z0-9._-]+)['"]|code\s*:\s*['"]([a-z][a-z0-9-]*\.[a-z0-9._-]+)['"]/g;

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walk(join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function stripComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function collectReferencedCodes(): Set<string> {
  const files = SOURCE_DIRS
    .map((dir) => join(ROOT, dir))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((dir) => walk(dir));

  const referenced = new Set<string>();
  for (const filePath of files) {
    const content = stripComments(readFileSync(filePath, 'utf8'));
    for (const lineMatch of content.matchAll(/^.*$/gm)) {
      const lineText = lineMatch[0] ?? '';
      CODE_LITERAL.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CODE_LITERAL.exec(lineText)) !== null) {
        const code = match[1] ?? match[2];
        if (code) referenced.add(code);
      }
    }
  }
  return referenced;
}

describe('T4-codes-unique', () => {
  it('keeps registered error code values globally unique', () => {
    expect(ERROR_CODE_VALUES.length).toBe(new Set(ERROR_CODE_VALUES).size);
  });

  it('keeps registered error code values in <domain>.<event> format', () => {
    for (const code of ERROR_CODE_VALUES) {
      expect(code).toMatch(/^[a-z][a-z0-9-]*\.[a-z0-9._-]+$/);
      const separator = code.indexOf('.');
      expect(separator).toBeGreaterThan(0);
      expect(separator).toBeLessThan(code.length - 1);
    }
  });

  it('keeps registered groups aligned with allowed domain prefixes', () => {
    for (const [registryKey, group] of Object.entries(ERROR_CODES)) {
      for (const value of Object.values(group)) {
        expect(matchesAllowedErrorCodeDomain(registryKey as keyof typeof ERROR_CODES, value)).toBe(true);
        expect(ERROR_CODE_ALLOWED_DOMAINS[registryKey as keyof typeof ERROR_CODE_ALLOWED_DOMAINS]).toContain(extractErrorCodeDomain(value));
      }
    }
  });

  it('covers all expected error code groups', () => {
    expect(Object.keys(ERROR_CODES)).toEqual([
      'config',
      'captain',
      'run-observability',
      'run-registry',
      'audit',
      'reverse',
    ]);
  });

  it('keeps registered error codes referenced somewhere in packages/ or apps/', () => {
    const referenced = collectReferencedCodes();
    for (const value of ERROR_CODE_VALUES) {
      expect(referenced.has(value)).toBe(true);
    }
  });
});
