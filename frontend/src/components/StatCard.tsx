interface StatCardProps {
  label: string;
  value: number | string;
  helper?: string;
}

export const StatCard = ({ label, value, helper }: StatCardProps) => (
  <div className="stat-card">
    <p className="stat-card__label">{label}</p>
    <p className="stat-card__value">{value}</p>
    {helper ? <p className="stat-card__helper">{helper}</p> : null}
  </div>
);
