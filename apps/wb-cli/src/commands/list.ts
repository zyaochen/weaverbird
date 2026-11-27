import { createRunRegistryWriter, type RunRecord } from '@weaverbird/core/run-registry';

export type ListCommandOptions = {
  cwd?: string;
};

// Reads all runs (across every captain) from the Run Registry and prints a compact
// captain-oriented digest. This is the cli-side aggregate view the PRD anchors to
// `wb list --all-captains`; we do not do a per-captain split yet — just a newest-first
// cross-captain run listing so the author can spot drift across bots in one pulse.
export async function listCommand(_argv: string[], _opts: ListCommandOptions = {}): Promise<number> {
  const writer = createRunRegistryWriter();
  let result;
  try {
    result = await writer.queryRuns({ limit: 50 });
  } catch (error) {
    process.stderr.write(`list --all-captains query failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const runs = result.runs;
  if (runs.length === 0) {
    process.stdout.write('(no runs across captains)\n');
    return 0;
  }
  const lines = runs.map((run: RunRecord) => `${run.run_id}\t${run.status}\t${run.agent}\t${run.cwd}\t${run.created_at}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
