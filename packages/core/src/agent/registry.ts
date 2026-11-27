import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCodeAgent } from './claude-code.js';
import { CodexAgent } from './codex.js';
import type { AgentAdapter } from './types.js';

export interface AgentRegistry {
  register(agent: AgentAdapter, command?: string): void;
  lookup(id: string): AgentAdapter | null;
  list(): readonly AgentAdapter[];
  isAvailable(id: string): Promise<boolean | null>;
}

type Entry = {
  agent: AgentAdapter;
  command?: string;
};

function isCommandOnPath(command: string): boolean {
  const pathEnv = process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      if (existsSync(join(dir, command + ext))) return true;
    }
  }
  return false;
}

export class DefaultAgentRegistry implements AgentRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(initial: Array<{ agent: AgentAdapter; command?: string }> = []) {
    for (const entry of initial) this.register(entry.agent, entry.command);
  }

  register(agent: AgentAdapter, command?: string): void {
    this.entries.set(agent.id, { agent, command });
  }

  lookup(id: string): AgentAdapter | null {
    return this.entries.get(id)?.agent ?? null;
  }

  list(): readonly AgentAdapter[] {
    return Array.from(this.entries.values(), (entry) => entry.agent);
  }

  async isAvailable(id: string): Promise<boolean | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.command && !isCommandOnPath(entry.command)) return false;
    return entry.agent.isAvailable();
  }
}

export function createDefaultAgentRegistry(): AgentRegistry {
  return new DefaultAgentRegistry([
    { agent: new ClaudeCodeAgent(), command: 'claude' },
    { agent: new CodexAgent(), command: 'codex' },
  ]);
}

export { isCommandOnPath };
