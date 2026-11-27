import { createRunRegistryWriter, RunQuerySchema, type RunQuery, type RunRecord } from '../../../../packages/core/src/run-registry/index.js';
import type { CommandContext } from './router.js';

function formatHistoryLine(run: RunRecord): string {
  const docs = run.produced_doc_urls.slice(0, 3);
  const docSuffix = docs.length > 0 ? `\n  docs: ${docs.join(', ')}` : '';
  return `- ${run.run_id} | ${run.created_at} | ${run.cwd} | ${run.status} | ${run.agent}${docSuffix}`;
}

function parseHistoryArgs(args: string[]): RunQuery {
  const query: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const next = args[index + 1];
    if (arg === '--keyword' && next) {
      query['keyword'] = next;
      index += 1;
      continue;
    }
    if (arg === '--operator' && next) {
      query['operator'] = next;
      index += 1;
      continue;
    }
    if (arg === '--project' && next) {
      query['project'] = next;
      index += 1;
      continue;
    }
    if (arg === '--agent' && next) {
      query['agent'] = next;
      index += 1;
      continue;
    }
    if (arg === '--entry-form' && next) {
      query['entry_form'] = next;
      index += 1;
      continue;
    }
    if (arg === '--status' && next) {
      query['status'] = next;
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
  return RunQuerySchema.parse(query);
}

export function buildBitableFilter(query: RunQuery): string {
  const parts: string[] = [];
  if (query['operator']) parts.push(`CurrentValue.[operator]="${query['operator']}"`);
  if (query['project']) parts.push(`CurrentValue.[project]="${query['project']}"`);
  if (query['agent']) parts.push(`CurrentValue.[agent]="${query['agent']}"`);
  if (query['entry_form']) parts.push(`CurrentValue.[entry_form]="${query['entry_form']}"`);
  if (query['status']) parts.push(`CurrentValue.[status]="${query['status']}"`);
  if (query['after']) parts.push(`CurrentValue.[created_at]>=${Date.parse(query['after'])}`);
  if (query['before']) parts.push(`CurrentValue.[created_at]<=${Date.parse(query['before'])}`);
  if (query['keyword']) {
    parts.push(`OR(CurrentValue.[cwd]~"${query['keyword']}",CurrentValue.[cmd]~"${query['keyword']}",CurrentValue.[project]~"${query['keyword']}")`);
  }
  return parts.length > 0 ? `AND(${parts.join(',')})` : 'ALL()';
}

export async function handleHistory(args: string[], _ctx: CommandContext): Promise<string> {
  const query = parseHistoryArgs(args);
  const writer = createRunRegistryWriter();
  const result = await writer.queryRuns(query);
  const lines = ['📚 Run History'];
  if (result.runs.length === 0) {
    lines.push('(no runs)');
  } else {
    lines.push(...result.runs.map(formatHistoryLine));
  }
  if (result.next_cursor) {
    lines.push(`next_cursor=${result.next_cursor}`);
  }
  return lines.join('\n');
}
