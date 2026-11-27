export function parseCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? '';
    if (quote === 'single') {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error('unterminated quote');
  if (current) tokens.push(current);
  return tokens;
}
