import type { FC } from 'react';

import type { ServiceIndicator, ServiceState, ServiceStatusKey } from '../types/serviceStatus';

interface ServiceStatusPageProps {
  services: Array<{
    key: ServiceStatusKey;
    badge: string;
    indicator: ServiceIndicator;
  }>;
  statusLabels: Record<ServiceState, string>;
  onBack: () => void;
}

export const ServiceStatusPage: FC<ServiceStatusPageProps> = ({ services, statusLabels, onBack }) => {
  const healthyServices = services.filter(({ indicator }) => indicator.status === 'online').length;
  const affectedServices = services.filter(({ indicator }) =>
    indicator.status === 'degraded' || indicator.status === 'unknown'
  ).length;
  const offlineServices = services.filter(({ indicator }) => indicator.status === 'offline').length;
  const deactivatedServices = services.filter(({ indicator }) => indicator.status === 'deactivated').length;
  const deactivatedList = services.filter(({ indicator }) => indicator.status === 'deactivated');

  return (
    <div className="status-page">
      <header className="status-page__header">
        <button type="button" className="status-page__back" onClick={onBack}>
          ← Back to dashboard
        </button>
        <div>
          <h2>Live service status</h2>
          <p>
            Real-time health for the VisionSuit interface, API, asset storage, and GPU worker. Status checks refresh in the
            background while you browse.
          </p>
        </div>
      </header>

      <section className="status-page__overview" aria-label="Status summary">
        <div className="status-page__metric">
          <span className="status-page__metric-label">Online</span>
          <span className="status-page__metric-value">{healthyServices}</span>
          <span className="status-page__metric-description">Services responding normally.</span>
        </div>
        <div className="status-page__metric">
          <span className="status-page__metric-label">Attention</span>
          <span className="status-page__metric-value">{affectedServices}</span>
          <span className="status-page__metric-description">Degraded or recovering components.</span>
        </div>
        <div className="status-page__metric">
          <span className="status-page__metric-label">Offline</span>
          <span className="status-page__metric-value">{offlineServices}</span>
          <span className="status-page__metric-description">Services requiring immediate action.</span>
        </div>
        <div className="status-page__metric">
          <span className="status-page__metric-label">Deactivated</span>
          <span className="status-page__metric-value">{deactivatedServices}</span>
          <span className="status-page__metric-description">
            Modules intentionally switched off in administration.
          </span>
        </div>
      </section>

      <section className="status-page__services" aria-label="Service details">
        <h3>Current status</h3>
        <ul className="status-page__list">
          {services.map(({ key, badge, indicator }) => (
            <li key={key} className={`status-card status-card--${indicator.status}`}>
              <div className="status-card__header">
                <span className="status-card__badge">{badge}</span>
                <div className="status-card__title-group">
                  <span className="status-card__name">{indicator.label}</span>
                  <span className={`status-led status-led--${indicator.status}`} aria-hidden="true" />
                  <span className="sr-only">{statusLabels[indicator.status]}</span>
                </div>
              </div>
              <p className="status-card__message">{indicator.message}</p>
            </li>
          ))}
        </ul>
      </section>

      {deactivatedList.length > 0 ? (
        <section className="status-page__deactivated" aria-label="Deactivated services">
          <h3>Deactivated services</h3>
          <ul>
            {deactivatedList.map(({ key, indicator }) => (
              <li key={key}>
                <strong>{indicator.label}</strong>
                <span>{statusLabels[indicator.status]}</span>
                <p>{indicator.message}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="status-page__help" aria-label="Support guidance">
        <h3>Need support?</h3>
        <p>
          Visit the VisionSuit{' '}
          <a href="https://discord.gg/UEb68YQwKR" target="_blank" rel="noreferrer noopener">
            Discord support hub
          </a>{' '}
          or review the GPU worker logs to triage outages. Service updates appear here the moment health checks change state.
        </p>
      </section>
    </div>
  );
};

export default ServiceStatusPage;
