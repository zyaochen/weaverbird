import { describe, expect, it } from 'vitest';
import { stripLarkMentionPlaceholders } from '../../apps/wb-bot/src/feishu/event-handler.js';

/**
 * stripLarkMentionPlaceholders 设计契约:
 * - 只 strip 飞书 mention 占位符 (`@_user_<n>` / `@_all`)
 * - **不** trim, **不** collapse 空白 (保留 trailing whitespace 让 caller 后续 regex 解析)
 * - caller 用 `.trim()` 判 empty / `.trimStart()` 处理 leading space
 */
describe('stripLarkMentionPlaceholders', () => {
  describe('empty-prompt scenarios (用户只 @bot 没附文字)', () => {
    it('strips sole @_user_<n> placeholder to empty', () => {
      // 实测 2026-06-03: 用户只 `@bot` 不附文字, lark content: {"text":"@_user_1"}
      expect(stripLarkMentionPlaceholders('@_user_1')).toBe('');
    });

    it('strips @_user_<n> with any digit count', () => {
      expect(stripLarkMentionPlaceholders('@_user_0')).toBe('');
      expect(stripLarkMentionPlaceholders('@_user_99')).toBe('');
      expect(stripLarkMentionPlaceholders('@_user_12345')).toBe('');
    });

    it('strips @_all placeholder to empty', () => {
      expect(stripLarkMentionPlaceholders('@_all')).toBe('');
    });

    it('strips multiple consecutive placeholders (leaves only joining whitespace, .trim() empty)', () => {
      expect(stripLarkMentionPlaceholders('@_user_1 @_user_2').trim()).toBe('');
      expect(stripLarkMentionPlaceholders('  @_user_1   @_all  ').trim()).toBe('');
    });

    it('returns empty for empty input', () => {
      expect(stripLarkMentionPlaceholders('')).toBe('');
    });

    it('whitespace-only input survives raw (caller decides via .trim())', () => {
      // helper 不 trim, caller 自己 `.trim() === ''` 判 empty
      expect(stripLarkMentionPlaceholders('   ').trim()).toBe('');
    });
  });

  describe('mention + content scenarios (用户 @bot + 文字)', () => {
    it('strips leading @_user_<n>, leaves leading whitespace + content', () => {
      // helper raw output, caller 通过 trimStart 处理 leading whitespace
      expect(stripLarkMentionPlaceholders('@_user_1 hello')).toBe(' hello');
    });

    it('strips trailing @_user_<n>, leaves content + trailing whitespace', () => {
      expect(stripLarkMentionPlaceholders('hello @_user_1')).toBe('hello ');
    });

    it('strips multiple mentions, leaves content + interior whitespace', () => {
      expect(stripLarkMentionPlaceholders('@_user_1 帮我看一下 @_user_2 的代码')).toBe(' 帮我看一下  的代码');
    });

    it('strips @_all + content (preserves leading whitespace)', () => {
      expect(stripLarkMentionPlaceholders('@_all 大家好')).toBe(' 大家好');
    });

    it('preserves slash commands as prompt content (caller routes via trimmedText)', () => {
      expect(stripLarkMentionPlaceholders('@_user_1 /stop')).toBe(' /stop');
      expect(stripLarkMentionPlaceholders('@_user_1 /agent claude-code hello')).toBe(' /agent claude-code hello');
    });

    it('preserves trailing whitespace (important for AGENT_PREFIX empty-body detection)', () => {
      // `/agent <id>    ` (尾部 spaces) 经过 helper 应当保留, 让 AGENT_PREFIX 的
      // `\s+(.+)$` 能 match 出空白 promptBody → friendly error "请在 /agent 后面..."
      expect(stripLarkMentionPlaceholders('/agent claude-code    ')).toBe('/agent claude-code    ');
      expect(stripLarkMentionPlaceholders('@_user_1 /agent claude-code    ')).toBe(' /agent claude-code    ');
    });

    it('preserves @ that is not a lark mention placeholder shape', () => {
      // 只 strip `@_user_<n>` 和 `@_all`, 不 strip 普通 @
      expect(stripLarkMentionPlaceholders('@bot 联系 user@example.com')).toBe('@bot 联系 user@example.com');
      expect(stripLarkMentionPlaceholders('@_user_1 联系 user@example.com')).toBe(' 联系 user@example.com');
    });

    it('preserves @_xxx that does NOT match @_user_<n> / @_all', () => {
      expect(stripLarkMentionPlaceholders('@_user_1 检查 @_admin')).toBe(' 检查 @_admin');
    });
  });

  describe('preserves multi-line / unicode / special chars', () => {
    it('keeps newlines (helper 不 collapse)', () => {
      expect(stripLarkMentionPlaceholders('@_user_1 first line\nsecond line')).toBe(' first line\nsecond line');
    });

    it('preserves CJK characters', () => {
      expect(stripLarkMentionPlaceholders('@_user_1 帮我分析这段代码的性能问题')).toBe(' 帮我分析这段代码的性能问题');
    });

    it('preserves backticks / code fences', () => {
      expect(stripLarkMentionPlaceholders('@_user_1 看 `foo.ts` 第 10 行')).toBe(' 看 `foo.ts` 第 10 行');
    });
  });

  describe('handleMessage downstream contract (post-trim/trimStart visual)', () => {
    it('strip + trim() === content for typical user message', () => {
      expect(stripLarkMentionPlaceholders('@_user_1 hello').trim()).toBe('hello');
      expect(stripLarkMentionPlaceholders('hello @_user_1').trim()).toBe('hello');
      expect(stripLarkMentionPlaceholders('@_all 大家好').trim()).toBe('大家好');
    });

    it('strip + trim() === "" for empty / mention-only input', () => {
      expect(stripLarkMentionPlaceholders('@_user_1').trim()).toBe('');
      expect(stripLarkMentionPlaceholders('@_user_1 @_user_2').trim()).toBe('');
      expect(stripLarkMentionPlaceholders('').trim()).toBe('');
      expect(stripLarkMentionPlaceholders('   ').trim()).toBe('');
    });
  });
});
