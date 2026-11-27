import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { InboundResource } from './message-parser.js';

/**
 * 入站附件落盘. 飞书资源 (图片 / 文件 / 音视频) 只给 key, agent CLI 只认本地路径,
 * 所以进 agent 前下载到 `<dataDir>/media/<sha256>.<ext>`, 按内容 hash 去重.
 *
 * 上限: 单文件 `WB_MEDIA_MAX_MB` (默认 20MB), 目录总量 `WB_MEDIA_CACHE_MAX_MB`
 * (默认 1024MB, 超出按 mtime 淘汰最旧的). 下载失败 / 超限不 throw, 记进 failures
 * 由调用方在卡片上明示.
 */

export type ResourceDownloadType = 'image' | 'file';
export type ResourceDownloader = (messageId: string, fileKey: string, type: ResourceDownloadType) => Promise<Buffer>;

export type ResolvedResource = { resource: InboundResource; path: string };
export type FailedResource = { resource: InboundResource; reason: string };

export type MediaCacheOptions = {
  rootDir: string;
  download: ResourceDownloader;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

const MB = 1024 * 1024;

export function mediaLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): { maxFileBytes: number; maxTotalBytes: number } {
  const fileMb = Number(env['WB_MEDIA_MAX_MB']);
  const totalMb = Number(env['WB_MEDIA_CACHE_MAX_MB']);
  return {
    maxFileBytes: (Number.isFinite(fileMb) && fileMb > 0 ? fileMb : 20) * MB,
    maxTotalBytes: (Number.isFinite(totalMb) && totalMb > 0 ? totalMb : 1024) * MB,
  };
}

function sniffImageExt(buf: Buffer): string {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return '.gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return '.png';
}

function extFor(resource: InboundResource, buf: Buffer): string {
  if (resource.type === 'image') return sniffImageExt(buf);
  if (resource.type === 'audio') return '.opus';
  if (resource.type === 'video') return '.mp4';
  const fromName = resource.fileName ? extname(resource.fileName).toLowerCase() : '';
  return /^\.[a-z0-9]{1,10}$/.test(fromName) ? fromName : '.bin';
}

export class MediaCache {
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;

  constructor(private readonly opts: MediaCacheOptions) {
    const defaults = mediaLimitsFromEnv();
    this.maxFileBytes = opts.maxFileBytes ?? defaults.maxFileBytes;
    this.maxTotalBytes = opts.maxTotalBytes ?? defaults.maxTotalBytes;
  }

  async resolve(messageId: string, resources: InboundResource[]): Promise<{ resolved: ResolvedResource[]; failures: FailedResource[] }> {
    const resolved: ResolvedResource[] = [];
    const failures: FailedResource[] = [];
    if (resources.length === 0) return { resolved, failures };
    mkdirSync(this.opts.rootDir, { recursive: true });
    for (const resource of resources) {
      if (resource.type === 'sticker') continue;
      let buf: Buffer;
      try {
        buf = await this.opts.download(messageId, resource.fileKey, resource.type === 'image' ? 'image' : 'file');
      } catch (error) {
        failures.push({ resource, reason: `下载失败: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if (buf.length > this.maxFileBytes) {
        failures.push({ resource, reason: `超过 ${Math.round(this.maxFileBytes / MB)}MB 上限 (${(buf.length / MB).toFixed(1)}MB)` });
        continue;
      }
      const hash = createHash('sha256').update(buf).digest('hex').slice(0, 32);
      const path = join(this.opts.rootDir, `${hash}${extFor(resource, buf)}`);
      if (!existsSync(path)) writeFileSync(path, buf);
      resolved.push({ resource, path });
    }
    this.evict(new Set(resolved.map((item) => item.path)));
    return { resolved, failures };
  }

  private evict(keep: Set<string>): void {
    const entries = readdirSync(this.opts.rootDir)
      .map((name) => join(this.opts.rootDir, name))
      .map((path) => ({ path, stat: statSync(path) }))
      .filter((entry) => entry.stat.isFile());
    let total = entries.reduce((sum, entry) => sum + entry.stat.size, 0);
    if (total <= this.maxTotalBytes) return;
    entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    for (const entry of entries) {
      if (total <= this.maxTotalBytes) break;
      if (keep.has(entry.path)) continue;
      unlinkSync(entry.path);
      total -= entry.stat.size;
    }
  }
}
