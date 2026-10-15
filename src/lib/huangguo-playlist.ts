// 黄果清单只向这一个主机要。浏览器带着本站 Origin，或边缘 fetch 带上 CF-Worker，
// 源站都会回同一份短清单。这里只校验地址，真正取字节的连接在 huangguo-socket。

const HOST = 'yd-hls.hzjvlo.cn';
const DECOY_SEGMENT = '853acaba4721cceab535b64e6831f05a';

export interface HttpMessage {
  status: number;
  body: string;
  location: string;
}

export function huangguoUpstreamPath(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return '';
  }
  if (parsed.hostname.toLowerCase() !== HOST) return '';
  if (parsed.port && parsed.port !== '443') return '';
  const path = `${parsed.pathname}${parsed.search}`;
  if (!parsed.pathname.toLowerCase().endsWith('.m3u8')) return '';
  if (
    path.length > 4096 ||
    /[\s\\]/.test(path) ||
    path.includes(String.fromCharCode(0))
  ) {
    return '';
  }
  return path;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  const stop = Math.min(end, bytes.length);
  for (let index = start; index < stop; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

function headerEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

function headerValue(header: string, name: string): string {
  const match = new RegExp(`^${name}:\\s*([^\\r]*)`, 'im').exec(header);
  return match ? match[1].trim() : '';
}

function decodeChunked(bytes: Uint8Array, start: number): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let offset = start;
  while (offset < bytes.length) {
    let lineEnd = -1;
    for (let index = offset; index + 1 < bytes.length; index += 1) {
      if (bytes[index] === 13 && bytes[index + 1] === 10) {
        lineEnd = index;
        break;
      }
    }
    if (lineEnd < 0) return null;
    const sizeText = ascii(bytes, offset, lineEnd).split(';')[0].trim();
    if (!/^[0-9a-f]+$/i.test(sizeText)) return null;
    const size = parseInt(sizeText, 16);
    const dataStart = lineEnd + 2;
    if (size === 0) {
      const merged = new Uint8Array(
        parts.reduce((sum, part) => sum + part.length, 0)
      );
      let cursor = 0;
      parts.forEach((part) => {
        merged.set(part, cursor);
        cursor += part.length;
      });
      return merged;
    }
    if (dataStart + size + 2 > bytes.length) return null;
    parts.push(bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2;
  }
  return null;
}

// 有长度或分块才算收齐。没有这两样时要等对端关掉连接，不能在看到头就停。
export function httpMessageComplete(bytes: Uint8Array): boolean {
  const splitAt = headerEnd(bytes);
  if (splitAt < 0) return false;
  const header = ascii(bytes, 0, splitAt);
  const framed =
    /content-length:/i.test(header) ||
    /transfer-encoding:\s*chunked/i.test(header);
  if (!framed) return false;
  return readHttpMessage(bytes) !== null;
}

export function readHttpMessage(bytes: Uint8Array): HttpMessage | null {
  const splitAt = headerEnd(bytes);
  if (splitAt < 0) return null;
  const header = ascii(bytes, 0, splitAt);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(header)?.[1] || 0);
  if (!status) return null;
  const bodyStart = splitAt + 4;
  let bodyBytes: Uint8Array | null = null;
  if (/transfer-encoding:\s*chunked/i.test(header)) {
    bodyBytes = decodeChunked(bytes, bodyStart);
  } else {
    const lengthText = headerValue(header, 'content-length');
    if (lengthText) {
      const length = Number(lengthText);
      if (!Number.isInteger(length) || length < 0) return null;
      if (bodyStart + length > bytes.length) return null;
      bodyBytes = bytes.subarray(bodyStart, bodyStart + length);
    } else {
      bodyBytes = bytes.subarray(bodyStart);
    }
  }
  if (!bodyBytes) return null;
  return {
    status,
    body: ascii(bodyBytes, 0, bodyBytes.length),
    location: headerValue(header, 'location'),
  };
}

function rewriteUri(uri: string, baseHref: string): string {
  if (/^https?:\/\//i.test(uri)) return uri;
  try {
    return new URL(uri, baseHref).toString();
  } catch {
    return uri;
  }
}

// 清单改由本站返回后，相对地址会以本站为基准。按源站清单地址补成绝对地址，分片仍去源站。
export function preparePlaylist(body: string, baseHref: string): string {
  const text = body
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]*)"/g, (_full, uri: string) => {
          return `URI="${rewriteUri(uri, baseHref)}"`;
        });
      }
      return rewriteUri(trimmed, baseHref);
    })
    .join('\n')
    .trimStart();
  if (!text.startsWith('#EXTM3U')) return '';
  // 带错来源时源站固定回这一段。拿到它就不能当这一集的正片。
  if (text.includes(DECOY_SEGMENT)) return '';
  return text.endsWith('\n') ? text : `${text}\n`;
}
