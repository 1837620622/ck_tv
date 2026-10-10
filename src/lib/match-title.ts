import type { SearchResult } from '@/lib/types';

// 片库片名常多空格、标点和括号。季数和预告要留在身份里，不能靠前缀把别的片子认成这一部。

const NOISE =
  /解说|解读|速看|一口气看完|混剪|剪辑|预告片|预告|花絮|彩蛋|番外|片花|幕后|特辑|抢先看|电影解说/g;

const QUALITY =
  /(4k|hd|超清|高清|蓝光|国语|粤语|中字|英语|普通话|修复版|完整版|正片)$/i;

export function compactTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[：:·・,，.。!！?？'"“”‘’（）()【】[\]《》<>]/g, '');
}

function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}

// 采集站常把间隔符存成问号，或把 UTF-8 片名按 Latin1 解出来。展示和匹配都用修好的片名。
export function repairTitle(raw: string): string {
  let text = String(raw || '');
  if (/%[0-9a-f]{2}/i.test(text)) {
    try {
      const decoded = decodeURIComponent(text);
      if (hanCount(decoded) > hanCount(text)) text = decoded;
    } catch {
      // 半截百分号编码就保持原样
    }
  }
  text = Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) || 0;
      if (code < 32 && code !== 9 && code !== 10) return false;
      if (code >= 0x200b && code <= 0x200f) return false;
      if (code >= 0x202a && code <= 0x202e) return false;
      if (code >= 0x2060 && code <= 0x206f) return false;
      if (code === 0xfeff || code === 0x00ad || code === 0xfffd) return false;
      return true;
    })
    .join('')
    .replace(/锟斤拷/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => {
      const value = Number(code);
      return value > 31 && value < 0x110000 ? String.fromCodePoint(value) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const value = parseInt(code, 16);
      return value > 31 && value < 0x110000 ? String.fromCodePoint(value) : '';
    });
  const latin = (text.match(/[\u00c0-\u00ff]/g) || []).length;
  if (hanCount(text) === 0 && latin >= 4) {
    const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
    try {
      const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (hanCount(fixed) > 0) text = fixed;
    } catch {
      // 不是 UTF-8 被错解成 Latin1
    }
  }
  // 只去掉夹在汉字中间的问号。片名末尾的问号留给真正的疑问句。
  text = text.replace(/([\u4e00-\u9fff])[?？]+(?=[\u4e00-\u9fff])/g, '$1');
  return text.replace(/\s+/g, ' ').trim();
}

function chineseNumber(token: string): string {
  if (/^\d+$/.test(token)) return String(Number(token));
  const digit: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (token === '十') return '10';
  if (token.startsWith('十')) return String(10 + (digit[token[1]] || 0));
  if (token.endsWith('十')) return String((digit[token[0]] || 1) * 10);
  const ten = token.indexOf('十');
  if (ten > 0) {
    return String((digit[token[0]] || 0) * 10 + (digit[token[ten + 1]] || 0));
  }
  if (token.length === 1 && digit[token] !== undefined) {
    return String(digit[token]);
  }
  return token;
}

function romanSeason(token: string): string {
  const map: Record<string, string> = {
    ii: '2',
    iii: '3',
    iv: '4',
    ⅱ: '2',
    ⅲ: '3',
    ⅳ: '4',
  };
  return map[token] || '';
}

export type TitlePart = {
  base: string;
  season: string;
  trailer: boolean;
};

export function titleParts(raw: string): TitlePart {
  const compact = compactTitle(repairTitle(raw));
  const trailer = /解说|预告|花絮|番外|片花|速看|混剪|剪辑|特辑/.test(compact);
  let text = compact.replace(NOISE, '');
  let season = '';
  const marked = text.match(/第([0-9一二三四五六七八九十百两]+)[季部期]/);
  if (marked) {
    season = chineseNumber(marked[1]);
    text = text.replace(marked[0], '');
  }
  if (!season) {
    const tail = text.match(/([0-9]{1,2}|ii|iii|iv|ⅱ|ⅲ|ⅳ)$/);
    const rest = tail ? text.length - tail[0].length : 0;
    const roman = tail ? romanSeason(tail[1]) : '';
    const arabic = tail && !roman && /^[0-9]{1,2}$/.test(tail[1]);
    if (tail && rest >= 2 && (roman || arabic)) {
      season = roman || String(Number(tail[1]));
      text = text.slice(0, -tail[0].length);
    }
  }
  text = text.replace(QUALITY, '');
  const yearTail = text.match(/(19|20)\d{2}$/);
  if (yearTail && text.length - yearTail[0].length >= 2) {
    text = text.slice(0, -yearTail[0].length);
  }
  return { base: text || compact, season, trailer };
}

export function titlesMatch(resultTitle: string, wanted: string): boolean {
  const result = titleParts(resultTitle);
  const query = titleParts(wanted);
  if (!result.base || !query.base) return false;
  if (result.base !== query.base) return false;
  if (result.season !== query.season) return false;
  if (result.trailer !== query.trailer) return false;
  return true;
}

function episodeCount(item: SearchResult): number {
  if (item.episodes?.length) return item.episodes.length;
  return item.episode_count || 0;
}

// 年份和类型对不上就留空，不用另一部片子顶上。
export function pickPlayable(
  results: SearchResult[],
  title: string,
  year: string,
  searchType: string
): SearchResult[] {
  const titled = results.filter(
    (item) => episodeCount(item) > 0 && titlesMatch(item.title, title)
  );
  const yearKnown = /^\d{4}$/.test(year);
  const pool = yearKnown
    ? titled.filter(
        (item) => !item.year || item.year === 'unknown' || item.year === year
      )
    : titled;
  if (searchType !== 'movie' && searchType !== 'tv') return pool;
  return pool.filter((item) => {
    const count = episodeCount(item);
    if (searchType === 'movie') return count > 0 && count <= 3;
    return count > 1;
  });
}

export function workKey(title: string, year: string, episodes: number): string {
  const part = titleParts(title);
  // 预告只是同一条片子的不同写法，不按年份再拆开。
  const y = part.trailer ? '' : /^\d{4}$/.test(year || '') ? year : '';
  const kind = episodes > 1 ? 'tv' : 'movie';
  return `${part.base}|${part.season}|${part.trailer ? '1' : '0'}|${kind}|${y}`;
}

export function titleRank(title: string, query: string): number {
  const compact = compactTitle(title);
  const wanted = compactTitle(query);
  let score = title.length;
  if (wanted && compact === wanted) score -= 40;
  if (/[?？]/.test(title)) score += 8;
  if (!titleParts(title).base) score += 20;
  return score;
}
