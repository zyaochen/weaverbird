export type AgentDisplayMeta = {
  emoji: string;
  supportsSubagent: boolean;
};

export const AGENT_DISPLAY: Record<string, AgentDisplayMeta> = {
  'claude-code': { emoji: '🧠', supportsSubagent: true },
  'codex': { emoji: '⚡', supportsSubagent: false },
  'mira-cli': { emoji: '🔧', supportsSubagent: false },
};

const FALLBACK: AgentDisplayMeta = { emoji: '🤖', supportsSubagent: false };

export function getAgentDisplay(agentId: string): AgentDisplayMeta {
  return AGENT_DISPLAY[agentId] ?? FALLBACK;
}

function validateEmoji(meta: AgentDisplayMeta, agentId: string): void {
  const { emoji } = meta;
  if (emoji.length === 0 || emoji.length > 4) {
    throw new Error(`agent-display: ${agentId} emoji length must be 1-4 UTF-16 chars, got ${emoji.length}`);
  }
  if (/^[\x00-\x1F\x7F]/.test(emoji)) {
    throw new Error(`agent-display: ${agentId} emoji must not be control char`);
  }
  if (/^[A-Za-z]$/.test(emoji)) {
    throw new Error(`agent-display: ${agentId} emoji must not be ASCII letter`);
  }
}

for (const [agentId, meta] of Object.entries(AGENT_DISPLAY)) {
  validateEmoji(meta, agentId);
}
