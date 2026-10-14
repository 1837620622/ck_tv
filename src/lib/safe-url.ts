// 服务端出站请求只允许公网 http(s)。挡住内网、回环、云元数据地址，
// 以及带账号密码的 URL，防止接口被拿来当任意网页代理或探测内网。

import { nodeResolve } from '@/lib/dns-node';

function privateIPv4(parts: number[]): boolean {
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const a = parts[0];
  const b = parts[1];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function expandIPv6(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): string[] | null => {
    if (!side) return [];
    const out: string[] = [];
    for (const bit of side.split(':')) {
      if (bit.includes('.')) {
        const nums = bit.split('.').map((part) => Number(part));
        if (
          nums.length !== 4 ||
          nums.some((part) => !Number.isInteger(part) || part > 255)
        ) {
          return null;
        }
        out.push(((nums[0] << 8) | nums[1]).toString(16));
        out.push(((nums[2] << 8) | nums[3]).toString(16));
        continue;
      }
      if (!/^[0-9a-f]{0,4}$/i.test(bit)) return null;
      out.push(bit || '0');
    }
    return out;
  };

  const left = parseSide(halves[0]);
  if (!left) return null;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    return left.map((part) => parseInt(part, 16));
  }
  const right = parseSide(halves[1]);
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill('0'), ...right].map((part) =>
    parseInt(part, 16)
  );
}

function ipv4FromPair(hi: number, lo: number): number[] {
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

function blockedIPv6(host: string): boolean {
  const nums = expandIPv6(host);
  if (!nums || nums.some((part) => Number.isNaN(part) || part > 0xffff)) {
    return true;
  }
  const loopback =
    nums.every((part) => part === 0) ||
    (nums.slice(0, 7).every((part) => part === 0) && nums[7] === 1);
  if (loopback) return true;
  const head = nums[0];
  // fe80::/10、fec0::/10、ff00::/8、fc00::/7
  if (head >= 0xfe80 && head <= 0xfeff) return true;
  if (head >= 0xff00) return true;
  if (head >= 0xfc00 && head <= 0xfdff) return true;

  let embedded: number[] | null = null;
  if (nums.slice(0, 5).every((part) => part === 0) && nums[5] === 0xffff) {
    embedded = ipv4FromPair(nums[6], nums[7]);
  } else if (nums.slice(0, 6).every((part) => part === 0)) {
    embedded = ipv4FromPair(nums[6], nums[7]);
  } else if (head === 0x2002) {
    embedded = ipv4FromPair(nums[1], nums[2]);
  } else if (
    head === 0x64 &&
    nums[1] === 0xff9b &&
    nums.slice(2, 6).every((part) => part === 0)
  ) {
    embedded = ipv4FromPair(nums[6], nums[7]);
  }
  return embedded ? privateIPv4(embedded) : false;
}

// 主机名里嵌着 IPv4 地址时也要判断，例如 127.0.0.1.nip.io、10-0-0-1.sslip.io。
// 这类域名解析出来就是内网地址，只看字面 IP 挡不住。
// 注意：这只能挡住地址写在域名里的情况；普通域名解析到内网 IP 的情况由 fetchPublic 在 Docker 下查解析结果来挡。
// 逐个位置试连续四段数字，不用正则的非重叠匹配：那样 1.127.0.0.1.nip.io 会被前面的 1.127.0.0 吃掉，
// 真正的 127.0.0.1 就漏了。前面有公网的段（如 1.127.0.0.1.nip.io）同样要拦住。
function embeddedIPv4Blocked(host: string): boolean {
  const labels = host.split(/[.-]/);
  for (let start = 0; start + 3 < labels.length; start += 1) {
    const four = labels.slice(start, start + 4);
    if (!four.every((label) => /^\d{1,3}$/.test(label))) continue;
    const parts = four.map((label) => Number(label));
    if (parts.every((part) => part <= 255) && privateIPv4(parts)) return true;
  }
  return false;
}

export function publicHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return null;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map((part) => Number(part));
    if (privateIPv4(parts)) return null;
  }
  if (host.includes(':') && blockedIPv6(host)) return null;
  if (embeddedIPv4Blocked(host)) return null;
  // 单段主机名（如 Docker 服务名 minio）只能指向内网，公网域名一定带点
  if (!host.includes(':') && !host.includes('.')) return null;
  return url;
}

// 地址本身是否是公网地址。IPv4 与 IPv6 都按内网、回环、链路本地等网段判断。
export function publicAddress(address: string): boolean {
  if (address.includes(':')) return !blockedIPv6(address);
  return !privateIPv4(address.split('.').map((part) => Number(part)));
}

export type HostResolver = (host: string) => Promise<string[]>;

// 域名解析出的每个地址都必须是公网地址；解析失败或没有结果也拒绝。
// 查询与连接之间解析结果被换掉（DNS 重绑定）这一步，这里防不住，需要连接层固定地址。
async function hostResolvesPublic(
  url: URL,
  resolve: HostResolver
): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(publicAddress);
}

// 发起出站请求并逐跳校验重定向目标，最多跟 3 跳。
// 每一跳都要过 publicHttpUrl；Docker（Node 运行时）下还要检查域名的解析结果，
// 否则 169.254.169.254、10.x 这类内网地址只要藏在域名后面就能连上。
// 跳到非公网地址、Location 无效或超过跳数时返回 null。
export async function fetchPublic(
  start: URL,
  init: RequestInit,
  resolve: HostResolver | null = process.env.DOCKER_ENV === 'true'
    ? nodeResolve
    : null
): Promise<Response | null> {
  let current = start;
  for (let hop = 0; hop < 3; hop += 1) {
    if (resolve && !(await hostResolvesPublic(current, resolve))) return null;
    const response = await fetch(current.toString(), {
      ...init,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      let next: URL | null = null;
      try {
        next = publicHttpUrl(new URL(location, current).toString());
      } catch {
        next = null;
      }
      if (!next) return null;
      current = next;
      continue;
    }
    return response;
  }
  return null;
}
