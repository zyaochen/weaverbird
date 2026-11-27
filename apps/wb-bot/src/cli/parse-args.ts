export function parseArgs(argv: string[]): { botId?: string; help?: boolean } {
  const out: { botId?: string; help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--bot') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--bot requires a value');
      out.botId = v;
      continue;
    }
  }
  return out;
}
