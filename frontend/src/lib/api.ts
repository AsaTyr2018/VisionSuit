import type {
  AuthResponse,
  Gallery,
  ImageAsset,
  MetaStats,
  ModelAsset,
  RankTier,
  RankingSettings,
  ServiceStatusResponse,
  UserProfile,
  UserProfileRank,
  User,
} from '../types/api';

import { buildApiUrl } from '../config';

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
  context?: 'asset' | 'gallery';
  title: string;
  description?: string;
  visibility: 'private' | 'public';
  category?: string;
  trigger?: string;
  tags: string[];
  galleryMode: 'existing' | 'new';
  targetGallery?: string;
  files: File[];
}

interface CreateUploadDraftResponse {
  uploadId?: string;
  message?: string;
  assetId?: string;
  assetSlug?: string;
  imageId?: string;
  imageIds?: string[];
  gallerySlug?: string;
  entryIds?: string[];
}

interface UpdateGalleryPayload {
  title?: string;
  description?: string | null;
  ownerId?: string;
  isPublic?: boolean;
  coverImage?: string | null;
  entries?: { id: string; position: number; note?: string | null }[];
  removeEntryIds?: string[];
}

const request = async <T>(path: string, options: RequestInit = {}, token?: string): Promise<T> => {
  const headers = new Headers(options.headers ?? {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const body = options.body;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  if (!isFormData && body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(buildApiUrl(path), { ...options, headers });

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const body = (await response.json().catch(() => null)) as
        | {
            message?: string;
            errors?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
          }
        | null;
      const message = typeof body?.message === 'string' ? body.message : `API request failed: ${response.status}`;
      const fieldErrors = body?.errors?.fieldErrors ?? {};
      const formErrors = body?.errors?.formErrors ?? [];
      const details = [
        ...formErrors.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
        ...Object.values(fieldErrors).flatMap((entries) => entries ?? []).filter((entry) => entry && entry.length > 0),
      ];
      throw new ApiError(message, details.length > 0 ? details : undefined);
    }

    const message = await response.text().catch(() => null);
    throw new ApiError(message || `API request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
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

const postUploadDraft = async (payload: CreateUploadDraftPayload, token: string) => {
  const formData = new FormData();
  formData.append('assetType', payload.assetType);
  formData.append('context', payload.context ?? 'asset');
  formData.append('title', payload.title);
  formData.append('visibility', payload.visibility);

  if (payload.description) {
    formData.append('description', payload.description);
  }

  if (payload.category) {
    formData.append('category', payload.category);
  }

  if (payload.trigger) {
    formData.append('trigger', payload.trigger);
  }

  formData.append('galleryMode', payload.galleryMode);

  if (payload.targetGallery) {
    formData.append('targetGallery', payload.targetGallery);
  }

  payload.tags.forEach((tag) => formData.append('tags', tag));
  payload.files.forEach((file) => formData.append('files', file, file.name));

  try {
    const response = await fetch(buildApiUrl('/api/uploads'), {
      method: 'POST',
      body: formData,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
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

const postModelVersion = async (
  token: string,
  modelId: string,
  payload: { version: string; modelFile: File; previewFile: File },
) => {
  const formData = new FormData();
  formData.append('version', payload.version);
  formData.append('model', payload.modelFile, payload.modelFile.name);
  formData.append('preview', payload.previewFile, payload.previewFile.name);

  try {
    const response = await fetch(buildApiUrl(`/api/assets/models/${modelId}/versions`), {
      method: 'POST',
      body: formData,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });

    if (!response.ok) {
      await parseError(response);
    }

    return (await response.json()) as ModelAsset;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof TypeError) {
      throw new ApiError('Version konnte nicht hochgeladen werden. Backend nicht erreichbar?', [error.message]);
    }

    throw new ApiError(
      error instanceof Error ? error.message : 'Unbekannter Fehler beim Hochladen der Modellversion.',
    );
  }
};

const putModelVersion = async (
  token: string,
  modelId: string,
  versionId: string,
  payload: { version: string },
) => {
  try {
    return await request<ModelAsset>(
      `/api/assets/models/${modelId}/versions/${versionId}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    );
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      error instanceof Error ? error.message : 'Unbekannter Fehler beim Bearbeiten der Modellversion.',
    );
  }
};

const promoteModelVersion = async (token: string, modelId: string, versionId: string) =>
  request<ModelAsset>(
    `/api/assets/models/${modelId}/versions/${versionId}/promote`,
    {
      method: 'POST',
    },
    token,
  );

const deleteModelVersion = async (token: string, modelId: string, versionId: string) =>
  request<ModelAsset>(
    `/api/assets/models/${modelId}/versions/${versionId}`,
    {
      method: 'DELETE',
    },
    token,
  );

export const api = {
  getStats: () => request<MetaStats>('/api/meta/stats'),
  getModelAssets: (token?: string) => request<ModelAsset[]>('/api/assets/models', {}, token),
  getGalleries: (token?: string) => request<Gallery[]>('/api/galleries', {}, token),
  getImageAssets: (token?: string) => request<ImageAsset[]>('/api/assets/images', {}, token),
  getServiceStatus: () => request<ServiceStatusResponse>('/api/meta/status'),
  createUploadDraft: postUploadDraft,
  createModelVersion: postModelVersion,
  updateModelVersion: putModelVersion,
  promoteModelVersion,
  deleteModelVersion,
  login: (email: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  getCurrentUser: (token: string) => request<{ user: User }>('/api/auth/me', {}, token),
  getUserProfile: (userId: string, options?: { token?: string; audit?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.audit) {
      params.set('audit', '1');
    }

    const path = params.size > 0 ? `/api/users/${userId}/profile?${params.toString()}` : `/api/users/${userId}/profile`;
    return request<{ profile: UserProfile }>(path, {}, options?.token);
  },
  getUsers: (token: string) => request<{ users: User[] }>('/api/users', {}, token),
  createUser: (token: string, payload: { email: string; displayName: string; password: string; role: string; bio?: string }) =>
    request<{ user: User }>(
      '/api/users',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),
  updateUser: (token: string, id: string, payload: Partial<{ email: string; displayName: string; password: string; role: string; bio: string | null; isActive: boolean }>) =>
    request<{ user: User }>(
      `/api/users/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),
  updateOwnProfile: (token: string, id: string, payload: Partial<{ displayName: string; bio: string | null }>) =>
    request<{ user: User }>(
      `/api/users/${id}/profile`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),
  uploadAvatar: (token: string, id: string, file: File) => {
    const formData = new FormData();
    formData.append('avatar', file, file.name);

    return request<{ user: User }>(
      `/api/users/${id}/avatar`,
      {
        method: 'POST',
        body: formData,
      },
      token,
    );
  },
  changePassword: (
    token: string,
    id: string,
    payload: { currentPassword: string; newPassword: string; confirmPassword: string },
  ) =>
    request<{ message: string }>(
      `/api/users/${id}/password`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),
  deleteUser: (token: string, id: string) => request(`/api/users/${id}`, { method: 'DELETE' }, token),
  bulkDeleteUsers: (token: string, ids: string[]) =>
    request<{ deleted: string[] }>(
      '/api/users/bulk-delete',
      {
        method: 'POST',
        body: JSON.stringify({ ids }),
      },
      token,
    ),
  updateModelAsset: (
    token: string,
    id: string,
    payload: Partial<{
      title: string;
      description: string | null;
      version: string;
      trigger: string | null;
      tags: string[];
      ownerId: string;
    }>,
  ) =>
    request<ModelAsset>(
      `/api/assets/models/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),
  linkModelToGallery: (
    token: string,
    modelId: string,
    payload: { galleryId: string; note?: string | null },
  ) =>
    request<{ gallery: Gallery }>(
      `/api/assets/models/${modelId}/galleries`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),
  deleteModelAsset: (token: string, id: string) => request(`/api/assets/models/${id}`, { method: 'DELETE' }, token),
  bulkDeleteModelAssets: (token: string, ids: string[]) =>
    request<{ deleted: string[] }>(
      '/api/assets/models/bulk-delete',
      {
        method: 'POST',
        body: JSON.stringify({ ids }),
      },
      token,
    ),
  updateImageAsset: (
    token: string,
    id: string,
    payload: Partial<{
      title: string;
      description: string | null;
      prompt: string | null;
      negativePrompt: string | null;
      tags: string[];
      ownerId: string;
      metadata: {
        seed?: string | null;
        model?: string | null;
        sampler?: string | null;
        cfgScale?: number | null;
        steps?: number | null;
      };
    }>,
  ) =>
    request<ImageAsset>(
      `/api/assets/images/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),
  deleteImageAsset: (token: string, id: string) => request(`/api/assets/images/${id}`, { method: 'DELETE' }, token),
  bulkDeleteImageAssets: (token: string, ids: string[]) =>
    request<{ deleted: string[] }>(
      '/api/assets/images/bulk-delete',
      {
        method: 'POST',
        body: JSON.stringify({ ids }),
      },
      token,
    ),
  updateGallery: (token: string, id: string, payload: UpdateGalleryPayload) =>
    request<Gallery>(
      `/api/galleries/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),
  deleteGallery: (token: string, id: string) => request(`/api/galleries/${id}`, { method: 'DELETE' }, token),
  getRankingSettings: (token: string) => request<{ settings: RankingSettings }>(`/api/rankings/settings`, {}, token),
  updateRankingSettings: (
    token: string,
    payload: { modelWeight: number; galleryWeight: number; imageWeight: number },
  ) =>
    request<{ settings: RankingSettings }>(
      `/api/rankings/settings`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),
  getRankTiers: (token: string) => request<{ tiers: RankTier[]; isFallback: boolean }>(`/api/rankings/tiers`, {}, token),
  createRankTier: (
    token: string,
    payload: { label: string; description: string; minimumScore: number; position?: number; isActive?: boolean },
  ) =>
    request<{ tier: RankTier }>(
      `/api/rankings/tiers`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),
  updateRankTier: (
    token: string,
    id: string,
    payload: Partial<{
      label: string;
      description: string;
      minimumScore: number;
      position?: number;
      isActive?: boolean;
    }>,
  ) =>
    request<{ tier: RankTier }>(
      `/api/rankings/tiers/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),
  deleteRankTier: (token: string, id: string) => request(`/api/rankings/tiers/${id}`, { method: 'DELETE' }, token),
  resetRankingUser: (token: string, id: string) =>
    request<{ userId: string; rank: UserProfileRank }>(`/api/rankings/users/${id}/reset`, { method: 'POST' }, token),
  blockRankingUser: (token: string, id: string) =>
    request<{ userId: string; rank: UserProfileRank }>(`/api/rankings/users/${id}/block`, { method: 'POST' }, token),
  unblockRankingUser: (token: string, id: string) =>
    request<{ userId: string; rank: UserProfileRank }>(`/api/rankings/users/${id}/unblock`, { method: 'POST' }, token),
};
