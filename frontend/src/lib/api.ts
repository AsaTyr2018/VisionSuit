import type { Gallery, MetaStats, ModelAsset } from '../types/api';

export class ApiError extends Error {
  details?: string[];

  constructor(message: string, details?: string[]) {
    super(message);
    this.name = 'ApiError';
    this.details = details;
  }
}

interface CreateUploadDraftPayload {
  assetType: 'lora' | 'image';
  title: string;
  description?: string;
  visibility: 'private' | 'public';
  category?: string;
  tags: string[];
  galleryMode: 'existing' | 'new';
  targetGallery?: string;
  files: File[];
}

interface CreateUploadDraftResponse {
  uploadId?: string;
  message?: string;
}

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

const parseError = async (response: Response): Promise<never> => {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string; errors?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } }
      | null;
    const message = typeof body?.message === 'string' ? body.message : `Upload request failed: ${response.status}`;
    const fieldErrors = body?.errors?.fieldErrors ?? {};
    const formErrors = body?.errors?.formErrors ?? [];
    const details = [
      ...formErrors.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
      ...Object.values(fieldErrors).flatMap((entries) => entries ?? []).filter((entry) => entry && entry.length > 0),
    ];
    throw new ApiError(message, details.length > 0 ? details : undefined);
  }

  const errorText = await response.text().catch(() => '');
  throw new ApiError(errorText || `Upload request failed: ${response.status}`);
};

const postUploadDraft = async (payload: CreateUploadDraftPayload) => {
  const formData = new FormData();
  formData.append('assetType', payload.assetType);
  formData.append('title', payload.title);
  formData.append('visibility', payload.visibility);

  if (payload.description) {
    formData.append('description', payload.description);
  }

  if (payload.category) {
    formData.append('category', payload.category);
  }

  formData.append('galleryMode', payload.galleryMode);

  if (payload.targetGallery) {
    formData.append('targetGallery', payload.targetGallery);
  }

  payload.tags.forEach((tag) => formData.append('tags', tag));
  payload.files.forEach((file) => formData.append('files', file, file.name));

  try {
    const response = await fetch(toUrl('/api/uploads'), {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      await parseError(response);
    }

    return (await response.json().catch(() => ({}))) as CreateUploadDraftResponse;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof TypeError) {
      throw new ApiError('Upload konnte nicht gestartet werden. Backend nicht erreichbar?', [error.message]);
    }

    throw new ApiError(error instanceof Error ? error.message : 'Unbekannter Fehler beim Upload.');
  }
};

export const api = {
  getStats: () => request<MetaStats>('/api/meta/stats'),
  getModelAssets: () => request<ModelAsset[]>('/api/assets/models'),
  getGalleries: () => request<Gallery[]>('/api/galleries'),
  createUploadDraft: postUploadDraft,
};
