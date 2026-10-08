export const yellowWords = [
  '伦理片',
  '福利',
  '里番动漫',
  '里番',
  '门事件',
  '萝莉少女',
  '制服诱惑',
  '国产传媒',
  'cosplay',
  '黑丝诱惑',
  '无码',
  '日本无码',
  '有码',
  '日本有码',
  'SWAG',
  'swag',
  '网红主播',
  '色情片',
  '同性片',
  '福利视频',
  '福利片',
  '写真热舞',
  '三级伦理',
  '三级片',
  '三级',
  '成人头条',
  '成人',
  '麻豆',
  '91制片厂',
  '91视频',
  '天美传媒',
  '蜜桃传媒',
  '星空传媒',
  '精东影业',
  '海角社区',
  '乌鸦传媒',
  '兔子先生',
  '杏吧',
  '玩偶姐姐',
  'mini传媒',
  '大象传媒',
  '糖心Vlog',
  '糖心vlog',
  '萝莉社',
  '性视界',
  '无码专区',
  '女同性爱',
  '多人群交',
  '美乳巨乳',
  '巨乳',
  '强奸乱伦',
  '乱伦',
  '街拍偷拍',
  '偷拍',
  '露出激情',
  '唯美写真',
  'SM调教',
  'AV解说',
  '自拍偷拍',
  '探花',
  '情色',
  '春药',
  '熟女人妻',
  '人妻',
  '中文字幕无码',
  '欧美无码',
];

export const adultSourceKeys = ['zy91md', 'zy155', 'danaizi', 'apilj'];

export function isAdultContent(item: {
  title?: string;
  type_name?: string;
  class?: string;
  source?: string;
}): boolean {
  if (item.source && adultSourceKeys.includes(item.source)) {
    return true;
  }
  const typeName = (item.type_name || '').toLowerCase();
  const title = (item.title || '').toLowerCase();
  const cls = (item.class || '').toLowerCase();
  return yellowWords.some((w) => {
    const word = w.toLowerCase();
    return (
      typeName.includes(word) || title.includes(word) || cls.includes(word)
    );
  });
}
