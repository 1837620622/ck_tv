// 清单层的插播过滤。只能处理清单里“标出来”的广告：
//   1. #EXT-X-CUE-OUT … #EXT-X-CUE-IN，HLS 标准的插播标记（SCTE-35 常见的落地形式）
//   2. 两个 #EXT-X-DISCONTINUITY 之间很短的一段（部分片源用不连续标记框住插播）
// 画面里直接压着的广告、没有任何标记的插播，清单层看不见，过滤不了。
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

export function filterAdBreaks(playlist: string): AdFilterResult {
  const original = playlist;
  const lines = playlist.split(/\r?\n/);
  const totalSegments = lines.filter(isSegmentUrl).length;
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

    // 2) DISCONTINUITY … DISCONTINUITY 之间的短段
    if (isDisc(line)) {
      let j = i + 1;
      let segments = 0;
      let seconds = 0;
      let sawInfo = false;
      while (j < lines.length && !isDisc(lines[j])) {
        if (lines[j].trim().startsWith('#EXTINF:')) {
          seconds += extinfSeconds(lines[j]);
          sawInfo = true;
        }
        if (isSegmentUrl(lines[j])) segments += 1;
        j += 1;
      }
      const closed = j < lines.length && isDisc(lines[j]);
      if (
        closed &&
        sawInfo &&
        segments > 0 &&
        seconds > 0 &&
        seconds <= MAX_FENCED_SECONDS
      ) {
        removedSegments += segments;
        removedSeconds += seconds;
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
