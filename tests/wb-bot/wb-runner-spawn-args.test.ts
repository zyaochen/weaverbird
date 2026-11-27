import { describe, expect, it } from 'vitest';
import { buildRunnerSpawnArgs } from '../../apps/wb-bot/src/feishu/wb-runner-spawner.js';

/**
 * Contract:
 * - `.js` path → cmd = node binary, args = [absPath, specJsonPath] (production / dist mode)
 * - `.ts` path → cmd = node binary, args = ['--import', <tsx loader>, absPath, specJsonPath] (dev mode)
 *
 * 背景: child 是 fresh Node 进程, 不继承父 tsx loader hook. `.ts` 必须显式 `--import tsx`.
 * W2.5-G.B 实施时 hard-code 用 node 直接跑 `.ts` → ERR_MODULE_NOT_FOUND, 真 spawn 才暴露
 * (post-W2.5 hotfix 2026-06-03).
 */
describe('buildRunnerSpawnArgs', () => {
  describe('.js path (build dist · production mode)', () => {
    it('uses raw node + abs path + spec', () => {
      const { cmd, args } = buildRunnerSpawnArgs('/repo/dist/packages/core/src/runner/wb-runner-main.js', '/run/spec.json');
      expect(cmd).toBe(process.execPath);
      expect(args).toEqual(['/repo/dist/packages/core/src/runner/wb-runner-main.js', '/run/spec.json']);
    });

    it('does not inject --import tsx for .js', () => {
      const { args } = buildRunnerSpawnArgs('/x/wb-runner-main.js', '/spec.json');
      expect(args).not.toContain('--import');
      expect(args).not.toContain('tsx');
    });

    it('resolves relative path to absolute', () => {
      const { args } = buildRunnerSpawnArgs('./relative/wb-runner-main.js', '/spec.json');
      expect(args[0]).toMatch(/^\//); // absolute
      expect(args[0]).toContain('wb-runner-main.js');
    });
  });

  describe('.ts path (src · dev mode)', () => {
    it('injects --import <tsx-loader> for .ts', () => {
      // 该测试机器上一定有 node_modules/tsx 装着, walk-up 应找到 ESM loader
      const { cmd, args } = buildRunnerSpawnArgs('/repo/packages/core/src/runner/wb-runner-main.ts', '/run/spec.json');
      expect(cmd).toBe(process.execPath);
      expect(args[0]).toBe('--import');
      // args[1] 是 tsx loader path (具体 path 因 walk-up 起点而异; fallback 是字面 'tsx')
      expect(args[1]).toBeDefined();
      expect(args[2]).toBe('/repo/packages/core/src/runner/wb-runner-main.ts');
      expect(args[3]).toBe('/run/spec.json');
    });

    it('walks up to find tsx ESM loader from runner path', () => {
      // 用真 repo 路径, 应当找到本地 node_modules/tsx
      const realPath = new URL('../../packages/core/src/runner/wb-runner-main.ts', import.meta.url).pathname;
      const { args } = buildRunnerSpawnArgs(realPath, '/spec.json');
      // 找到 loader 情况: args[1] 应当是 node_modules/tsx/dist/esm/index.mjs 这种 path (绝对路径含 'tsx')
      // 没找到 fallback 情况: args[1] === 'tsx' (依赖 PATH)
      expect(args[1]).toMatch(/tsx/);
    });
  });

  describe('contract invariants', () => {
    it('cmd always equals process.execPath (node binary), never tsx CLI', () => {
      expect(buildRunnerSpawnArgs('/x.js', '/s').cmd).toBe(process.execPath);
      expect(buildRunnerSpawnArgs('/x.ts', '/s').cmd).toBe(process.execPath);
    });

    it('specJsonPath is always last arg', () => {
      expect(buildRunnerSpawnArgs('/x.js', '/spec.json').args.at(-1)).toBe('/spec.json');
      expect(buildRunnerSpawnArgs('/x.ts', '/spec.json').args.at(-1)).toBe('/spec.json');
    });
  });
});
