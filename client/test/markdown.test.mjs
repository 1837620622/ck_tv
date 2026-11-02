import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseInline, parseNotes } from '../src/js/lib/markdown.js';

test('parseInline 识别粗体、行内代码和 https 链接', () => {
  assert.deepEqual(
    parseInline('普通 **粗** 与 `code` 见 [帮助](https://tv.chuankangkk.top)'),
    [
      { type: 'text', text: '普通 ' },
      { type: 'strong', text: '粗' },
      { type: 'text', text: ' 与 ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ' 见 ' },
      { type: 'link', text: '帮助', href: 'https://tv.chuankangkk.top' },
    ]
  );
});

test('parseInline 不把 HTML 或危险链接当成标签和链接', () => {
  assert.deepEqual(parseInline('<img src=x onerror=alert(1)>'), [
    { type: 'text', text: '<img src=x onerror=alert(1)>' },
  ]);
  assert.equal(
    parseInline('[点我](javascript:alert(1))').some(
      (part) => part.type === 'link'
    ),
    false
  );
  assert.equal(
    parseInline('[明文](http://example.org)').some(
      (part) => part.type === 'link'
    ),
    false
  );
});

test('parseNotes 把标题、列表和段落转成结构化数据', () => {
  const blocks = parseNotes(
    '## 本次更新\n- 第一条\n- 第二条 **加粗**\n\n段落一\n段落二'
  );
  assert.deepEqual(blocks, [
    { type: 'h', level: 3, inline: [{ type: 'text', text: '本次更新' }] },
    {
      type: 'ul',
      items: [
        [{ type: 'text', text: '第一条' }],
        [
          { type: 'text', text: '第二条 ' },
          { type: 'strong', text: '加粗' },
        ],
      ],
    },
    { type: 'p', inline: [{ type: 'text', text: '段落一 段落二' }] },
  ]);
});

test('parseNotes 处理空内容和 Windows 换行', () => {
  assert.deepEqual(parseNotes(''), []);
  assert.deepEqual(parseNotes(null), []);
  assert.deepEqual(parseNotes('# 标题\r\n'), [
    { type: 'h', level: 2, inline: [{ type: 'text', text: '标题' }] },
  ]);
});
