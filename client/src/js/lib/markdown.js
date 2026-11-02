// 更新说明的极简解析：标题、列表、段落，行内支持 **粗体**、`代码`、[文字](https://链接)。
// 只产生数据结构，不产生 HTML，所以不会有注入风险。链接只允许 https。

const INLINE =
  /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https:\/\/[^\s)]+)\))/g;

export function parseInline(text) {
  const out = [];
  let last = 0;
  let match;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last)
      out.push({ type: 'text', text: text.slice(last, match.index) });
    if (match[1]) out.push({ type: 'strong', text: match[2] });
    else if (match[3]) out.push({ type: 'code', text: match[4] });
    else out.push({ type: 'link', text: match[6], href: match[7] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

export function parseNotes(source) {
  const blocks = [];
  const lines = String(source ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let list = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'p', inline: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'ul', items: list.map((item) => parseInline(item)) });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'h',
        level: Math.min(heading[1].length + 1, 4),
        inline: parseInline(heading[2]),
      });
    } else if (bullet) {
      flushParagraph();
      list = list || [];
      list.push(bullet[1]);
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
