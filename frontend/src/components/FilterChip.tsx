import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface FilterChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  label: ReactNode;
  isActive?: boolean;
  tone?: 'default' | 'solid';
  count?: number;
}

export const FilterChip = ({
  label,
  isActive = false,
  tone = 'default',
  count,
  className = '',
  ...buttonProps
}: FilterChipProps) => (
  <button
    type="button"
    className={`filter-chip filter-chip--${tone} ${isActive ? 'filter-chip--active' : ''} ${className}`.trim()}
    {...buttonProps}
  >
    <span className="filter-chip__label">{label}</span>
    {typeof count === 'number' ? <span className="filter-chip__count">{count}</span> : null}
  </button>
);
