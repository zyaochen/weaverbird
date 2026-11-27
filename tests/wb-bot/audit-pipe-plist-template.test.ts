import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const TEMPLATE = join(ROOT, 'scripts/com.weaverbird.audit-pipe.plist.template');
const INSTALL_SCRIPT = join(ROOT, 'scripts/install-audit-pipe.sh');
const EXPECTED_AUDIT_PIPE_ENTRY = '__PROJECT_ROOT__/dist/packages/core/src/audit-pipe/audit-pipe-main.js';
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('audit-pipe supervision plist template', () => {
  it('template file exists', () => {
    expect(existsSync(TEMPLATE)).toBe(true);
  });

  it('contains both render placeholders', () => {
    const content = readFileSync(TEMPLATE, 'utf8');
    expect(content).toContain('__PROJECT_ROOT__');
    expect(content).toContain('__HOME__');
  });

  it('uses the exact audit-pipe launchd label', () => {
    const content = readFileSync(TEMPLATE, 'utf8');
    expect(content).toContain('<string>com.weaverbird.audit-pipe</string>');
  });

  it('references the audit-pipe production entry contract', () => {
    const content = readFileSync(TEMPLATE, 'utf8');
    expect(content).toContain(EXPECTED_AUDIT_PIPE_ENTRY);
  });

  it('sets launchd supervision keys', () => {
    const content = readFileSync(TEMPLATE, 'utf8');
    expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(content).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
    expect(content).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(content).toMatch(/<key>Crashed<\/key>\s*<true\/>/);
    expect(content).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  });

  it('writes logs into _audit-pipe and does not pass --interval', () => {
    const content = readFileSync(TEMPLATE, 'utf8');
    expect(content).toContain('__HOME__/.weaverbird/logs/_audit-pipe/audit-pipe.stdout.log');
    expect(content).toContain('__HOME__/.weaverbird/logs/_audit-pipe/audit-pipe.stderr.log');
    expect(content).not.toContain('--interval');
  });

  it('does not mention sudo / daemon / root in the template body', () => {
    const content = readFileSync(TEMPLATE, 'utf8');
    expect(content).not.toContain('sudo');
    expect(content).not.toContain('daemon');
    expect(content).not.toContain('root');
  });
});

describe('audit-pipe install script', () => {
  it('install script exists and passes bash -n', () => {
    expect(existsSync(INSTALL_SCRIPT)).toBe(true);
    expect(() => execSync(`bash -n ${INSTALL_SCRIPT}`)).not.toThrow();
  });

  it('contains launchctl bootstrap workflow without sudo', () => {
    const content = readFileSync(INSTALL_SCRIPT, 'utf8');
    expect(content).toContain('mkdir -p "$HOME/Library/LaunchAgents"');
    expect(content).toContain('mkdir -p "$LOG_DIR"');
    expect(content).toContain('plutil -lint');
    expect(content).toContain('launchctl bootstrap');
    expect(content).toContain('launchctl list | grep audit-pipe');
    expect(content).not.toContain('sudo');
  });

  it.skipIf(platform() !== 'darwin')('renders into a plist that passes plutil -lint with no leftover placeholders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-audit-plist-'));
    temps.push(dir);
    const rendered = join(dir, 'com.weaverbird.audit-pipe.plist');
    const template = readFileSync(TEMPLATE, 'utf8')
      .replace(/__PROJECT_ROOT__/g, ROOT)
      .replace(/__HOME__/g, process.env['HOME'] ?? '/tmp');
    writeFileSync(rendered, template);
    expect(template).not.toContain('__PROJECT_ROOT__');
    expect(template).not.toContain('__HOME__');
    expect(() => execSync(`plutil -lint ${rendered}`)).not.toThrow();
  });
});
