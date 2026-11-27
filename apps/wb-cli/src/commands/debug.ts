/**
 * `wb-cli debug [agentId] -- <prompt>`
 * Foreground alias — runs agent with stdio inherited (TTY passthrough).
 * Equivalent to `wb-cli run` but with stderr visible inline.
 */
export function debugCommand(argv: string[]): { agentId: string; prompt: string } | null {
  const dashDash = argv.indexOf('--');
  let agentId = 'claude-code';
  let promptParts: string[];

  if (dashDash >= 0) {
    if (dashDash > 0) agentId = argv[0]!;
    promptParts = argv.slice(dashDash + 1);
  } else {
    promptParts = argv;
  }

  const prompt = promptParts.join(' ').trim();
  if (!prompt) return null;
  return { agentId, prompt };
}
