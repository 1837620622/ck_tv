// 清单层的插播过滤。只处理清单里能判断出来的广告：
//   1. #EXT-X-CUE-OUT … #EXT-X-CUE-IN，HLS 标准的插播标记（SCTE-35 常见的落地形式）
//   2. 两个 #EXT-X-DISCONTINUITY 之间很短的一段（部分片源用不连续标记框住插播）
//   3. 两个 #EXT-X-DISCONTINUITY 之间的一段，且片段全部来自正片以外的域名（广告常由独立服务器发出）
// 画面里烧进去的水印、既没有标记也和正片同域名的插播，清单层看不见，过滤不了。
//
// 删段时只保留一个 #EXT-X-DISCONTINUITY 作为拼接点，让解码器重新对时，
// 而不是把两个标记都删掉，那样后面的时间戳会直接接上去，容易卡顿或音画错位。

export interface AdFilterResult {
  text: string;
  removedSegments: number;
  removedSeconds: number;
}

// 单次插播最长允许删掉的时长。超过这个长度的基本是正片分段，不当广告处理。
const MAX_CUE_SECONDS = 180;
const MAX_FENCED_SECONDS = 15;
// 外站插播：单段最长 60 秒，所有外站插播加起来不超过整集时长的 10%。
// 正片中途切到另一个 CDN 时也会长得像插播，所以判得越严越好：超出预算的保留，宁可漏删也不误删正片。
const MAX_FOREIGN_SECONDS = 60;
const MAX_FOREIGN_RATIO = 0.1;

const isDisc = (line: string) => line.trim() === '#EXT-X-DISCONTINUITY';
const isCueIn = (line: string) => line.trim() === '#EXT-X-CUE-IN';
const isCueOut = (line: string) => /^#EXT-X-CUE-OUT(?::|$)/.test(line.trim());
const isSegmentUrl = (line: string) => {
  const t = line.trim();
  return t.length > 0 && !t.startsWith('#');
};

function extinfSeconds(line: string): number {
  const match = /^#EXTINF:([\d.]+)/.exec(line.trim());
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : 0;
}

// #EXT-X-CUE-OUT:DURATION=30 或 #EXT-X-CUE-OUT:30
function cueOutDuration(line: string): number {
  const attr = /DURATION=([\d.]+)/.exec(line);
  if (attr) return Number(attr[1]) || 0;
  const bare = /^#EXT-X-CUE-OUT:([\d.]+)$/.exec(line.trim());
  return bare ? Number(bare[1]) || 0 : 0;
}

// AES-128 且没有写 IV 时，解密用的 IV 取自片段的 media sequence 号（RFC 8216）。
// 删掉中间的片段会让后面每个片段的序号前移，IV 对不上，解出来就是乱码。这种清单原样返回。
function hasImplicitIv(lines: string[]): boolean {
  return lines.some((line) => {
    const tag = line.trim();
    if (!tag.startsWith('#EXT-X-KEY:')) return false;
    const method = /METHOD=([A-Z0-9-]+)/.exec(tag)?.[1];
    if (!method || method === 'NONE') return false;
    return !/IV=/.test(tag);
  });
}

interface SegmentInfo {
  seconds: number;
  host: string | null;
}

// 片段所在的域名。相对地址按清单地址解析，解析不了返回 null
function hostOf(url: string, baseUrl?: string): string | null {
  try {
    return new URL(url.trim(), baseUrl).host || null;
  } catch {
    return null;
  }
}

// 逐个片段取时长和域名，时长取它前面最近的 #EXTINF
function segmentInfos(lines: string[], baseUrl?: string): SegmentInfo[] {
  const infos: SegmentInfo[] = [];
  let seconds = 0;
  lines.forEach((line) => {
    const t = line.trim();
    if (t.startsWith('#EXTINF:')) {
      seconds = extinfSeconds(t);
    } else if (isSegmentUrl(line)) {
      infos.push({ seconds, host: hostOf(t, baseUrl) });
      seconds = 0;
    }
  });
  return infos;
}

// 正片域名：按时长算，占得最多的那个。只要有一个片段判不出域名，就返回 null，外站规则整体停用
function mainHostOf(infos: SegmentInfo[]): string | null {
  if (infos.length === 0 || infos.some((info) => info.host === null)) {
    return null;
  }
  const totals = new Map<string, number>();
  infos.forEach((info) => {
    const host = info.host as string;
    totals.set(host, (totals.get(host) || 0) + info.seconds);
  });
  const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  return ranked.length > 0 && ranked[0][1] > 0 ? ranked[0][0] : null;
}

// baseUrl 是清单自身的地址，用来解析相对片段地址；不传时外站规则不生效
export function filterAdBreaks(
  playlist: string,
  baseUrl?: string
): AdFilterResult {
  const original = playlist;
  const lines = playlist.split(/\r?\n/);
  if (hasImplicitIv(lines)) {
    return { text: original, removedSegments: 0, removedSeconds: 0 };
  }

  const infos = segmentInfos(lines, baseUrl);
  const totalSegments = infos.length;
  const totalSeconds = infos.reduce((sum, info) => sum + info.seconds, 0);
  const mainHost = mainHostOf(infos);
  const foreignBudget = totalSeconds * MAX_FOREIGN_RATIO;
  let foreignSeconds = 0;

  const out: string[] = [];
  let removedSegments = 0;
  let removedSeconds = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 1) CUE-OUT … CUE-IN
    if (isCueOut(line)) {
      let j = i + 1;
      let segments = 0;
      let seconds = 0;
      let closed = false;
      while (j < lines.length) {
        const row = lines[j];
        if (isCueIn(row)) {
          closed = true;
          break;
        }
        if (row.trim().startsWith('#EXTINF:')) seconds += extinfSeconds(row);
        if (isSegmentUrl(row)) segments += 1;
        j += 1;
      }
      const declared = cueOutDuration(line);
      const span = Math.max(seconds, declared);
      if (closed && segments > 0 && span > 0 && span <= MAX_CUE_SECONDS) {
        removedSegments += segments;
        removedSeconds += seconds;
        // 拼接点：只留一个不连续标记
        out.push('#EXT-X-DISCONTINUITY');
        i = j + 1;
        continue;
      }
      out.push(line);
      i += 1;
      continue;
    }

    // 2) DISCONTINUITY … DISCONTINUITY 之间的一段
    if (isDisc(line)) {
      let j = i + 1;
      let segments = 0;
      let seconds = 0;
      let sawInfo = false;
      // 这一段是否全部来自正片以外的域名
      let allForeign = mainHost !== null;
      while (j < lines.length && !isDisc(lines[j])) {
        if (lines[j].trim().startsWith('#EXTINF:')) {
          seconds += extinfSeconds(lines[j]);
          sawInfo = true;
        }
        if (isSegmentUrl(lines[j])) {
          segments += 1;
          const host = hostOf(lines[j], baseUrl);
          if (host === null || host === mainHost) allForeign = false;
        }
        j += 1;
      }
      const closed = j < lines.length && isDisc(lines[j]);
      const shortBlock = seconds > 0 && seconds <= MAX_FENCED_SECONDS;
      const foreignBlock =
        allForeign &&
        seconds > 0 &&
        seconds <= MAX_FOREIGN_SECONDS &&
        foreignSeconds + seconds <= foreignBudget;
      if (closed && sawInfo && segments > 0 && (shortBlock || foreignBlock)) {
        removedSegments += segments;
        removedSeconds += seconds;
        if (!shortBlock) foreignSeconds += seconds;
        // 跳到收尾的那个不连续标记，由它充当唯一的拼接点
        i = j;
        continue;
      }
      out.push(line);
      i += 1;
      continue;
    }

    out.push(line);
    i += 1;
  }

  // 整理：只保留两段正片之间的不连续标记，相邻的重复标记合并成一个
  const firstSeg = out.findIndex(isSegmentUrl);
  let lastSeg = -1;
  out.forEach((line, index) => {
    if (isSegmentUrl(line)) lastSeg = index;
  });
  const tidy: string[] = [];
  out.forEach((line, index) => {
    if (isDisc(line)) {
      if (firstSeg < 0 || index < firstSeg || index > lastSeg) return;
      if (tidy.length > 0 && isDisc(tidy[tidy.length - 1])) return;
    }
    tidy.push(line);
  });
  const hasSegmentLeft = tidy.some(isSegmentUrl);

  // 安全阀：删掉超过一半分段，或者删完一段不剩，说明判断有误，原样返回
  if (
    removedSegments === 0 ||
    !hasSegmentLeft ||
    removedSegments * 2 > totalSegments
  ) {
    return { text: original, removedSegments: 0, removedSeconds: 0 };
  }

  return {
    text: tidy.join('\n'),
    removedSegments,
    removedSeconds,
  };
}
