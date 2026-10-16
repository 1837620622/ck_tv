import { gateDenial } from '@/lib/region-gate';
import { isAdultSource } from '@/lib/yellow';

// 播放记录和收藏的 key 形如 source+id。成人源和黄果的条目只给通过门控的访客看、写、删。
export function isGatedKey(key: string): boolean {
  return isAdultSource({ key: key.split('+')[0] });
}

// 当前访客没通过门控（地区不符或 cookie 无效）时返回 true。
export async function gateClosedFor(request: Request): Promise<boolean> {
  return (await gateDenial(request)) !== null;
}
