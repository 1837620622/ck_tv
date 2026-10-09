// 直播栏目只收录公开地址。urls 按顺序兜底，前面失败再试下一条。
// code 是央视网页 html5 接口的频道号，播放时现取，不把会过期的地址写死。

export type LiveGroup = 'news' | 'cctv' | 'satellite' | 'local' | 'platform';

export interface LiveChannel {
  id: string;
  name: string;
  group: LiveGroup;
  kind: 'video' | 'audio' | 'link';
  urls?: string[];
  href?: string;
  code?: string;
}

export const LIVE_GROUPS: { label: string; value: LiveGroup }[] = [
  { label: '新闻', value: 'news' },
  { label: '央视', value: 'cctv' },
  { label: '卫视', value: 'satellite' },
  { label: '地方', value: 'local' },
  { label: '平台', value: 'platform' },
];

const CCTV_PAGE = 'https://tv.cctv.com/live/';
const CGTN_PAGE = 'https://www.cgtn.com/';
const YANGSHI = 'https://www.yangshipin.cn/';

export const LIVE_CHANNELS: LiveChannel[] = [
  {
    id: 'cctvplus1',
    name: 'CCTV+ 1',
    group: 'news',
    kind: 'video',
    urls: [
      'https://cd-live-stream.news.cctvplus.com/live/smil:CHANNEL1.smil/playlist.m3u8',
    ],
    href: CCTV_PAGE,
  },
  {
    id: 'cctvplus2',
    name: 'CCTV+ 2',
    group: 'news',
    kind: 'video',
    urls: [
      'https://cd-live-stream.news.cctvplus.com/live/smil:CHANNEL2.smil/playlist.m3u8',
    ],
    href: CCTV_PAGE,
  },
  {
    id: 'cgtn',
    name: 'CGTN 英语',
    group: 'news',
    kind: 'video',
    urls: [
      'https://news.cgtn.com/resource/live/english/cgtn-news.m3u8',
      'https://english-livebkali.cgtn.com/live/encgtn.m3u8',
    ],
    href: CGTN_PAGE,
  },
  {
    id: 'cgtn-doc',
    name: 'CGTN 纪录',
    group: 'news',
    kind: 'video',
    urls: [
      'https://english-livebkali.cgtn.com/live/doccgtn.m3u8',
      'https://news.cgtn.com/resource/live/document/cgtn-doc.m3u8',
    ],
    href: CGTN_PAGE,
  },
  {
    id: 'cgtn-es',
    name: 'CGTN 西语',
    group: 'news',
    kind: 'video',
    urls: ['https://news.cgtn.com/resource/live/espanol/cgtn-e.m3u8'],
    href: CGTN_PAGE,
  },
  {
    id: 'cgtn-fr',
    name: 'CGTN 法语',
    group: 'news',
    kind: 'video',
    urls: ['https://news.cgtn.com/resource/live/french/cgtn-f.m3u8'],
    href: CGTN_PAGE,
  },
  {
    id: 'cgtn-ar',
    name: 'CGTN 阿语',
    group: 'news',
    kind: 'video',
    urls: ['https://news.cgtn.com/resource/live/arabic/cgtn-a.m3u8'],
    href: CGTN_PAGE,
  },
  {
    id: 'cgtn-ru',
    name: 'CGTN 俄语',
    group: 'news',
    kind: 'video',
    urls: ['https://news.cgtn.com/resource/live/russian/cgtn-r.m3u8'],
    href: CGTN_PAGE,
  },
  // cdrm 清单头写着 720，分片解出来是灰场，浏览器也不接受 avc1.640128。不当成画面。
  ...cctv('cctv1', 'CCTV-1 综合', 'cctv1'),
  ...cctv('cctv13', 'CCTV-13 新闻', 'cctv13'),
  ...satellite('hunan', '湖南卫视'),
  ...satellite('zhejiang', '浙江卫视'),
  ...satellite('dongfang', '东方卫视'),
  ...satellite('jiangsu', '江苏卫视'),
  ...satellite('guangdong', '广东卫视'),
  ...satellite('shenzhen', '深圳卫视'),
  ...satellite('shandong', '山东卫视'),
  ...satellite('anhui', '安徽卫视'),
  ...satellite('tianjin', '天津卫视'),
  ...satellite('chongqing', '重庆卫视'),
  ...satellite('dongnan', '东南卫视'),
  ...satellite('jiangxi', '江西卫视'),
  ...satellite('liaoning', '辽宁卫视'),
  ...satellite('henan', '河南卫视'),
  ...satellite('hubei', '湖北卫视'),
  ...satellite('heilongjiang', '黑龙江卫视'),
  ...satellite('sichuan', '四川卫视'),
  ...satellite('hebei', '河北卫视'),
  ...satellite('jilin', '吉林卫视'),
  ...satellite('guangxi', '广西卫视'),
  ...satellite('yunnan', '云南卫视'),
  ...satellite('guizhou', '贵州卫视'),
  ...satellite('xinjiang', '新疆卫视'),
  ...satellite('gansu', '甘肃卫视'),
  ...satellite('neimenggu', '内蒙古卫视'),
  ...satellite('ningxia', '宁夏卫视'),
  ...satellite('qinghai', '青海卫视'),
  ...satellite('xizang', '西藏卫视'),
  ...cctv('cctv2', 'CCTV-2 财经', 'cctv2'),
  ...cctv('cctv3', 'CCTV-3 综艺', 'cctv3'),
  ...cctv('cctv4', 'CCTV-4 中文国际', 'cctv4'),
  ...cctv('cctv5', 'CCTV-5 体育', 'cctv5'),
  ...cctv('cctv5plus', 'CCTV-5+ 赛事', 'cctv5plus'),
  ...cctv('cctv6', 'CCTV-6 电影', 'cctv6'),
  ...cctv('cctv7', 'CCTV-7 国防军事', 'cctv7'),
  ...cctv('cctv8', 'CCTV-8 电视剧', 'cctv8'),
  ...cctv('cctv10', 'CCTV-10 科教', 'cctv10'),
  ...cctv('cctv11', 'CCTV-11 戏曲', 'cctv11'),
  ...cctv('cctv12', 'CCTV-12 社会与法', 'cctv12'),
  ...cctv('cctv15', 'CCTV-15 音乐', 'cctv15'),
  ...cctv('cctv16', 'CCTV-16 奥林匹克', 'cctv16'),
  ...cctv('cctv17', 'CCTV-17 农业农村', 'cctv17'),
  ...local(
    'hrb-news',
    '哈尔滨新闻',
    'https://stream.hrbtv.net/xwzh/playlist.m3u8'
  ),
  ...local(
    'hrb-movie',
    '哈尔滨影视',
    'https://stream.hrbtv.net/yspd/playlist.m3u8'
  ),
  ...local(
    'hebei-event',
    '河北活动',
    'https://event.pull.hebtv.com/live/live101.m3u8'
  ),
  ...local(
    'lanzhou-news',
    '兰州新闻',
    'https://liveplus.lzr.com.cn/xwzh/HD/live.m3u8'
  ),
  ...local(
    'lanzhou-tour',
    '兰州文旅',
    'https://liveplus.lzr.com.cn/wlpd/HD/live.m3u8'
  ),
  ...local(
    'dongguan',
    '东莞综合',
    'https://stream.sun0769.com/dgrtv1/mp4tv1_800/index.m3u8'
  ),
  ...local(
    'baicheng',
    '白城综合',
    'https://stream2.jlntv.cn/baicheng1/sd/live.m3u8'
  ),
  ...local(
    'bread',
    '面包台',
    'https://video.bread-tv.com:8091/hls-live24/online/index.m3u8'
  ),
  ...local(
    'abn',
    'ABN 中文',
    'https://mediaserver.abnvideos.com/streams/abnchina.m3u8'
  ),
  ...local(
    'angel',
    '天使中文',
    'https://janya-digimix.akamaized.net/vglive-sk-999451/chinese/ngrp:angelchinese_all/playlist.m3u8'
  ),
  {
    id: 'douyin',
    name: '抖音直播',
    group: 'platform',
    kind: 'link',
    href: 'https://live.douyin.com/',
  },
  {
    id: 'kuaishou',
    name: '快手直播',
    group: 'platform',
    kind: 'link',
    href: 'https://live.kuaishou.com/',
  },
  {
    id: 'bilibili-live',
    name: '哔哩直播',
    group: 'platform',
    kind: 'link',
    href: 'https://live.bilibili.com/',
  },
  {
    id: 'douyu',
    name: '斗鱼',
    group: 'platform',
    kind: 'link',
    href: 'https://www.douyu.com/',
  },
  {
    id: 'huya',
    name: '虎牙',
    group: 'platform',
    kind: 'link',
    href: 'https://www.huya.com/',
  },
  {
    id: 'xianyu',
    name: '闲鱼',
    group: 'platform',
    kind: 'link',
    href: 'https://www.goofish.com/',
  },
  {
    id: 'yangshipin',
    name: '央视频',
    group: 'platform',
    kind: 'link',
    href: YANGSHI,
  },
];

function local(id: string, name: string, url: string): LiveChannel[] {
  return [
    {
      id,
      name,
      group: 'local',
      kind: 'video',
      urls: [url],
    },
  ];
}

function satellite(id: string, name: string): LiveChannel[] {
  return [
    {
      id,
      name,
      group: 'satellite',
      kind: 'video',
      code: `pa://cctv_p2p_hd${id}`,
      href: YANGSHI,
    },
  ];
}

function cctv(
  id: string,
  name: string,
  slug: string,
  urls?: string[]
): LiveChannel[] {
  return [
    {
      id,
      name,
      group: 'cctv',
      kind: urls ? 'video' : 'audio',
      urls,
      code: `pa://cctv_p2p_hd${id}`,
      href: `https://tv.cctv.com/live/${slug}/`,
    },
  ];
}

export function findLiveChannel(id: string): LiveChannel | undefined {
  return LIVE_CHANNELS.find((item) => item.id === id);
}
