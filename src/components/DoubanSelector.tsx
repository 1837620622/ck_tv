'use client';

import ChoiceRow from '@/components/ChoiceRow';

interface SelectorOption {
  label: string;
  value: string;
}

interface DoubanSelectorProps {
  type: 'movie' | 'tv' | 'show';
  primarySelection?: string;
  secondarySelection?: string;
  onPrimaryChange: (value: string) => void;
  onSecondaryChange: (value: string) => void;
}

const moviePrimaryOptions: SelectorOption[] = [
  { label: '热门电影', value: '热门' },
  { label: '最新电影', value: '最新' },
  { label: '豆瓣高分', value: '豆瓣高分' },
  { label: '冷门佳片', value: '冷门佳片' },
];

const movieSecondaryOptions: SelectorOption[] = [
  { label: '全部', value: '全部' },
  { label: '华语', value: '华语' },
  { label: '欧美', value: '欧美' },
  { label: '韩国', value: '韩国' },
  { label: '日本', value: '日本' },
  { label: '喜剧', value: '喜剧' },
  { label: '动作', value: '动作' },
  { label: '科幻', value: '科幻' },
  { label: '动画', value: '动画' },
  { label: '悬疑', value: '悬疑' },
  { label: '爱情', value: '爱情' },
  { label: '纪录片', value: '纪录片' },
  { label: '剧情', value: '剧情' },
  { label: '犯罪', value: '犯罪' },
  { label: '惊悚', value: '惊悚' },
  { label: '奇幻', value: '奇幻' },
  { label: '战争', value: '战争' },
  { label: '历史', value: '历史' },
];

const tvOptions: SelectorOption[] = [
  { label: '全部', value: 'tv' },
  { label: '国产', value: 'tv_domestic' },
  { label: '欧美', value: 'tv_american' },
  { label: '日本', value: 'tv_japanese' },
  { label: '韩国', value: 'tv_korean' },
  { label: '动漫', value: 'tv_animation' },
  { label: '纪录片', value: 'tv_documentary' },
];

const showOptions: SelectorOption[] = [
  { label: '全部', value: 'show' },
  { label: '国内', value: 'show_domestic' },
  { label: '国外', value: 'show_foreign' },
];

const DoubanSelector = ({
  type,
  primarySelection,
  secondarySelection,
  onPrimaryChange,
  onSecondaryChange,
}: DoubanSelectorProps) => {
  if (type === 'movie') {
    return (
      <div className='space-y-3'>
        <ChoiceRow
          label='分类'
          options={moviePrimaryOptions}
          value={primarySelection || moviePrimaryOptions[0].value}
          onChange={onPrimaryChange}
        />
        <ChoiceRow
          label='筛选'
          options={movieSecondaryOptions}
          value={secondarySelection || movieSecondaryOptions[0].value}
          onChange={onSecondaryChange}
        />
      </div>
    );
  }

  const options = type === 'tv' ? tvOptions : showOptions;
  return (
    <ChoiceRow
      label='类型'
      options={options}
      value={secondarySelection || options[0].value}
      onChange={onSecondaryChange}
    />
  );
};

export default DoubanSelector;
