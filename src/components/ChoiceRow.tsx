'use client';

interface ChoiceOption {
  label: string;
  value: string;
}

// 全站筛选条用同一套边框按钮。选中是实心绿，未选中是白底灰边，不再混用胶囊和裸文字。
export function choiceClass(active: boolean, dense = false) {
  return [
    'shrink-0 border',
    dense ? 'px-3 py-1 text-xs' : 'px-3 py-1.5 text-sm',
    active
      ? 'border-green-600 bg-green-600 text-white'
      : 'border-gray-300 bg-white text-gray-700 hover:border-green-600 hover:text-green-700 dark:border-gray-600 dark:bg-gray-950 dark:text-gray-200 dark:hover:border-green-500 dark:hover:text-green-400',
  ].join(' ');
}

export default function ChoiceRow({
  label,
  options,
  value,
  onChange,
  dense = false,
}: {
  label?: string;
  options: ChoiceOption[];
  value?: string;
  onChange: (value: string) => void;
  dense?: boolean;
}) {
  return (
    <div className='flex min-w-0 items-center gap-2'>
      {label ? (
        <span className='w-10 shrink-0 text-sm text-gray-600 dark:text-gray-400'>
          {label}
        </span>
      ) : null}
      <div className='flex min-w-0 gap-1.5 overflow-x-auto'>
        {options.map((option) => (
          <button
            key={option.value}
            type='button'
            onClick={() => onChange(option.value)}
            className={choiceClass(value === option.value, dense)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
