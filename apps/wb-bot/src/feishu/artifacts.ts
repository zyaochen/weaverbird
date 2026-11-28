import { realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolEntry } from './stream-state.js';

/**
 * 产物回传: run 结束时找出这一轮在 cwd 里新生成 / 改过的文件, 在结束卡上给出「发送」按钮.
 * 只在点击时上传, 不自动外发; 只认 cwd 内的普通文件, 避免把别处的文件发进群.
 */

export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_ARTIFACTS = 3;
/** mtime 与 run 开始时间比较时容忍的时钟误差. */
const MTIME_SLACK_MS = 2_000;
const PATH_KEYS = ['file_path', 'path', 'filename', 'output_path', 'target_file'];
// 文本里的绝对路径或 ./ 开头的相对路径, 要求带扩展名, 免得把目录当成产物.
const TEXT_PATH_RE = /(?:^|[\s`'"(（])((?:\/|\.\/)[^\s`'"()<>（）]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),.;:!?)）。，；：])/gm;
// agent 用 Bash 生成文件时常只在正文里写 `chart.png` 这样的裸文件名; 只认反引号里的, 仍须在 cwd 内且本轮新生成.
const CODE_SPAN_PATH_RE = /`([^`\s/][^`\s]*\.[A-Za-z0-9]{1,8})`/g;

function toolPaths(tools: readonly ToolEntry[]): string[] {
  const paths: string[] = [];
  for (const tool of tools) {
    if (tool.isError || !tool.input || typeof tool.input !== 'object') continue;
    const input = tool.input as Record<string, unknown>;
    for (const key of PATH_KEYS) {
      if (typeof input[key] === 'string') paths.push(input[key] as string);
    }
  }
  return paths;
}

function textPaths(text: string): string[] {
  return [...text.matchAll(TEXT_PATH_RE), ...text.matchAll(CODE_SPAN_PATH_RE)].map((match) => match[1]!);
}

function realCwd(cwd: string): string | null {
  try {
    return realpathSync(cwd);
  } catch {
    return null; // cwd 已被删除: 没有可回传的产物
  }
}

export function findArtifacts(input: { tools: readonly ToolEntry[]; text: string; cwd?: string; startedAt: number }): string[] {
  if (!input.cwd) return [];
  const root = realCwd(input.cwd);
  if (!root) return [];
  const found: string[] = [];
  for (const candidate of [...toolPaths(input.tools), ...textPaths(input.text)]) {
    const absolute = isAbsolute(candidate) ? candidate : resolve(input.cwd, candidate);
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      continue; // agent 提到但不存在 (或已删除) 的路径
    }
    if (found.includes(real) || !(real === root || real.startsWith(`${root}${sep}`))) continue;
    const stat = statSync(real);
    if (!stat.isFile() || stat.size === 0 || stat.size > ARTIFACT_MAX_BYTES) continue;
    if (stat.mtimeMs < input.startedAt - MTIME_SLACK_MS) continue;
    found.push(real);
    if (found.length >= MAX_ARTIFACTS) break;
  }
  return found;
}

export function artifactLabel(path: string, cwd: string | undefined): string {
  if (!cwd) return basename(path);
  const rel = relative(realCwd(cwd) ?? cwd, path);
  return rel && !rel.startsWith('..') ? rel : basename(path);
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
/** im.v1.image.create 的上限; 更大的图片按普通文件发. */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export type UploadKind =
  | { kind: 'image' }
  | { kind: 'file'; fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' };

export function uploadKind(path: string, size: number): UploadKind {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXTS.has(ext) && size <= IMAGE_MAX_BYTES) return { kind: 'image' };
  if (ext === '.pdf') return { kind: 'file', fileType: 'pdf' };
  if (ext === '.mp4') return { kind: 'file', fileType: 'mp4' };
  if (ext === '.opus') return { kind: 'file', fileType: 'opus' };
  if (ext === '.doc' || ext === '.docx') return { kind: 'file', fileType: 'doc' };
  if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') return { kind: 'file', fileType: 'xls' };
  if (ext === '.ppt' || ext === '.pptx') return { kind: 'file', fileType: 'ppt' };
  return { kind: 'file', fileType: 'stream' };
}
