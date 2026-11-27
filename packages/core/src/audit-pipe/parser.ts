import type { ToolUseEvent } from './contracts.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseEventLine(line: string): ToolUseEvent | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed['type'] !== 'tool_use') return null;
  if (typeof parsed['id'] !== 'string' || typeof parsed['name'] !== 'string' || !('input' in parsed)) return null;
  const event: ToolUseEvent = { type: 'tool_use', id: parsed['id'], name: parsed['name'], input: parsed['input'] };
  if (typeof parsed['subagentId'] === 'string') event.subagentId = parsed['subagentId'];
  return event;
}
