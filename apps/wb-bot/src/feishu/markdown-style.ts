/**
 * agent 输出的 Markdown → 飞书卡片 markdown 组件能稳定渲染的形态.
 *
 * 飞书卡片 markdown 与 GitHub 风格的差异里, 会直接让卡片更新失败或难看的几处:
 * - 图片只认 `img_` 开头的飞书 image_key; 本地路径 / http 图片会让整次 CardKit 更新报错
 *   → 改写成链接或行内代码, 不丢信息
 * - 单卡表格数量有上限 → 超出的表格转成代码块原样保留
 * - H1~H3 在卡片里过大 → 统一降到 H4/H5
 * 代码块内部一律不动.
 */

const TABLE_LIMIT = 5;
const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

function protectFences(text: string): { body: string; restore: (s: string) => string } {
  const blocks: string[] = [];
  const body = text.replace(FENCE_RE, (block) => `\u0000F${blocks.push(block) - 1}\u0000`);
  return { body, restore: (s) => s.replace(/\u0000F(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? '') };
}

function rewriteImages(text: string): string {
  return text.replace(IMAGE_RE, (full, alt: string, target: string) => {
    if (target.startsWith('img_')) return full;
    if (/^https?:\/\//.test(target)) return `[${alt || '图片'}](${target})`;
    return `\`${target}\``;
  });
}

function demoteHeadings(text: string): string {
  if (!/^#{1,3} /m.test(text)) return text;
  return text.replace(/^(#{1,6}) (.+)$/gm, (_m, hashes: string, title: string) => (hashes.length === 1 ? `#### ${title}` : `##### ${title}`));
}

function limitTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let tables = 0;
  for (let i = 0; i < lines.length; i++) {
    const isHeader = /^\s*\|.*\|\s*$/.test(lines[i] ?? '') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '');
    if (!isHeader) {
      out.push(lines[i]!);
      continue;
    }
    let end = i;
    while (end + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[end + 1]!)) end++;
    const block = lines.slice(i, end + 1);
    tables++;
    if (tables > TABLE_LIMIT) out.push('```', ...block, '```');
    else out.push(...block);
    i = end;
  }
  return out.join('\n');
}

export function toFeishuMarkdown(text: string): string {
  if (!text) return text;
  const { body, restore } = protectFences(text);
  const styled = limitTables(demoteHeadings(rewriteImages(body))).replace(/\n{3,}/g, '\n\n');
  return restore(styled);
}

/**
 * 按长度切分, 不切在代码块中间: 切点落在 ``` 内时, 当前段补一个闭合 fence,
 * 下一段以同样的开 fence 续上, 两段各自都是合法 markdown.
 */
export function splitMarkdown(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  let carryFence = '';
  while (rest.length > 0) {
    const budget = Math.max(1, maxChars - carryFence.length - 4);
    let piece = rest.slice(0, budget);
    if (rest.length > budget) {
      const cut = piece.lastIndexOf('\n');
      if (cut > budget * 0.5) piece = piece.slice(0, cut + 1);
    }
    rest = rest.slice(piece.length);
    let chunk = carryFence ? `${carryFence}\n${piece}` : piece;
    const fences = chunk.match(/^```.*$/gm) ?? [];
    if (fences.length % 2 === 1 && rest.length > 0) {
      // 奇数个 fence 行 → 最后一行是还没闭合的开 fence (带语言标记就一起续上)
      carryFence = fences[fences.length - 1]!;
      chunk = `${chunk.replace(/\n?$/, '\n')}\`\`\``;
    } else {
      carryFence = '';
    }
    chunks.push(chunk);
  }
  return chunks;
}
