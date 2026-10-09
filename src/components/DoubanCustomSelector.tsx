'use client';

import React, { useEffect, useRef } from 'react';

import ChoiceRow from '@/components/ChoiceRow';

interface CustomCategory {
  name: string;
  type: 'movie' | 'tv';
  query: string;
}

interface DoubanCustomSelectorProps {
  customCategories: CustomCategory[];
  primarySelection?: string;
  secondarySelection?: string;
  onPrimaryChange: (value: string) => void;
  onSecondaryChange: (value: string) => void;
}

const DoubanCustomSelector: React.FC<DoubanCustomSelectorProps> = ({
  customCategories,
  primarySelection,
  secondarySelection,
  onPrimaryChange,
  onSecondaryChange,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  const primaryOptions = React.useMemo(() => {
    const types = Array.from(new Set(customCategories.map((cat) => cat.type)));
    const sortedTypes = types.sort((a, b) => {
      if (a === 'movie' && b !== 'movie') return -1;
      if (a !== 'movie' && b === 'movie') return 1;
      return 0;
    });
    return sortedTypes.map((type) => ({
      label: type === 'movie' ? '电影' : '剧集',
      value: type,
    }));
  }, [customCategories]);

  const secondaryOptions = React.useMemo(() => {
    if (!primarySelection) return [];
    return customCategories
      .filter((cat) => cat.type === primarySelection)
      .map((cat) => ({
        label: cat.name || cat.query,
        value: cat.query,
      }));
  }, [customCategories, primarySelection]);

  // 片单较多时，鼠标滚轮改成横向滚动，避免整页被带着走。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      container.scrollLeft += event.deltaY;
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [secondaryOptions]);

  if (!customCategories || customCategories.length === 0) {
    return null;
  }

  return (
    <div className='space-y-3'>
      <ChoiceRow
        label='类型'
        options={primaryOptions}
        value={primarySelection || primaryOptions[0]?.value}
        onChange={onPrimaryChange}
      />
      {secondaryOptions.length > 0 ? (
        <div ref={scrollRef} className='overflow-x-auto'>
          <ChoiceRow
            label='片单'
            options={secondaryOptions}
            value={secondarySelection || secondaryOptions[0]?.value}
            onChange={onSecondaryChange}
          />
        </div>
      ) : null}
    </div>
  );
};

export default DoubanCustomSelector;
