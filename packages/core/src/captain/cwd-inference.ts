import { execSync } from 'node:child_process';
import { CwdInferenceResultSchema, type CaptainTomlConfig, type CwdInferenceResult } from './contracts.js';

function readGitRemote(cwd: string): string {
  try {
    return execSync('git remote get-url origin', { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function inferCaptain(cwd: string, config: CaptainTomlConfig, gitRemote = readGitRemote(cwd)): CwdInferenceResult {
  for (const mapping of config.mapping) {
    if (new RegExp(mapping.git_remote).test(gitRemote)) {
      return CwdInferenceResultSchema.parse({ outcome: 'hit', captain_id: mapping.captain_id, matched_by: 'git_remote' });
    }
  }

  const hits = config.mapping
    .filter((mapping) => mapping.cwd_prefix && cwd.startsWith(mapping.cwd_prefix))
    .sort((left, right) => (right.cwd_prefix?.length ?? 0) - (left.cwd_prefix?.length ?? 0));
  if (hits.length > 0) {
    return CwdInferenceResultSchema.parse({ outcome: 'hit', captain_id: hits[0]!.captain_id, matched_by: 'cwd_prefix' });
  }

  const candidates = [...new Set(config.mapping.map((mapping) => mapping.captain_id))];
  return CwdInferenceResultSchema.parse({
    outcome: 'miss',
    candidates,
    suggestion: candidates.length > 0 ? `run: wb captain use ${candidates[0]}` : 'no captains configured; run: wb captain init',
  });
}
