import { describe, expect, it } from 'vitest';
import { splitMarkdown, toFeishuMarkdown } from '../../apps/wb-bot/src/feishu/markdown-style.js';

describe('toFeishuMarkdown', () => {
  it('rewrites images that are not Feishu image keys and keeps img_ keys', () => {
    expect(toFeishuMarkdown('![a](img_v3_x) ![b](https://x.dev/p.png) ![](./out/plot.png)'))
      .toBe('![a](img_v3_x) [b](https://x.dev/p.png) `./out/plot.png`');
  });

  it('demotes headings only when large headings are present', () => {
    expect(toFeishuMarkdown('# A\n## B\n#### C')).toBe('#### A\n##### B\n##### C');
    expect(toFeishuMarkdown('#### keep')).toBe('#### keep');
  });

  it('leaves fenced code untouched', () => {
    const text = '# T\n```md\n# not a heading\n![x](./a.png)\n```';
    expect(toFeishuMarkdown(text)).toBe('#### T\n```md\n# not a heading\n![x](./a.png)\n```');
  });

  it('turns tables beyond the fifth into code blocks', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const out = toFeishuMarkdown(Array.from({ length: 6 }, () => table).join('\n\n'));
    expect(out.match(/```/g)).toHaveLength(2);
    expect(out.endsWith(`\`\`\`\n${table}\n\`\`\``)).toBe(true);
  });

  it('collapses runs of blank lines', () => {
    expect(toFeishuMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('splitMarkdown', () => {
  it('returns short text as one chunk', () => {
    expect(splitMarkdown('abc', 10)).toEqual(['abc']);
  });

  it('never leaves a code fence open across chunks', () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const text = `intro\n\`\`\`ts\n${code}\n\`\`\`\noutro`;
    const chunks = splitMarkdown(text, 120);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
    expect(chunks[1]!.startsWith('```ts\n')).toBe(true);
    const rejoined = chunks.join('\n').replace(/\n```\n```ts\n/g, '\n');
    expect(rejoined.replace(/\n+/g, '\n')).toBe(text.replace(/\n+/g, '\n'));
  });
});
