import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const GUIDE = join(ROOT, 'docs/guides/w13-e2e-readonly-checklist.md');
const RUNBOOK = join(ROOT, 'tests/wb-bot/E2E.md');

describe('W13 e2e readonly checklist guide', () => {
  it('guide file exists', () => {
    expect(existsSync(GUIDE)).toBe(true);
  });

  it('states stop-and-wait rule before any real-device write action', () => {
    const content = readFileSync(GUIDE, 'utf8');
    expect(content).toContain('任何真机写动作前，agent 必停报');
    expect(content).toContain('agent 不得代执行');
  });

  it('keeps the checklist scoped to manual residual items and references the original runbook', () => {
    const content = readFileSync(GUIDE, 'utf8');
    expect(content).toContain('L3 只保留');
    expect(content).toContain('tests/wb-bot/E2E.md');
    expect(existsSync(RUNBOOK)).toBe(true);
  });

  it('documents sanitized evidence rules and forbids real identifiers or secrets in commit material', () => {
    const content = readFileSync(GUIDE, 'utf8');
    expect(content).toContain('不得把真实 `open_id` / `chat_id` / `thread_id` / token / secret / 群截图直接进 commit');
    expect(content).toContain('只记录脱敏摘要');
    expect(content).toContain('禁止记录');
  });

  it('does not embed concrete real-looking credentials or ids', () => {
    const content = readFileSync(GUIDE, 'utf8');
    expect(content).not.toMatch(/ou_[0-9a-f]{16,}/i);
    expect(content).not.toMatch(/oc_[0-9a-z]{8,}/i);
    expect(content).not.toMatch(/tenant_access_token|app_secret=|sk-[A-Za-z0-9]/i);
  });
});
