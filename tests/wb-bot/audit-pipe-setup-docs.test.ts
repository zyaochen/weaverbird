import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const GUIDE = join(ROOT, 'docs/guides/audit-pipe-setup.md');
const README = join(ROOT, 'README.md');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

describe('audit-pipe setup guide', () => {
  it('guide file exists', () => {
    expect(existsSync(GUIDE)).toBe(true);
  });

  it('contains launchctl bootstrap and bootout commands', () => {
    const content = readFileSync(GUIDE, 'utf8');
    expect(content).toContain('launchctl bootstrap');
    expect(content).toContain('launchctl bootout');
    expect(content).toContain('com.weaverbird.audit-pipe');
  });

  it('documents audit-mirror smoke verification and troubleshooting', () => {
    const content = readFileSync(GUIDE, 'utf8');
    expect(content).toContain('audit-mirror.ndjson');
    expect(content).toMatch(/Troubleshooting|排查|故障/i);
  });

  it('states startup order does not matter and one service handles all bots', () => {
    const content = readFileSync(GUIDE, 'utf8');
    expect(content).toMatch(/顺序无关|任意顺序|no.*order/i);
    expect(content).toMatch(/1 个 audit-pipe 服务所有 bot|一个 audit-pipe 服务所有 bot|1 个 audit-pipe 服务处理所有 bot/i);
  });

  it('does not instruct users to pass --interval <number>', () => {
    const content = readFileSync(GUIDE, 'utf8');
    expect(content).not.toMatch(/--interval\s+\d+/);
  });
});

describe('audit-pipe README / CHANGELOG patches', () => {
  it('README mentions audit-pipe supervision in relevant sections', () => {
    const content = readFileSync(README, 'utf8');
    expect(content).toContain('com.weaverbird.audit-pipe.plist.template');
    expect(content).toContain('logs/_audit-pipe');
    expect(content).toContain('audit-mirror.ndjson');
    expect(content).toContain('launchctl list | grep weaverbird');
    expect(content).toContain('audit-pipe launchctl supervision');
  });

  it('CHANGELOG contains W3.1-polish audit-pipe supervision entry', () => {
    const content = readFileSync(CHANGELOG, 'utf8');
    expect(content).toMatch(/W3\.1-polish/i);
    expect(content).toContain('com.weaverbird.audit-pipe.plist.template');
    expect(content).toContain('install-audit-pipe.sh');
    expect(content).toContain('audit-pipe-setup.md');
    expect(content).toMatch(/F-1|health/i);
  });
});
