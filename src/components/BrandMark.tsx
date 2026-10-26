import { useId } from 'react';

// 站点图标：深色圆角底，翠绿渐变的 C 形光环包住播放键，缺口处一个「在播」的小点。
// 和 public/icon.svg、design/ck-mark.svg 是同一张图。渐变 id 每个实例独立：
// 侧栏在手机上是隐藏的，如果共用 id，手机顶栏的图标会引用到隐藏元素里的渐变而画不出来。
export default function BrandMark({ size = 28 }: { size?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const bg = `ckbg${uid}`;
  const glow = `ckglow${uid}`;
  const ring = `ckring${uid}`;
  const play = `ckplay${uid}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 512 512'
      aria-hidden='true'
      className='shrink-0'
    >
      <defs>
        <linearGradient id={bg} x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0' stopColor='#18231F' />
          <stop offset='1' stopColor='#060908' />
        </linearGradient>
        <radialGradient id={glow} cx='0.42' cy='0.4' r='0.62'>
          <stop offset='0' stopColor='#22C55E' stopOpacity='0.3' />
          <stop offset='1' stopColor='#22C55E' stopOpacity='0' />
        </radialGradient>
        <linearGradient id={ring} x1='0.1' y1='0' x2='0.9' y2='1'>
          <stop offset='0' stopColor='#A7F3D0' />
          <stop offset='0.45' stopColor='#34D399' />
          <stop offset='1' stopColor='#059669' />
        </linearGradient>
        <linearGradient id={play} x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0' stopColor='#FFFFFF' />
          <stop offset='1' stopColor='#D1FAE5' />
        </linearGradient>
      </defs>
      <rect width='512' height='512' rx='116' fill={`url(#${bg})`} />
      <rect width='512' height='512' rx='116' fill={`url(#${glow})`} />
      <path
        d='M 372.6 347.1 A 148 148 0 1 1 372.6 164.9'
        fill='none'
        stroke={`url(#${ring})`}
        strokeWidth='46'
        strokeLinecap='round'
      />
      <path
        d='M 222 196 L 222 316 L 322 256 Z'
        fill={`url(#${play})`}
        stroke={`url(#${play})`}
        strokeWidth='26'
        strokeLinejoin='round'
      />
      <circle cx='404' cy='256' r='17' fill='#6EE7B7' />
    </svg>
  );
}
