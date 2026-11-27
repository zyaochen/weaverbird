import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareApprovalHookFiles } from '../../apps/wb-bot/src/approval-gate/hook-files.js';

const roots: string[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-approval-hooks-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('approval hook files', () => {
  it('creates isolated Claude and Codex hook configuration', () => {
    const root = mkRoot();
    const files = prepareApprovalHookFiles({
      dataDir: root,
      hookScriptPath: join(process.cwd(), 'apps/wb-bot/src/approval-gate/hook-main.ts'),
    });

    const claudeSettings = JSON.parse(readFileSync(files.claudeSettingsPath, 'utf8')) as { hooks: Record<string, unknown> };
    expect(claudeSettings.hooks).toHaveProperty('PreToolUse');
    expect(readFileSync(join(files.codexHome, 'config.toml'), 'utf8')).toContain('[[hooks.PreToolUse]]');
    expect(readFileSync(files.wrapperScriptPath, 'utf8')).toContain('approval-gate');
  });

  it('mirrors existing CODEX_HOME config before appending approval hook config', () => {
    const root = mkRoot();
    const sourceCodexHome = mkRoot();
    mkdirSync(join(sourceCodexHome, 'prompts'), { recursive: true });
    writeFileSync(join(sourceCodexHome, 'prompts', 'review.md'), '# review\n');
    writeFileSync(join(sourceCodexHome, 'config.toml'), [
      'model = "gpt-5.4"',
      '',
      '[model_providers.llmgw]',
      'name = "OpenAI using LLM proxy"',
      '',
      '[features]',
      'hooks = false',
      'codex_hooks = true',
      '',
    ].join('\n'));

    const previousCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = sourceCodexHome;
    try {
      const files = prepareApprovalHookFiles({
        dataDir: root,
        hookScriptPath: join(process.cwd(), 'apps/wb-bot/src/approval-gate/hook-main.ts'),
      });

      const config = readFileSync(join(files.codexHome, 'config.toml'), 'utf8');
      expect(config).toContain('[model_providers.llmgw]');
      expect(config).toContain('name = "OpenAI using LLM proxy"');
      expect(config).toContain('hooks = true');
      expect(config).not.toContain('codex_hooks = true');
      expect(config).toContain('[[hooks.PreToolUse]]');
      expect(existsSync(join(files.codexHome, 'prompts'))).toBe(true);
      expect(readFileSync(join(files.codexHome, 'prompts', 'review.md'), 'utf8')).toBe('# review\n');
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env['CODEX_HOME'];
      } else {
        process.env['CODEX_HOME'] = previousCodexHome;
      }
    }
  });

  it('drops source hook layers from mirrored Codex home before adding approval hook', () => {
    const root = mkRoot();
    const sourceCodexHome = mkRoot();
    writeFileSync(join(sourceCodexHome, 'hooks.json'), '{"hooks":true}\n');
    writeFileSync(join(sourceCodexHome, 'config.toml'), [
      'model = "gpt-5.4"',
      '',
      '[hooks.state."/Users/test/.codex/hooks.json:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:test"',
      '',
      '[[hooks.Stop]]',
      'matcher = "*"',
      '',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "echo old"',
      '',
      '[features]',
      'hooks = true',
      'codex_hooks = true',
      '',
    ].join('\n'));

    const previousCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = sourceCodexHome;
    try {
      const files = prepareApprovalHookFiles({
        dataDir: root,
        hookScriptPath: join(process.cwd(), 'apps/wb-bot/src/approval-gate/hook-main.ts'),
      });

      const config = readFileSync(join(files.codexHome, 'config.toml'), 'utf8');
      expect(existsSync(join(files.codexHome, 'hooks.json'))).toBe(false);
      expect(config).toContain('model = "gpt-5.4"');
      expect(config).toContain('[features]');
      expect(config).toContain('hooks = true');
      expect(config).not.toContain('[hooks.state.');
      expect(config).not.toContain('[[hooks.Stop]]');
      expect(config).not.toContain('command = "echo old"');
      expect(config).not.toContain('codex_hooks = true');
      expect(config).toContain('[[hooks.PreToolUse]]');
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env['CODEX_HOME'];
      } else {
        process.env['CODEX_HOME'] = previousCodexHome;
      }
    }
  });
});
