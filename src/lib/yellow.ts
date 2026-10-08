export const adultSourceKeys = [
  'zy91md',
  'zy155',
  'danaizi',
  'apilj',
  'slzy',
  'ckzy',
  'lbzy',
  'fhapi9',
  'aosika',
  'souav',
  'naixx',
  'jkun',
  'thzy',
  'bwzy',
  'lbby',
  'shayu',
  'heitao',
  'yutu',
  'huangguo',
];

// 成人采集站域名。后台旧配置即使换了 key，也不能再进全站搜索。
export const adultApiHosts = [
  '91md.me',
  '155api.com',
  'apidanaizi.com',
  'apilj.com',
  'slapibf.com',
  'ckzy.me',
  'lbapi9.com',
  'fhapi9.com',
  'jkunzyapi.com',
  'souavzy.vip',
  'aosikazy.com',
  'naixxzy.com',
  'thzy1.me',
  'bwzyz.com',
  'lbapiby.com',
  'shayuapi.com',
  'zy.heitaodj.com',
  'heitaodj.com',
  'apiyutu.com',
  'yutuzy10.com',
  'huangguoai.com',
];

// 分类名或标题里出现这些词时，不进 18+ 列表。
const underageLabel = /萝莉|幼女|未成年|小学生|幼幼|正太|幼童|童颜|loli/i;

export function isUnderageLabel(text?: string): boolean {
  return !!text && underageLabel.test(text);
}

export function apiHost(api?: string): string {
  if (!api) return '';
  try {
    return new URL(api).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function isAdultSource(site: {
  key?: string;
  api?: string;
  category?: string;
}): boolean {
  if (!site) return false;
  if (site.key && adultSourceKeys.includes(site.key)) return true;
  const category = (site.category || '').toLowerCase();
  if (category === 'adult' || category === 'erotic') return true;
  const host = apiHost(site.api);
  return adultApiHosts.some(
    (item) => host === item || host.endsWith(`.${item}`)
  );
}

export const adultCategoryKeywords = [
  '伦理',
  '三级',
  '情色',
  '写真',
  '擦边',
  '福利',
  '里番',
  '成人',
  '自拍',
  '性爱',
  '偷拍',
  '盗摄',
  '裸聊',
  '群交',
  '乱伦',
  '两性',
  '无码',
  '有码',
  '性爱',
  '盗摄',
  '黄片',
  '女优',
  '极品',
  '调教',
  '性交',
  '人妖',
  '女同',
  '强奸',
];

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
  '被操',
  '操死',
  '操逼',
  '操弄',
  '操我',
  '操了',
  '操妹',
  '操嫂',
  '操妈',
  '操姐',
  '操女',
  '操同学',
  '操长相',
  '做爱',
  '性交',
  '内射',
  '射精',
  '口交',
  '高潮',
  '肉棒',
  '骚货',
  '淫乱',
  '淫荡',
  '淫妻',
  '换妻',
  '裸聊',
  '盗摄',
  '迷奸',
  '轮奸',
  '福利姬',
  '打炮',
  '约炮',
  '性奴',
  '阴道',
  '阴茎',
  '开苞',
  '破处',
  '啪啪',
  '炮友',
  '淫叫',
  '黄片',
  '中出',
];

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

  // 分类命中色情/成人关键词则直接阻断
  if (
    adultCategoryKeywords.some(
      (cat) => typeName.includes(cat) || cls.includes(cat)
    )
  ) {
    return true;
  }

  return yellowWords.some((w) => {
    const word = w.toLowerCase();
    return (
      typeName.includes(word) || title.includes(word) || cls.includes(word)
    );
  });
}
