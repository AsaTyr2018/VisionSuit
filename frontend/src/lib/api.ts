import type {
  AuthResponse,
  AssetComment,
  Gallery,
  GeneratorAccessMode,
  GeneratorBaseModelConfig,
  GeneratorBaseModelOption,
  GeneratorBaseModelType,
  GeneratorRequestSummary,
  GeneratorQueueResponse,
  GeneratorSettings,
  GeneratorFailureLogResponse,
  GeneratorArtifactImportResult,
  ImageAsset,
  MetaStats,
  ModerationQueue,
  ModelAsset,
  RankTier,
  RankingSettings,
  AdminSettings,
  AdminSettingsResponse,
  PlatformConfigResponse,
  ServiceStatusResponse,
  UserProfile,
  UserProfileRank,
  User,
  AdultSafetyKeyword,
  MetadataThresholdPreview,
  NsfwRescanSummary,
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

interface CreateGeneratorRequestPayload {
  baseModels: { id: string; name: string; type: GeneratorBaseModelType }[];
  prompt: string;
  negativePrompt?: string | null;
  seed?: string | null;
  guidanceScale?: number | null;
  steps?: number | null;
  width: number;
  height: number;
  sampler: string;
  scheduler: string;
  loras: { id: string; strength: number }[];
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

interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

type PaginationOptions = {
  cursor?: string | null;
  take?: number;
  page?: number;
  pageSize?: number;
};

const buildPaginationQuery = (options: PaginationOptions) => {
  const params = new URLSearchParams();

  if (options.cursor) {
    params.set('cursor', options.cursor);
  }

  if (options.take != null) {
    params.set('take', String(options.take));
  }

  if (options.page != null) {
    params.set('page', String(options.page));
  }

  if (options.pageSize != null) {
    params.set('pageSize', String(options.pageSize));
  }

  return params;
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

const getPlatformConfig = () =>
  request<PlatformConfigResponse>('/api/meta/config').then((response) => response.platform);

const getAdminSettings = (token: string) =>
  request<AdminSettingsResponse>('/api/settings', {}, token).then((response) => response.settings);

const getMetadataThresholdPreview = (token: string) =>
  request<{ preview: MetadataThresholdPreview }>(
    '/api/safety/metadata/preview',
    {},
    token,
  ).then((response) => response.preview);

const triggerNsfwRescan = (
  token: string,
  payload: { target?: 'all' | 'models' | 'images'; limit?: number } = {},
) =>
  request<{ rescan: NsfwRescanSummary }>(
    '/api/safety/nsfw/rescan',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    token,
  ).then((response) => response.rescan);

const updateAdminSettings = (token: string, payload: AdminSettings) =>
  request<AdminSettingsResponse>(
    '/api/settings',
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
    token,
  ).then((response) => response.settings);

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

const getGeneratorBaseModelCatalog = (token: string) =>
  request<{ baseModels: ModelAsset[] }>('/api/generator/base-models/catalog', {}, token).then(
    (response) => response.baseModels,
  );

const getGeneratorBaseModels = (token: string) =>
  request<GeneratorBaseModelOption[]>('/api/generator/base-models', {}, token);

const getGeneratorSettings = (token?: string) =>
  request<{ settings: GeneratorSettings }>('/api/generator/settings', {}, token).then((response) => response.settings);

const updateGeneratorSettings = (
  token: string,
  payload: { accessMode: GeneratorAccessMode; baseModels: GeneratorBaseModelConfig[] },
) =>
  request<{ settings: GeneratorSettings }>(
    '/api/generator/settings',
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
    token,
  ).then((response) => response.settings);

const createGeneratorRequest = (token: string, payload: CreateGeneratorRequestPayload) =>
  request<{ request: GeneratorRequestSummary }>(
    '/api/generator/requests',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    token,
  ).then((response) => response.request);

const getGeneratorRequests = (
  token: string,
  scope: 'mine' | 'all' = 'mine',
  options?: { statuses?: string[] },
) => {
  const params = new URLSearchParams();
  if (scope === 'all') {
    params.set('scope', 'all');
  }

  const normalizedStatuses = (options?.statuses ?? [])
    .map((status) => status.trim())
    .filter((status) => status.length > 0);
  if (normalizedStatuses.length > 0) {
    params.set('status', normalizedStatuses.join(','));
  }

  const query = params.toString();
  const path = `/api/generator/requests${query ? `?${query}` : ''}`;
  return request<{ requests: GeneratorRequestSummary[] }>(path, {}, token).then((response) => response.requests);
};

const cancelGeneratorRequest = (token: string, requestId: string) =>
  request<{ request: GeneratorRequestSummary }>(
    `/api/generator/requests/${requestId}/actions/cancel`,
    {
      method: 'POST',
    },
    token,
  ).then((response) => response.request);

const getGeneratorQueue = (token: string) => request<GeneratorQueueResponse>('/api/generator/queue', {}, token);

const getGeneratorFailureLog = (token: string, limit?: number) => {
  const parsedLimit = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : null;
  const constrained = parsedLimit ? Math.min(parsedLimit, 200) : null;
  const query = constrained ? `?limit=${constrained}` : '';
  return request<GeneratorFailureLogResponse>(`/api/generator/errors${query}`, {}, token);
};

const pauseGeneratorQueue = (token: string) =>
  request<GeneratorQueueResponse>(
    '/api/generator/queue/actions/pause',
    {
      method: 'POST',
    },
    token,
  );

const resumeGeneratorQueue = (token: string) =>
  request<GeneratorQueueResponse>(
    '/api/generator/queue/actions/resume',
    {
      method: 'POST',
    },
    token,
  );

const retryGeneratorQueue = (token: string) =>
  request<GeneratorQueueResponse>(
    '/api/generator/queue/actions/retry',
    {
      method: 'POST',
    },
    token,
  );

const clearGeneratorQueue = (token: string) =>
  request<GeneratorQueueResponse>(
    '/api/generator/queue/actions/clear',
    {
      method: 'POST',
    },
    token,
  );

const blockGeneratorUser = (token: string, payload: { userId: string; reason?: string }) =>
  request<GeneratorQueueResponse>(
    '/api/generator/queue/blocks',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    token,
  );

const unblockGeneratorUser = (token: string, userId: string) =>
  request<GeneratorQueueResponse>(
    `/api/generator/queue/blocks/${userId}`,
    {
      method: 'DELETE',
    },
    token,
  );

const likeImageAsset = (token: string, imageId: string) =>
  request<{ image: ImageAsset }>(
    `/api/assets/images/${imageId}/likes`,
    {
      method: 'POST',
    },
    token,
  );

const unlikeImageAsset = (token: string, imageId: string) =>
  request<{ image: ImageAsset }>(
    `/api/assets/images/${imageId}/likes`,
    {
      method: 'DELETE',
    },
    token,
  );

export const api = {
  getPlatformConfig,
  getStats: () => request<MetaStats>('/api/meta/stats'),
  getModelAssets: (
    options: ({ token?: string } & PaginationOptions) | string | undefined,
  ) => {
    if (typeof options === 'string') {
      return request<PaginatedResponse<ModelAsset>>('/api/assets/models', {}, options);
    }

    const { token, ...pagination } = options ?? {};
    const params = buildPaginationQuery(pagination);
    const query = params.toString();
    const path = query.length > 0 ? `/api/assets/models?${query}` : '/api/assets/models';
    return request<PaginatedResponse<ModelAsset>>(path, {}, token);
  },
  getGalleries: (token?: string) => request<Gallery[]>('/api/galleries', {}, token),
  getImageAssets: (
    options: ({ token?: string } & PaginationOptions) | string | undefined,
  ) => {
    if (typeof options === 'string') {
      return request<PaginatedResponse<ImageAsset>>('/api/assets/images', {}, options);
    }

    const { token, ...pagination } = options ?? {};
    const params = buildPaginationQuery(pagination);
    const query = params.toString();
    const path = query.length > 0 ? `/api/assets/images?${query}` : '/api/assets/images';
    return request<PaginatedResponse<ImageAsset>>(path, {}, token);
  },
  getServiceStatus: () => request<ServiceStatusResponse>('/api/meta/status'),
  createUploadDraft: postUploadDraft,
  createModelVersion: postModelVersion,
  updateModelVersion: putModelVersion,
  promoteModelVersion,
  deleteModelVersion,
  getGeneratorSettings,
  updateGeneratorSettings,
  getGeneratorBaseModelCatalog,
  getGeneratorBaseModels,
  getGeneratorQueue,
  getGeneratorFailureLog,
  pauseGeneratorQueue,
  resumeGeneratorQueue,
  retryGeneratorQueue,
  clearGeneratorQueue,
  blockGeneratorUser,
  unblockGeneratorUser,
  createGeneratorRequest,
  getGeneratorRequests,
  importGeneratorArtifact: (
    token: string,
    requestId: string,
    artifactId: string,
    payload: {
      mode: 'existing' | 'new';
      galleryId?: string;
      galleryTitle?: string;
      galleryDescription?: string | null;
      galleryVisibility?: 'public' | 'private';
      title?: string;
      note?: string;
    },
  ) =>
    request<GeneratorArtifactImportResult>(
      `/api/generator/requests/${requestId}/artifacts/${artifactId}/import`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),
  cancelGeneratorRequest,
  getAdminSettings,
  getMetadataThresholdPreview,
  triggerNsfwRescan,
  updateAdminSettings,
  getModelComments: (modelId: string, token?: string | null) =>
    request<{ comments: AssetComment[] }>(`/api/assets/models/${modelId}/comments`, {}, token ?? undefined).then(
      (response) => response.comments,
    ),
  createModelComment: (modelId: string, content: string, token: string) =>
    request<{ comment: AssetComment }>(
      `/api/assets/models/${modelId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      },
      token,
    ).then((response) => response.comment),
  likeModelComment: (modelId: string, commentId: string, token: string) =>
    request<{ comment: AssetComment }>(
      `/api/assets/models/${modelId}/comments/${commentId}/like`,
      { method: 'POST' },
      token,
    ).then((response) => response.comment),
  unlikeModelComment: (modelId: string, commentId: string, token: string) =>
    request<{ comment: AssetComment }>(
      `/api/assets/models/${modelId}/comments/${commentId}/like`,
      { method: 'DELETE' },
      token,
    ).then((response) => response.comment),
  getImageComments: (imageId: string, token?: string | null) =>
    request<{ comments: AssetComment[] }>(`/api/assets/images/${imageId}/comments`, {}, token ?? undefined).then(
      (response) => response.comments,
    ),
  createImageComment: (imageId: string, content: string, token: string) =>
    request<{ comment: AssetComment }>(
      `/api/assets/images/${imageId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      },
      token,
    ).then((response) => response.comment),
  likeImageComment: (imageId: string, commentId: string, token: string) =>
    request<{ comment: AssetComment }>(
      `/api/assets/images/${imageId}/comments/${commentId}/like`,
      { method: 'POST' },
      token,
    ).then((response) => response.comment),
  unlikeImageComment: (imageId: string, commentId: string, token: string) =>
    request<{ comment: AssetComment }>(
      `/api/assets/images/${imageId}/comments/${commentId}/like`,
      { method: 'DELETE' },
      token,
    ).then((response) => response.comment),
  likeImageAsset,
  unlikeImageAsset,
  login: (email: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, displayName: string, password: string) =>
    request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, displayName, password }),
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
  updateUser: (
    token: string,
    id: string,
    payload: Partial<{
      email: string;
      displayName: string;
      password: string;
      role: string;
      bio: string | null;
      isActive: boolean;
      showAdultContent: boolean;
    }>,
  ) =>
    request<{ user: User }>(
      `/api/users/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),
  updateOwnProfile: (
    token: string,
    id: string,
    payload: Partial<{ displayName: string; bio: string | null; showAdultContent: boolean }>,
  ) =>
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
  getAdultSafetyKeywords: (token: string) => request<{ keywords: AdultSafetyKeyword[] }>('/api/safety/keywords', {}, token),
  createAdultSafetyKeyword: (token: string, label: string) =>
    request<{ keyword: AdultSafetyKeyword }>(
      '/api/safety/keywords',
      {
        method: 'POST',
        body: JSON.stringify({ label }),
      },
      token,
    ),
  deleteAdultSafetyKeyword: (token: string, id: string) =>
    request<void>(
      `/api/safety/keywords/${id}`,
      {
        method: 'DELETE',
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
      trigger: string;
      tags: string[];
      ownerId: string;
      isPublic: boolean;
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
  flagModelAsset: (token: string, id: string, payload?: { reason?: string }) =>
    request<{ model: ModelAsset }>(
      `/api/assets/models/${id}/flag`,
      {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
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
      isPublic: boolean;
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
  flagImageAsset: (token: string, id: string, payload?: { reason?: string }) =>
    request<{ image: ImageAsset }>(
      `/api/assets/images/${id}/flag`,
      {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
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
  uploadGalleryCover: (token: string, id: string, file: File) => {
    const formData = new FormData();
    formData.append('cover', file, file.name);

    return request<Gallery>(
      `/api/galleries/${id}/cover`,
      {
        method: 'POST',
        body: formData,
      },
      token,
    );
  },
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
  getModerationQueue: (token: string) => request<ModerationQueue>(`/api/assets/moderation/queue`, {}, token),
  approveModelModeration: (token: string, id: string) =>
    request<{ model: ModelAsset }>(
      `/api/assets/models/${id}/moderation/approve`,
      { method: 'POST' },
      token,
    ),
  removeModelModeration: (token: string, id: string, payload?: { reason?: string }) =>
    request<{ removed: string }>(
      `/api/assets/models/${id}/moderation/remove`,
      {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      },
      token,
    ),
  approveImageModeration: (token: string, id: string) =>
    request<{ image: ImageAsset }>(
      `/api/assets/images/${id}/moderation/approve`,
      { method: 'POST' },
      token,
    ),
  removeImageModeration: (token: string, id: string, payload?: { reason?: string }) =>
    request<{ removed: string }>(
      `/api/assets/images/${id}/moderation/remove`,
      {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      },
      token,
    ),
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
