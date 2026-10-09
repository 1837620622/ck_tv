'use client';

import { choiceClass } from '@/components/ChoiceRow';

interface CapsuleSwitchProps {
  options: { label: string; value: string }[];
  active: string;
  onChange: (value: string) => void;
  className?: string;
}

const CapsuleSwitch = ({
  options,
  active,
  onChange,
  className,
}: CapsuleSwitchProps) => {
  return (
    <div className={`flex gap-1.5 ${className || ''}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type='button'
          onClick={() => onChange(option.value)}
          className={choiceClass(active === option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};

export default CapsuleSwitch;
