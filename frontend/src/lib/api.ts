import type { Gallery, MetaStats, ModelAsset } from '../types/api';

const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

const toUrl = (path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${apiBaseUrl.replace(/\/$/, '')}${normalizedPath}`;
};

const request = async <T>(path: string): Promise<T> => {
  const response = await fetch(toUrl(path));

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return (await response.json()) as T;
};

export const api = {
  getStats: () => request<MetaStats>('/api/meta/stats'),
  getModelAssets: () => request<ModelAsset[]>('/api/assets/models'),
  getGalleries: () => request<Gallery[]>('/api/galleries'),
};
