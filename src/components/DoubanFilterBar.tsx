'use client';

import {
  DoubanFilter,
  RATE_OPTIONS,
  SORT_OPTIONS,
  yearOptions,
} from '@/lib/douban-filter';

import ChoiceRow from '@/components/ChoiceRow';

// 年份、评分、排序三行筛选，和上方的分类选择器用同一套按钮样式。
// 年份选项按当前年份生成；没有年份信息的分类会在结果区给出提示。
export default function DoubanFilterBar({
  value,
  onChange,
  currentYear,
}: {
  value: DoubanFilter;
  onChange: (next: DoubanFilter) => void;
  currentYear: number;
}) {
  return (
    <div className='space-y-2'>
      <ChoiceRow
        label='年份'
        options={yearOptions(currentYear)}
        value={value.year}
        onChange={(year) => onChange({ ...value, year })}
        dense
      />
      <ChoiceRow
        label='评分'
        options={RATE_OPTIONS}
        value={value.minRate}
        onChange={(minRate) => onChange({ ...value, minRate })}
        dense
      />
      <ChoiceRow
        label='排序'
        options={SORT_OPTIONS}
        value={value.sort}
        onChange={(sort) => onChange({ ...value, sort })}
        dense
      />
    </div>
  );
}
