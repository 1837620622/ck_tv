'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import {
  DoubanFilter,
  EMPTY_FILTER,
  GENRE_OPTIONS,
  isFilterActive,
  RATE_OPTIONS,
  REGION_OPTIONS,
  SORT_OPTIONS,
  yearOptions,
} from '@/lib/douban-filter';

import ChoiceRow, { choiceClass } from '@/components/ChoiceRow';

// 筛选面板默认收起，只显示一个“筛选”按钮和当前生效的条件，不占用首屏空间。
// 展开后是年份、地区、类型、评分、排序五行，和上方的分类选择器用同一套按钮样式。
export default function DoubanFilterBar({
  value,
  onChange,
  currentYear,
}: {
  value: DoubanFilter;
  onChange: (next: DoubanFilter) => void;
  currentYear: number;
}) {
  const [open, setOpen] = useState(false);
  const years = yearOptions(currentYear);
  const labelOf = (
    options: { label: string; value: string }[],
    target: string
  ) => options.find((option) => option.value === target)?.label ?? target;

  const chips: string[] = [];
  if (value.year) chips.push(labelOf(years, value.year));
  if (value.region) chips.push(value.region);
  if (value.genre) chips.push(value.genre);
  if (value.minRate) chips.push(labelOf(RATE_OPTIONS, value.minRate));
  if (value.sort) chips.push(labelOf(SORT_OPTIONS, value.sort));

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <button
          type='button'
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className={`inline-flex items-center gap-1 ${choiceClass(open)}`}
        >
          筛选
          <ChevronDown
            className={`h-4 w-4 transition-transform ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden='true'
          />
        </button>
        {chips.map((chip) => (
          <span
            key={chip}
            className='rounded-full bg-green-50 px-2.5 py-1 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-300'
          >
            {chip}
          </span>
        ))}
        {isFilterActive(value) ? (
          <button
            type='button'
            onClick={() => onChange(EMPTY_FILTER)}
            className='text-xs text-gray-500 hover:text-green-700 hover:underline dark:text-gray-400 dark:hover:text-green-400'
          >
            清除
          </button>
        ) : null}
      </div>

      {open ? (
        <div className='space-y-2'>
          <ChoiceRow
            label='年份'
            options={years}
            value={value.year}
            onChange={(year) => onChange({ ...value, year })}
            dense
          />
          <ChoiceRow
            label='地区'
            options={REGION_OPTIONS}
            value={value.region}
            onChange={(region) => onChange({ ...value, region })}
            dense
          />
          <ChoiceRow
            label='题材'
            options={GENRE_OPTIONS}
            value={value.genre}
            onChange={(genre) => onChange({ ...value, genre })}
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
      ) : null}
    </div>
  );
}
