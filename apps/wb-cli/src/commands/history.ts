import { createRunRegistryWriter, RunQuerySchema, type RunQuery } from '../../../../packages/core/src/run-registry/index.js';

export function parseHistoryArgs(argv: string[]): { query: RunQuery; json: boolean; allCaptains: boolean } {
  const query: Record<string, unknown> = {};
  let json = false;
  let allCaptains = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const next = argv[index + 1];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--all-captains') {
      allCaptains = true;
      continue;
    }
    if (arg === '--keyword' && next) {
      query['keyword'] = next;
      index += 1;
      continue;
    }
    if (arg === '--status' && next) {
      query['status'] = next;
      index += 1;
      continue;
    }
    if (arg === '--agent' && next) {
      query['agent'] = next;
      index += 1;
      continue;
    }
    if (arg === '--after' && next) {
      query['after'] = next;
      index += 1;
      continue;
    }
    if (arg === '--before' && next) {
      query['before'] = next;
      index += 1;
      continue;
    }
    if (arg === '--limit' && next) {
      query['limit'] = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === '--cursor' && next) {
      query['cursor'] = next;
      index += 1;
    }
  }
  return { query: RunQuerySchema.parse(query), json, allCaptains };
}

function renderTable(runs: Awaited<ReturnType<ReturnType<typeof createRunRegistryWriter>['queryRuns']>>['runs']): string {
  if (runs.length === 0) return '(no runs)\n';
  return runs.map((run) => `${run.run_id}\t${run.status}\t${run.agent}\t${run.cwd}\t${run.created_at}`).join('\n') + '\n';
}

export async function historyCommand(argv: string[]): Promise<number> {
  const { query, json, allCaptains } = parseHistoryArgs(argv);
  const writer = createRunRegistryWriter();
  const result = await writer.queryRuns(query);
  if (json) {
    for (const run of result.runs) {
      process.stdout.write(`${JSON.stringify({ ...run, _aggregate: allCaptains ? 'all-captains' : 'current' })}\n`);
    }
    return 0;
  }
  process.stdout.write(renderTable(result.runs));
  if (allCaptains) process.stderr.write('view=all-captains\n');
  if (result.next_cursor) process.stderr.write(`next_cursor=${result.next_cursor}\n`);
  return 0;
}
