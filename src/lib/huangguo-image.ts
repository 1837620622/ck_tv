import { decryptAes128Cbc } from '@/lib/aes-cbc';

const COVER_HOST = 'pic.wirqed.cn';

function codedBytes(encoded: string): Uint8Array {
  return Uint8Array.from(encoded.split('_').map((part) => Number(part)));
}

// 黄果封面密钥只留在服务端，接口只回解密后的图片。
const COVER_KEY = codedBytes(
  '102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48'
);
const COVER_IV = codedBytes(
  '57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49'
);

function startsWith(data: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, index) => data[index] === byte);
}

export function coverContentType(data: Uint8Array): string {
  if (startsWith(data, [0xff, 0xd8])) return 'image/jpeg';
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(data, [0x47, 0x49, 0x46])) return 'image/gif';
  if (
    startsWith(data, [0x52, 0x49, 0x46, 0x46]) &&
    data[8] === 0x57 &&
    data[9] === 0x45
  ) {
    return 'image/webp';
  }
  return '';
}

function trimImage(data: Uint8Array): Uint8Array | null {
  const type = coverContentType(data);
  if (!type || data.length < 16) return null;
  if (type === 'image/jpeg') {
    for (let index = data.length - 2; index > 1; index -= 1) {
      if (data[index] === 0xff && data[index + 1] === 0xd9) {
        return data.slice(0, index + 2);
      }
    }
    return null;
  }
  if (type === 'image/png') {
    for (let index = data.length - 8; index > 8; index -= 1) {
      if (
        data[index] === 0x49 &&
        data[index + 1] === 0x45 &&
        data[index + 2] === 0x4e &&
        data[index + 3] === 0x44
      ) {
        return data.slice(0, index + 8);
      }
    }
    return null;
  }
  if (type === 'image/gif') {
    for (let index = data.length - 1; index > 6; index -= 1) {
      if (data[index] === 0x3b) return data.slice(0, index + 1);
    }
    return null;
  }
  const size = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
  const end = size + 8;
  if (end > 16 && end <= data.length) return data.slice(0, end);
  return null;
}

export function decryptHuangguoCover(data: Uint8Array): Uint8Array | null {
  if (coverContentType(data)) return trimImage(data);
  if (data.length === 0 || data.length % 16 !== 0 || data.length > 8_000_000) {
    return null;
  }
  return trimImage(decryptAes128Cbc(data, COVER_KEY, COVER_IV));
}

export function allowedCoverUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' && parsed.hostname === COVER_HOST) {
      return parsed.toString();
    }
  } catch {
    return '';
  }
  return '';
}
