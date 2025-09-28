export type ServiceStatusKey = 'frontend' | 'backend' | 'minio' | 'gpu';

export type ServiceState = 'online' | 'offline' | 'degraded' | 'unknown';

export interface ServiceIndicator {
  label: string;
  status: ServiceState;
  message: string;
}
