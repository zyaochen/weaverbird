import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ERROR_CODE_ENTRIES,
  ERROR_CODE_INDEX,
  ERROR_CODE_VALUES,
  ERROR_CODES,
  matchesAllowedErrorCodeDomain,
} from '../packages/core/src/errors/codes.js';

type FindingKind = 'duplicate' | 'prefix' | 'orphan' | 'unreferenced';
type Finding = { kind: FindingKind; message: string };
type MatchKind = 'definition' | 'usage';
type Match = { file: string; line: number; code: string; kind: MatchKind };

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

function collectMatches(filePath: string): Match[] {
  const raw = readFileSync(filePath, 'utf8');
  const content = stripComments(raw);
  const matches: Match[] = [];
  for (const lineMatch of content.matchAll(/^.*$/gm)) {
    const lineText = lineMatch[0] ?? '';
    const lineStart = lineMatch.index ?? 0;
    CODE_LITERAL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CODE_LITERAL.exec(lineText)) !== null) {
      const code = match[1] ?? match[2];
      const kind: MatchKind = match[1] ? 'definition' : 'usage';
      const line = content.slice(0, lineStart).split('\n').length;
      matches.push({ file: relative(ROOT, filePath), line, code, kind });
    }
  }
  return matches;
}

function findDuplicateRegistryValues(): Finding[] {
  const seen = new Map<string, string>();
  const findings: Finding[] = [];
  for (const entry of ERROR_CODE_ENTRIES) {
    const owner = `${entry.registryKey}.${entry.symbol}`;
    const previous = seen.get(entry.value);
    if (previous) {
      findings.push({
        kind: 'duplicate',
        message: `duplicate registry code value ${entry.value} (${previous}, ${owner})`,
      });
      continue;
    }
    seen.set(entry.value, owner);
  }
  return findings;
}

function findPrefixMismatches(): Finding[] {
  return ERROR_CODE_ENTRIES
    .filter((entry) => !matchesAllowedErrorCodeDomain(entry.registryKey, entry.value))
    .map((entry) => ({
      kind: 'prefix' as const,
      message: `registry prefix mismatch for ${entry.registryKey}.${entry.symbol}: ${entry.value}`,
    }));
}

function findOrphanCodes(matches: Match[]): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const match of matches) {
    if (ERROR_CODE_INDEX[match.code]) continue;
    const key = `${match.file}:${match.line}:${match.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      kind: 'orphan',
      message: `orphan code ${match.code} at ${match.file}:${match.line} (${match.kind})`,
    });
  }
  return findings;
}

function findUnreferencedRegisteredCodes(matches: Match[]): Finding[] {
  const referenced = new Set(matches.map((match) => match.code));
  return ERROR_CODE_ENTRIES
    .filter((entry) => !referenced.has(entry.value))
    .map((entry) => ({
      kind: 'unreferenced' as const,
      message: `registered code ${entry.value} is not referenced in packages/ or apps/ (${entry.registryKey}.${entry.symbol})`,
    }));
}

function main(): number {
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

  const matches = files.flatMap((file) => collectMatches(file));
  const findings = [
    ...findDuplicateRegistryValues(),
    ...findPrefixMismatches(),
    ...findOrphanCodes(matches),
    ...findUnreferencedRegisteredCodes(matches),
  ];

  if (findings.length === 0) {
    console.log(`lint:codes OK (${ERROR_CODE_VALUES.length} registered codes, ${matches.length} literal matches scanned)`);
    return 0;
  }

  for (const finding of findings) {
    console.error(`[${finding.kind}] ${finding.message}`);
  }
  console.error(`lint:codes FAILED (${findings.length} issue(s))`);
  return 1;
}

process.exitCode = main();
