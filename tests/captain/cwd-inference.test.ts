import { describe, expect, it } from 'vitest';
import { inferCaptain } from '../../packages/core/src/captain/index.js';

const config = {
  version: 1,
  mapping: [
    {
      git_remote: 'github\\.com.*/weaverbird.*',
      cwd_prefix: '/Users/me/code/weaverbird',
      captain_id: 'default',
      home_group_id: 'oc_xxx',
    },
    {
      git_remote: 'github\\.com/myorg/other.*',
      cwd_prefix: '/Users/me/projects/other',
      captain_id: 'other-captain',
    },
    {
      git_remote: 'github\\.com/myorg/infra.*',
      cwd_prefix: '/Users/me/projects/infra',
      captain_id: 'infra-captain',
    },
    {
      git_remote: 'github\\.com.*/playbook.*',
      cwd_prefix: '/Users/me/code/playbook',
      captain_id: 'playbook',
    },
    {
      git_remote: 'github\\.com/myorg/ops.*',
      cwd_prefix: '/Users/me/projects/ops',
      captain_id: 'ops-captain',
    },
    {
      git_remote: 'github\\.com.*/tooling.*',
      cwd_prefix: '/Users/me/code/tooling',
      captain_id: 'tooling',
    },
    {
      git_remote: 'github\\.com/myorg/docs.*',
      cwd_prefix: '/Users/me/projects/docs',
      captain_id: 'docs-captain',
    },
  ],
};

describe('cwd-inference', () => {
  it('hits by git remote first', () => {
    const result = inferCaptain('/Users/me/code/weaverbird/apps/wb-bot', config, 'https://github.com/zyaochen/weaverbird.git');
    expect(result).toMatchObject({ outcome: 'hit', captain_id: 'default', matched_by: 'git_remote' });
  });

  it('falls back to cwd_prefix when git remote is unavailable', () => {
    const result = inferCaptain('/Users/me/code/weaverbird/docs', config, '');
    expect(result).toMatchObject({ outcome: 'hit', captain_id: 'default', matched_by: 'cwd_prefix' });
  });

  it('returns miss with candidates and suggestion', () => {
    const result = inferCaptain('/tmp/scratch', config, '');
    expect(result.outcome).toBe('miss');
    if (result.outcome === 'miss') {
      expect(result.candidates).toEqual(expect.arrayContaining(['default', 'other-captain']));
      expect(result.suggestion).toContain('wb captain use');
    }
  });

  it('handles non-git cwd without throwing', () => {
    const result = inferCaptain('/tmp', config, '');
    expect(result.outcome).toBe('miss');
  });

  it('meets >=90% hit rate on expanded owner-like cwd set', () => {
    const cases = [
      ['/Users/me/code/weaverbird', 'https://github.com/zyaochen/weaverbird.git'],
      ['/Users/me/code/weaverbird/apps/wb-bot', 'https://github.com/zyaochen/weaverbird.git'],
      ['/Users/me/code/weaverbird/packages/core', 'https://github.com/zyaochen/weaverbird.git'],
      ['/Users/me/code/weaverbird/docs', ''],
      ['/Users/me/projects/other/src', 'https://github.com/myorg/other.git'],
      ['/Users/me/projects/other/docs', ''],
      ['/Users/me/projects/infra/src', 'https://github.com/myorg/infra.git'],
      ['/Users/me/projects/ops/bin', 'https://github.com/myorg/ops.git'],
      ['/Users/me/projects/docs/site', ''],
      ['/tmp/scratch', ''],
    ] as const;
    const hits = cases.filter(([cwd, remote]) => inferCaptain(cwd, config, remote).outcome === 'hit').length;
    expect(hits).toBeGreaterThanOrEqual(9);
  });
});
