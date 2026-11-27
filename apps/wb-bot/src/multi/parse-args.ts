export interface MultiCliArgs {
  configDir?: string;
  help?: boolean;
}

export function parseMultiArgs(argv: string[]): MultiCliArgs {
  const out: MultiCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--config') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--config requires a value');
      out.configDir = value;
    }
  }
  return out;
}
