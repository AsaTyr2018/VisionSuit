import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '../lib/api';
import { resolveCachedStorageUrl, resolveStorageUrl } from '../lib/storage';
import type {
  Gallery,
  GeneratorAccessMode,
  GeneratorBaseModelConfig,
  GeneratorSettings,
  ImageAsset,
  ModelAsset,
  RankTier,
  RankingSettings,
  User,
} from '../types/api';
import { FilterChip } from './FilterChip';
import { ImageAssetEditDialog } from './ImageAssetEditDialog';
import { ModelAssetEditDialog } from './ModelAssetEditDialog';
import { ModelVersionDialog } from './ModelVersionDialog';
import { ModelVersionEditDialog } from './ModelVersionEditDialog';
import { UserCreationDialog, type AsyncActionResult } from './UserCreationDialog';

const roleSummaries: Record<
  User['role'],
  { title: string; headline: string; bullets: string[] }
> = {
  USER: {
    title: 'Member permissions',
    headline: 'Members explore curated content, download approved files, and react without upload rights.',
    bullets: [
      'Browse public galleries, LoRA models, and metadata safely.',
      'Download approved assets directly through the governed proxy.',
      'Engage with images by leaving likes while awaiting curator promotion.',
    ],
  },
  CURATOR: {
    title: 'Curator permissions',
    headline: 'Curators focus on creative intake and gallery management with safe defaults.',
    bullets: [
      'Upload LoRA safetensors and gallery imagery for review.',
      'Edit titles, descriptions, tags, and visibility on owned content.',
      'Collaborate on gallery curation without access to destructive admin tooling.',
    ],
  },
  ADMIN: {
    title: 'Admin permissions',
    headline: 'Admins unlock full governance across users, assets, and storage.',
    bullets: [
      'Provision, deactivate, or delete any account with bulk actions.',
      'Manage model, image, and gallery metadata platform-wide.',
      'Review storage objects and enforce retention policies when required.',
    ],
  },
};

const RoleSummaryDialog = ({ role, isOpen, onClose }: { role: User['role']; isOpen: boolean; onClose: () => void }) => {
  if (!isOpen) {
    return null;
  }

  const summary = roleSummaries[role] ?? roleSummaries.CURATOR;

  return (
    <div className="modal role-summary-dialog" role="dialog" aria-modal="true" aria-labelledby="role-summary-title">
      <div className="modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal__content modal__content--compact">
        <header className="modal__header">
          <h2 id="role-summary-title">{summary.title}</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>
        <div className="modal__body role-summary-dialog__body">
          <p className="role-summary-dialog__intro">{summary.headline}</p>
          <ul className="role-summary-dialog__list">
            {summary.bullets.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="modal__actions">
            <button type="button" className="button button--primary" onClick={onClose}>
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface AdminPanelProps {
  users: User[];
  models: ModelAsset[];
  images: ImageAsset[];
  galleries: Gallery[];
  token: string;
  onRefresh: () => Promise<void>;
  onOpenProfile?: (userId: string) => void;
  rankingSettings: RankingSettings | null;
  rankingTiers: RankTier[];
  rankingTiersFallback: boolean;
  generatorSettings: GeneratorSettings | null;
  onGeneratorSettingsUpdated?: (settings: GeneratorSettings) => void;
}

type AdminTab = 'users' | 'models' | 'images' | 'generator' | 'galleries' | 'ranking';

type FilterValue<T extends string> = T | 'all';

type UserStatusFilter = 'active' | 'inactive';

type VisibilityFilter = 'public' | 'private';

type TierDraft = {
  label: string;
  description: string;
  minimumScore: string;
  position: string;
  isActive: boolean;
};

type ModelVersionEntry = ModelAsset['versions'][number];

const generatorBaseModelTypeOptions: GeneratorBaseModelConfig['type'][] = ['SD1.5', 'SDXL', 'PonyXL'];

const normalizeGeneratorBaseModel = (entry: GeneratorBaseModelConfig): GeneratorBaseModelConfig => ({
  type: entry.type,
  name: entry.name.trim(),
  filename: entry.filename.trim(),
});

const matchText = (value: string | null | undefined, query: string) => {
  if (!query) {
    return true;
  }

  return (value ?? '').toLowerCase().includes(query.toLowerCase());
};

const getTagLabels = (tags: { label: string }[]) => tags.map((tag) => tag.label.toLowerCase());

const collectModelMetadataStrings = (metadata?: Record<string, unknown> | null) => {
  if (!metadata) {
    return [] as string[];
  }

  const record = metadata as Record<string, unknown>;
  const values = new Set<string>();

  const addValue = (value: unknown) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        values.add(trimmed);
      }
    } else if (Array.isArray(value)) {
      value.forEach(addValue);
    }
  };

  addValue(record['baseModel']);
  addValue(record['modelName']);
  addValue(record['model']);
  addValue(record['models']);
  addValue(record['modelAliases']);

  const extracted = record['extracted'];
  if (extracted && typeof extracted === 'object') {
    const nested = extracted as Record<string, unknown>;
    addValue(nested['ss_base_model']);
    addValue(nested['sshs_model_name']);
    addValue(nested['base_model']);
    addValue(nested['model']);
    addValue(nested['model_name']);
  }

  return Array.from(values);
};

const collectImageMetadataStrings = (metadata?: ImageAsset['metadata']) => {
  if (!metadata) {
    return [] as string[];
  }

  const values = new Set<string>();
  if (metadata.model) values.add(metadata.model);
  if (metadata.sampler) values.add(metadata.sampler);
  if (metadata.seed) values.add(metadata.seed);
  return Array.from(values);
};

const formatFileSize = (bytes?: number | null) => {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes <= 0) {
    return null;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[exponent]}`;
};

const truncateText = (value: string, limit = 160) => {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1).trimEnd()}…`;
};

const buildModelDetail = (model: ModelAsset) => {
  const previewUrl =
    resolveCachedStorageUrl(
      model.previewImage,
      model.previewImageBucket,
      model.previewImageObject,
      { updatedAt: model.updatedAt, cacheKey: model.id },
    ) ?? model.previewImage ?? null;
  const downloadUrl =
    resolveStorageUrl(model.storagePath, model.storageBucket, model.storageObject) ?? model.storagePath;
  const updatedLabel = new Date(model.updatedAt).toLocaleDateString('en-US');
  const fileSizeLabel = formatFileSize(model.fileSize);
  const metadataEntries = [
    { label: 'Slug', value: model.slug },
    model.storageBucket ? { label: 'Bucket', value: model.storageBucket } : null,
    {
      label: 'Storage object',
      value: model.storageObject ?? model.storagePath,
      href: downloadUrl,
    },
    { label: 'Checksum', value: model.checksum ?? '—' },
  ].filter((entry): entry is { label: string; value: string; href?: string } => Boolean(entry));

  return { previewUrl, downloadUrl, updatedLabel, fileSizeLabel, metadataEntries };
};

const buildImageDetail = (image: ImageAsset) => {
  const previewUrl =
    resolveCachedStorageUrl(image.storagePath, image.storageBucket, image.storageObject, {
      updatedAt: image.updatedAt,
      cacheKey: image.id,
    }) ?? image.storagePath;
  const downloadUrl =
    resolveStorageUrl(image.storagePath, image.storageBucket, image.storageObject) ?? image.storagePath;
  const updatedLabel = new Date(image.updatedAt).toLocaleDateString('en-US');
  const fileSizeLabel = formatFileSize(image.fileSize);
  const dimensionsLabel = image.dimensions ? `${image.dimensions.width}×${image.dimensions.height}` : null;

  return { previewUrl, downloadUrl, updatedLabel, fileSizeLabel, dimensionsLabel };
};

export const AdminPanel = ({
  users,
  models,
  images,
  galleries,
  token,
  onRefresh,
  onOpenProfile,
  rankingSettings,
  rankingTiers,
  rankingTiersFallback,
  generatorSettings,
  onGeneratorSettingsUpdated,
}: AdminPanelProps) => {
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isCreateUserDialogOpen, setIsCreateUserDialogOpen] = useState(false);
  const [userDialogInitialRole, setUserDialogInitialRole] = useState<User['role']>('CURATOR');
  const [roleSummary, setRoleSummary] = useState<User['role'] | null>(null);

  const [userFilter, setUserFilter] = useState<{ query: string; role: FilterValue<User['role']>; status: FilterValue<UserStatusFilter> }>(
    { query: '', role: 'all', status: 'all' },
  );
  const [modelFilter, setModelFilter] = useState<{
    query: string;
    owner: FilterValue<string>;
    tag: string;
    metadata: string;
    visibility: FilterValue<VisibilityFilter>;
    sort: 'updated_desc' | 'title_asc' | 'owner_asc';
  }>({
    query: '',
    owner: 'all',
    tag: '',
    metadata: '',
    visibility: 'all',
    sort: 'updated_desc',
  });
  const [imageFilter, setImageFilter] = useState<{
    query: string;
    owner: FilterValue<string>;
    metadata: string;
    visibility: FilterValue<VisibilityFilter>;
    sort: 'updated_desc' | 'title_asc' | 'owner_asc';
  }>({
    query: '',
    owner: 'all',
    metadata: '',
    visibility: 'all',
    sort: 'updated_desc',
  });
  const [galleryFilter, setGalleryFilter] = useState<{
    query: string;
    owner: FilterValue<string>;
    visibility: FilterValue<VisibilityFilter>;
  }>({ query: '', owner: 'all', visibility: 'all' });

  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);
  const [modelDensity, setModelDensity] = useState<'comfortable' | 'compact'>('compact');
  const [imageDensity, setImageDensity] = useState<'comfortable' | 'compact'>('compact');
  const [modelToEdit, setModelToEdit] = useState<ModelAsset | null>(null);
  const [imageToEdit, setImageToEdit] = useState<ImageAsset | null>(null);
  const [modelForVersionUpload, setModelForVersionUpload] = useState<ModelAsset | null>(null);
  const [modelVersionToEdit, setModelVersionToEdit] = useState<{ model: ModelAsset; version: ModelVersionEntry } | null>(null);
  const [weightDraft, setWeightDraft] = useState<{ modelWeight: string; galleryWeight: string; imageWeight: string }>({
    modelWeight: '',
    galleryWeight: '',
    imageWeight: '',
  });
  const [tierDrafts, setTierDrafts] = useState<Record<string, TierDraft>>({});
  const [newTierDraft, setNewTierDraft] = useState<TierDraft>({
    label: '',
    description: '',
    minimumScore: '0',
    position: '',
    isActive: true,
  });
  const [rankingUserId, setRankingUserId] = useState('');
  const generatorAccessModeFromSettings = generatorSettings?.accessMode ?? 'ADMIN_ONLY';
  const generatorBaseModelsFromSettings = useMemo(
    () => (generatorSettings?.baseModels ?? []).map((entry) => ({ ...entry })),
    [generatorSettings?.baseModels],
  );
  const [generatorAccessMode, setGeneratorAccessMode] = useState<GeneratorAccessMode>(
    generatorAccessModeFromSettings,
  );
  const [baseModelDrafts, setBaseModelDrafts] = useState<GeneratorBaseModelConfig[]>(
    generatorBaseModelsFromSettings,
  );
  const [isSavingGeneratorSettings, setIsSavingGeneratorSettings] = useState(false);
  const [generatorSettingsError, setGeneratorSettingsError] = useState<string | null>(null);

  useEffect(() => {
    setGeneratorAccessMode((current) =>
      current === generatorAccessModeFromSettings ? current : generatorAccessModeFromSettings,
    );
  }, [generatorAccessModeFromSettings]);

  useEffect(() => {
    setBaseModelDrafts(generatorBaseModelsFromSettings);
  }, [generatorBaseModelsFromSettings]);

  const normalizedSettingsBaseModels = useMemo(
    () => generatorBaseModelsFromSettings.map(normalizeGeneratorBaseModel),
    [generatorBaseModelsFromSettings],
  );
  const normalizedBaseModelDrafts = useMemo(
    () => baseModelDrafts.map(normalizeGeneratorBaseModel),
    [baseModelDrafts],
  );

  const isGeneratorDirty =
    generatorAccessMode !== generatorAccessModeFromSettings ||
    JSON.stringify(normalizedBaseModelDrafts) !== JSON.stringify(normalizedSettingsBaseModels);

  const userOptions = useMemo(() => users.map((user) => ({ id: user.id, label: user.displayName })), [users]);

  useEffect(() => {
    if (rankingSettings) {
      setWeightDraft({
        modelWeight: rankingSettings.modelWeight.toString(),
        galleryWeight: rankingSettings.galleryWeight.toString(),
        imageWeight: rankingSettings.imageWeight.toString(),
      });
    } else {
      setWeightDraft({ modelWeight: '', galleryWeight: '', imageWeight: '' });
    }
  }, [rankingSettings]);

  useEffect(() => {
    const drafts: Record<string, TierDraft> = {};
    rankingTiers.forEach((tier) => {
      if (!tier.id) {
        return;
      }

      drafts[tier.id] = {
        label: tier.label,
        description: tier.description,
        minimumScore: tier.minimumScore.toString(),
        position:
          tier.position !== undefined && tier.position !== null ? String(tier.position) : '',
        isActive: tier.isActive ?? true,
      };
    });
    setTierDrafts(drafts);
  }, [rankingTiers]);

  const resetStatus = () => setStatus(null);

  const handleAddBaseModel = () => {
    setBaseModelDrafts((current) => [...current, { type: 'SD1.5', name: '', filename: '' }]);
    setGeneratorSettingsError(null);
    resetStatus();
  };

  const handleRemoveBaseModel = (index: number) => {
    setBaseModelDrafts((current) => current.filter((_, idx) => idx !== index));
    setGeneratorSettingsError(null);
    resetStatus();
  };

  const handleBaseModelFieldChange = (
    index: number,
    field: keyof GeneratorBaseModelConfig,
    value: string,
  ) => {
    setBaseModelDrafts((current) =>
      current.map((entry, idx) => {
        if (idx !== index) {
          return entry;
        }

        if (field === 'type') {
          return { ...entry, type: value as GeneratorBaseModelConfig['type'] };
        }

        return { ...entry, [field]: value };
      }),
    );
    setGeneratorSettingsError(null);
    resetStatus();
  };

  const handleGeneratorAccessChange = (mode: GeneratorAccessMode) => {
    setGeneratorAccessMode(mode);
    setGeneratorSettingsError(null);
    resetStatus();
  };

  const handleResetGeneratorAccess = () => {
    setGeneratorAccessMode(generatorAccessModeFromSettings);
    setBaseModelDrafts(generatorBaseModelsFromSettings);
    setGeneratorSettingsError(null);
    resetStatus();
  };

  const handleGeneratorSettingsSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isGeneratorDirty) {
      setStatus({ type: 'success', message: 'Generator visibility already matches the stored configuration.' });
      return;
    }

    if (normalizedBaseModelDrafts.length === 0) {
      setGeneratorSettingsError('Add at least one base model entry before saving.');
      return;
    }

    if (normalizedBaseModelDrafts.some((entry) => entry.name.length === 0 || entry.filename.length === 0)) {
      setGeneratorSettingsError('Provide a name and filename for every base model entry.');
      return;
    }

    try {
      setIsSavingGeneratorSettings(true);
      setGeneratorSettingsError(null);
      resetStatus();
      const updated = await api.updateGeneratorSettings(token, {
        accessMode: generatorAccessMode,
        baseModels: normalizedBaseModelDrafts,
      });
      setBaseModelDrafts(updated.baseModels.map((entry) => ({ ...entry })));
      setStatus({ type: 'success', message: 'On-Site Generator visibility updated successfully.' });
      onGeneratorSettingsUpdated?.(updated);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to update generator settings.';
      setGeneratorSettingsError(message);
      setStatus({ type: 'error', message });
    } finally {
      setIsSavingGeneratorSettings(false);
    }
  };

  const withStatus = async <T,>(
    action: () => Promise<T>,
    successMessage: string,
  ): Promise<AsyncActionResult> => {
    resetStatus();
    setIsBusy(true);
    try {
      await action();
      setStatus({ type: 'success', message: successMessage });
      await onRefresh();
      return { ok: true };
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Action failed.';
      if (error instanceof ApiError && error.details?.length) {
        message = `${message} ${error.details.join(' ')}`.trim();
      }
      setStatus({ type: 'error', message });
      return { ok: false, message };
    } finally {
      setIsBusy(false);
    }
  };

  const handleCreateUser = async (payload: {
    email: string;
    displayName: string;
    password: string;
    role: User['role'];
    bio?: string;
  }) => {
    const result = await withStatus(
      () =>
        api
          .createUser(token, {
            email: payload.email,
            displayName: payload.displayName,
            password: payload.password,
            role: payload.role,
            bio: payload.bio,
          })
          .then(() => undefined),
      'User account created.',
    );

    if (result.ok) {
      setIsCreateUserDialogOpen(false);
    }

    return result;
  };

  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      const matchesQuery =
        matchText(user.displayName, userFilter.query) ||
        matchText(user.email, userFilter.query) ||
        matchText(user.bio ?? '', userFilter.query);

      if (!matchesQuery) {
        return false;
      }

      if (userFilter.role !== 'all' && user.role !== userFilter.role) {
        return false;
      }

      if (userFilter.status !== 'all') {
        const isActive = user.isActive !== false;
        if (userFilter.status === 'active' && !isActive) {
          return false;
        }
        if (userFilter.status === 'inactive' && isActive) {
          return false;
        }
      }

      return true;
    });
  }, [users, userFilter]);

  const modelMetadataOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    models.forEach((model) => {
      collectModelMetadataStrings(model.metadata).forEach((entry) => {
        const normalized = entry.trim();
        if (!normalized) {
          return;
        }
        const key = normalized.toLowerCase();
        const existing = counts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(key, { label: normalized, count: 1 });
        }
      });
    });

    return Array.from(counts.values())
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.label.localeCompare(b.label);
      })
      .slice(0, 12);
  }, [models]);

  const filteredModels = useMemo(() => {
    const tagQuery = modelFilter.tag.trim().toLowerCase();
    const metadataQuery = modelFilter.metadata.trim().toLowerCase();
    const searchQuery = modelFilter.query.trim();

    const filtered = models.filter((model) => {
      const metadataValues = collectModelMetadataStrings(model.metadata);
      const matchesSearch =
        searchQuery.length === 0 ||
        matchText(model.title, searchQuery) ||
        matchText(model.description ?? '', searchQuery) ||
        matchText(model.version, searchQuery) ||
        matchText(model.owner.displayName, searchQuery) ||
        matchText(model.trigger ?? '', searchQuery) ||
        metadataValues.some((value) => matchText(value, searchQuery));

      if (!matchesSearch) {
        return false;
      }

      if (modelFilter.owner !== 'all' && model.owner.id !== modelFilter.owner) {
        return false;
      }

      if (tagQuery && !getTagLabels(model.tags).some((tag) => tag.includes(tagQuery))) {
        return false;
      }

      if (metadataQuery && !metadataValues.some((value) => value.toLowerCase().includes(metadataQuery))) {
        return false;
      }

      if (modelFilter.visibility !== 'all') {
        const visibility = model.isPublic ? 'public' : 'private';
        if (visibility !== modelFilter.visibility) {
          return false;
        }
      }

      return true;
    });

    const sorted = [...filtered];
    if (modelFilter.sort === 'title_asc') {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (modelFilter.sort === 'owner_asc') {
      sorted.sort((a, b) => a.owner.displayName.localeCompare(b.owner.displayName));
    } else {
      sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    return sorted;
  }, [models, modelFilter]);

  useEffect(() => {
    if (!expandedModelId) {
      return;
    }

    const isVisible = filteredModels.some((model) => model.id === expandedModelId);
    if (!isVisible) {
      setExpandedModelId(null);
    }
  }, [expandedModelId, filteredModels]);

  const imageMetadataOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    images.forEach((image) => {
      collectImageMetadataStrings(image.metadata).forEach((entry) => {
        const normalized = entry.trim();
        if (!normalized) {
          return;
        }
        const key = normalized.toLowerCase();
        const existing = counts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(key, { label: normalized, count: 1 });
        }
      });
    });

    return Array.from(counts.values())
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.label.localeCompare(b.label);
      })
      .slice(0, 12);
  }, [images]);

  const filteredImages = useMemo(() => {
    const metadataQuery = imageFilter.metadata.trim().toLowerCase();
    const searchQuery = imageFilter.query.trim();

    const filtered = images.filter((image) => {
      const metadataValues = collectImageMetadataStrings(image.metadata);
      const matchesSearch =
        searchQuery.length === 0 ||
        matchText(image.title, searchQuery) ||
        matchText(image.description ?? '', searchQuery) ||
        matchText(image.prompt ?? '', searchQuery) ||
        matchText(image.negativePrompt ?? '', searchQuery) ||
        matchText(image.owner.displayName, searchQuery) ||
        metadataValues.some((value) => matchText(value, searchQuery)) ||
        image.tags.some((tag) => matchText(tag.label, searchQuery));

      if (!matchesSearch) {
        return false;
      }

      if (imageFilter.owner !== 'all' && image.owner.id !== imageFilter.owner) {
        return false;
      }

      if (metadataQuery && !metadataValues.some((value) => value.toLowerCase().includes(metadataQuery))) {
        return false;
      }

      if (imageFilter.visibility !== 'all') {
        const visibility = image.isPublic ? 'public' : 'private';
        if (visibility !== imageFilter.visibility) {
          return false;
        }
      }

      return true;
    });

    const sorted = [...filtered];
    if (imageFilter.sort === 'title_asc') {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (imageFilter.sort === 'owner_asc') {
      sorted.sort((a, b) => a.owner.displayName.localeCompare(b.owner.displayName));
    } else {
      sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    return sorted;
  }, [images, imageFilter]);

  useEffect(() => {
    if (!expandedImageId) {
      return;
    }

    const isVisible = filteredImages.some((image) => image.id === expandedImageId);
    if (!isVisible) {
      setExpandedImageId(null);
    }
  }, [expandedImageId, filteredImages]);

  const filteredGalleries = useMemo(() => {
    return galleries.filter((gallery) => {
      const metadataMatches =
        galleryFilter.query.trim().length > 0 &&
        gallery.entries.some((entry) => {
          const modelMatches = collectModelMetadataStrings(entry.modelAsset?.metadata as Record<string, unknown> | null).some(
            (value) => matchText(value, galleryFilter.query),
          );

          const imageMatches = collectImageMetadataStrings(entry.imageAsset?.metadata).some((value) =>
            matchText(value, galleryFilter.query),
          );

          return modelMatches || imageMatches;
        });

      const matchesQuery =
        matchText(gallery.title, galleryFilter.query) ||
        matchText(gallery.slug, galleryFilter.query) ||
        matchText(gallery.description ?? '', galleryFilter.query) ||
        metadataMatches;

      if (!matchesQuery) {
        return false;
      }

      if (galleryFilter.owner !== 'all' && gallery.owner.id !== galleryFilter.owner) {
        return false;
      }

      if (galleryFilter.visibility !== 'all') {
        const isPublic = gallery.isPublic ? 'public' : 'private';
        if (isPublic !== galleryFilter.visibility) {
          return false;
        }
      }

      return true;
    });
  }, [galleries, galleryFilter]);

  const toggleSelection = (setter: Dispatch<SetStateAction<Set<string>>>, id: string, checked: boolean) => {
    setter((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const toggleSelectAll = (setter: Dispatch<SetStateAction<Set<string>>>, ids: string[], checked: boolean) => {
    setter(() => {
      if (!checked) {
        return new Set<string>();
      }
      return new Set(ids);
    });
  };

  const handleUpdateUser = async (event: FormEvent<HTMLFormElement>, userId: string) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const displayName = (formData.get('displayName') as string | null)?.trim();
    const role = (formData.get('role') as string | null) ?? undefined;
    const bio = (formData.get('bio') as string | null)?.trim();
    const password = (formData.get('password') as string | null)?.trim();
    const isActive = formData.get('isActive') === 'on';

    const payload: Record<string, unknown> = {
      displayName: displayName ?? undefined,
      role,
      bio: bio && bio.length > 0 ? bio : null,
      isActive,
    };

    if (password && password.length > 0) {
      payload.password = password;
    }

    await withStatus(
      () =>
        api.updateUser(token, userId, payload).then(() => {
          const passwordField = event.currentTarget.querySelector<HTMLInputElement>('input[name="password"]');
          if (passwordField) {
            passwordField.value = '';
          }
        }),
      'User details updated.',
    );
  };

  const handleDeleteUser = async (userId: string) => {
    if (!window.confirm('Are you sure you want to delete this account?')) {
      return;
    }

    await withStatus(() => api.deleteUser(token, userId), 'User account deleted.');
    setSelectedUsers((previous) => {
      const next = new Set(previous);
      next.delete(userId);
      return next;
    });
  };

  const handleBulkDeleteUsers = async () => {
    const ids = Array.from(selectedUsers);
    if (ids.length === 0) {
      return;
    }
    if (!window.confirm(`Delete ${ids.length} accounts?`)) {
      return;
    }

    await withStatus(
      () =>
        api.bulkDeleteUsers(token, ids).then(() => {
          setSelectedUsers(new Set());
        }),
      `${ids.length} accounts removed.`,
    );
  };

  const handlePromoteModelVersion = async (model: ModelAsset, version: ModelAsset['versions'][number]) => {
    const label = version.version.trim() || 'this version';
    if (!window.confirm(`Make ${label} the primary version for ${model.title}?`)) {
      return;
    }

    await withStatus(
      () => api.promoteModelVersion(token, model.id, version.id).then(() => undefined),
      'Primary version updated.',
    );
  };

  const handleDeleteModelVersion = async (model: ModelAsset, version: ModelAsset['versions'][number]) => {
    const label = version.version.trim() || 'this version';
    if (!window.confirm(`Delete ${label} from ${model.title}?`)) {
      return;
    }

    await withStatus(
      () => api.deleteModelVersion(token, model.id, version.id).then(() => undefined),
      'Version deleted.',
    );
  };

  const handleBulkDeleteModels = async () => {
    const ids = Array.from(selectedModels);
    if (ids.length === 0) {
      return;
    }

    if (!window.confirm(`Delete ${ids.length} models?`)) {
      return;
    }

    await withStatus(
      () =>
        api.bulkDeleteModelAssets(token, ids).then(() => {
          setSelectedModels(new Set());
        }),
      `${ids.length} models removed.`,
    );
    setExpandedModelId((previous) => {
      if (!previous) {
        return previous;
      }
      return ids.includes(previous) ? null : previous;
    });
  };

  const handleDeleteModel = async (model: ModelAsset) => {
    if (!window.confirm(`Delete model "${model.title}"?`)) {
      return;
    }

    await withStatus(() => api.deleteModelAsset(token, model.id), 'Model deleted.');
    setSelectedModels((previous) => {
      const next = new Set(previous);
      next.delete(model.id);
      return next;
    });
    setExpandedModelId((previous) => (previous === model.id ? null : previous));
  };

  const handleOpenModelEdit = (model: ModelAsset) => {
    setModelToEdit(model);
    resetStatus();
  };

  const handleModelEditSuccess = async (updated: ModelAsset) => {
    setStatus({ type: 'success', message: 'Model details updated.' });
    await onRefresh();
    setExpandedModelId((previous) => previous ?? updated.id);
  };

  const handleOpenVersionUpload = (model: ModelAsset) => {
    setModelForVersionUpload(model);
    resetStatus();
  };

  const handleVersionUploadSuccess = async (updated: ModelAsset) => {
    setStatus({ type: 'success', message: 'New model version uploaded.' });
    await onRefresh();
    setExpandedModelId(updated.id);
  };

  const handleOpenVersionRename = (model: ModelAsset, version: ModelVersionEntry) => {
    setModelVersionToEdit({ model, version });
    resetStatus();
  };

  const handleVersionRenameSuccess = async (updated: ModelAsset) => {
    setStatus({ type: 'success', message: 'Version label updated.' });
    await onRefresh();
    setExpandedModelId(updated.id);
  };

  const handleOpenImageEdit = (image: ImageAsset) => {
    setImageToEdit(image);
    resetStatus();
  };

  const handleImageEditSuccess = async () => {
    setStatus({ type: 'success', message: 'Image details updated.' });
    await onRefresh();
  };

  const handleDeleteImage = async (image: ImageAsset) => {
    if (!window.confirm(`Delete image "${image.title}"?`)) {
      return;
    }

    await withStatus(() => api.deleteImageAsset(token, image.id), 'Image deleted.');
    setSelectedImages((previous) => {
      const next = new Set(previous);
      next.delete(image.id);
      return next;
    });
    setExpandedImageId((previous) => (previous === image.id ? null : previous));
  };

  const handleBulkDeleteImages = async () => {
    const ids = Array.from(selectedImages);
    if (ids.length === 0) {
      return;
    }

    if (!window.confirm(`Delete ${ids.length} images?`)) {
      return;
    }

    await withStatus(
      () =>
        api.bulkDeleteImageAssets(token, ids).then(() => {
          setSelectedImages(new Set());
          setExpandedImageId(null);
        }),
      `${ids.length} images removed.`,
    );
  };

  const handleUpdateGallery = async (event: FormEvent<HTMLFormElement>, gallery: Gallery) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const title = (formData.get('title') as string | null)?.trim();
    const description = (formData.get('description') as string | null)?.trim();
    const ownerId = (formData.get('ownerId') as string | null) ?? gallery.owner.id;
    const visibility = (formData.get('visibility') as string | null) ?? 'public';
    const coverImageRaw = (formData.get('coverImage') as string | null) ?? '';

    const entriesPayload: { id: string; position: number; note?: string | null }[] = [];
    const removeEntryIds: string[] = [];

    gallery.entries.forEach((entry) => {
      const remove = formData.get(`entry-${entry.id}-remove`) === 'on';
      if (remove) {
        removeEntryIds.push(entry.id);
        return;
      }

      const positionValue = (formData.get(`entry-${entry.id}-position`) as string | null) ?? '';
      const noteValue = (formData.get(`entry-${entry.id}-note`) as string | null)?.trim() ?? '';
      const position = Number.parseInt(positionValue, 10);

      entriesPayload.push({
        id: entry.id,
        position: Number.isNaN(position) ? entry.position : position,
        note: noteValue.length > 0 ? noteValue : null,
      });
    });

    const payload = {
      title: title ?? undefined,
      description: description && description.length > 0 ? description : null,
      ownerId,
      isPublic: visibility === 'public',
      coverImage: coverImageRaw.trim().length > 0 ? coverImageRaw.trim() : null,
      entries: entriesPayload.length > 0 ? entriesPayload : undefined,
      removeEntryIds: removeEntryIds.length > 0 ? removeEntryIds : undefined,
    };

    await withStatus(() => api.updateGallery(token, gallery.id, payload), 'Gallery updated.');
  };

  const handleDeleteGallery = async (gallery: Gallery) => {
    if (!window.confirm(`Delete gallery "${gallery.title}"?`)) {
      return;
    }

    await withStatus(() => api.deleteGallery(token, gallery.id), 'Gallery deleted.');
  };

  const handleRankingSettingsSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const modelWeight = Number.parseInt(weightDraft.modelWeight, 10);
    const galleryWeight = Number.parseInt(weightDraft.galleryWeight, 10);
    const imageWeight = Number.parseInt(weightDraft.imageWeight, 10);

    if (
      [modelWeight, galleryWeight, imageWeight].some(
        (value) => Number.isNaN(value) || value < 0 || !Number.isFinite(value),
      )
    ) {
      setStatus({ type: 'error', message: 'Ranking weights must be non-negative integers.' });
      return;
    }

    await withStatus(
      () => api.updateRankingSettings(token, { modelWeight, galleryWeight, imageWeight }),
      'Ranking weights updated.',
    );
  };

  const updateTierDraft = (id: string, updates: Partial<TierDraft>) => {
    setTierDrafts((current) => ({
      ...current,
      [id]: {
        label: current[id]?.label ?? '',
        description: current[id]?.description ?? '',
        minimumScore: current[id]?.minimumScore ?? '0',
        position: current[id]?.position ?? '',
        isActive: current[id]?.isActive ?? true,
        ...updates,
      },
    }));
  };

  const handleTierUpdate = async (event: FormEvent<HTMLFormElement>, tierId: string) => {
    event.preventDefault();
    const draft = tierDrafts[tierId];
    if (!draft) {
      setStatus({ type: 'error', message: 'Unable to locate tier draft for update.' });
      return;
    }

    const label = draft.label.trim();
    const description = draft.description.trim();
    const minimumScore = Number.parseInt(draft.minimumScore, 10);
    const positionValue = draft.position.trim();
    const position = positionValue.length > 0 ? Number.parseInt(positionValue, 10) : undefined;

    if (!label || !description) {
      setStatus({ type: 'error', message: 'Tier label and description cannot be empty.' });
      return;
    }

    if (Number.isNaN(minimumScore) || minimumScore < 0) {
      setStatus({ type: 'error', message: 'Tier minimum score must be a non-negative integer.' });
      return;
    }

    if (position !== undefined && (Number.isNaN(position) || position < 0)) {
      setStatus({ type: 'error', message: 'Tier position must be a non-negative integer when provided.' });
      return;
    }

    await withStatus(
      () =>
        api.updateRankTier(token, tierId, {
          label,
          description,
          minimumScore,
          position,
          isActive: draft.isActive,
        }),
      'Rank tier updated.',
    );
  };

  const handleTierDelete = async (tier: RankTier) => {
    if (!tier.id) {
      return;
    }

    if (!window.confirm(`Delete the "${tier.label}" tier? This cannot be undone.`)) {
      return;
    }

    const tierId = tier.id;
    await withStatus(() => api.deleteRankTier(token, tierId), 'Rank tier deleted.');
  };

  const handleCreateTier = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = newTierDraft.label.trim();
    const description = newTierDraft.description.trim();
    const minimumScore = Number.parseInt(newTierDraft.minimumScore, 10);
    const positionValue = newTierDraft.position.trim();
    const position = positionValue.length > 0 ? Number.parseInt(positionValue, 10) : undefined;

    if (!label || !description) {
      setStatus({ type: 'error', message: 'Tier label and description cannot be empty.' });
      return;
    }

    if (Number.isNaN(minimumScore) || minimumScore < 0) {
      setStatus({ type: 'error', message: 'Tier minimum score must be a non-negative integer.' });
      return;
    }

    if (position !== undefined && (Number.isNaN(position) || position < 0)) {
      setStatus({ type: 'error', message: 'Tier position must be a non-negative integer when provided.' });
      return;
    }

    const result = await withStatus(
      () =>
        api.createRankTier(token, {
          label,
          description,
          minimumScore,
          position,
          isActive: newTierDraft.isActive,
        }),
      'New rank tier added.',
    );

    if (result.ok) {
      setNewTierDraft({ label: '', description: '', minimumScore: '0', position: '', isActive: true });
    }
  };

  const handleRankingUserAction = async (action: 'reset' | 'block' | 'unblock') => {
    const trimmedId = rankingUserId.trim();
    if (!trimmedId) {
      setStatus({ type: 'error', message: 'Select a user before running ranking actions.' });
      return;
    }

    const friendlyName = users.find((user) => user.id === trimmedId)?.displayName ?? trimmedId;
    const successMessage =
      action === 'reset'
        ? `Ranking progress reset for ${friendlyName}.`
        : action === 'block'
        ? `${friendlyName} has been blocked from the ranking.`
        : `${friendlyName} has been restored to the ranking.`;

    const result = await withStatus(() => {
      if (action === 'reset') {
        return api.resetRankingUser(token, trimmedId);
      }

      if (action === 'block') {
        return api.blockRankingUser(token, trimmedId);
      }

      return api.unblockRankingUser(token, trimmedId);
    }, successMessage);

    if (result.ok) {
      setRankingUserId('');
    }
  };

  const renderSelectionToolbar = (
    total: number,
    selected: number,
    onSelectAll: (checked: boolean) => void,
    onClear: () => void,
    onBulkDelete: () => void,
  ) => (
    <div className="admin__toolbar">
      <div className="admin__selection">
        <label className="admin__checkbox" aria-label="Select all">
          <input
            type="checkbox"
            checked={selected > 0 && selected === total && total > 0}
            onChange={(event) => onSelectAll(event.currentTarget.checked)}
            disabled={total === 0 || isBusy}
          />
          <span>All</span>
        </label>
        <span className="admin__selection-count">{selected} selected</span>
        <button type="button" className="button" onClick={onClear} disabled={selected === 0 || isBusy}>
          Clear selection
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={onBulkDelete}
          disabled={selected === 0 || isBusy}
        >
          Delete selected
        </button>
      </div>
    </div>
  );

  const hasRankingUserSelection = rankingUserId.trim().length > 0;

  return (
    <section className="admin">
      <header className="admin__header">
        <nav className="admin__tabs" aria-label="Administration Tabs">
          {(
            [
              { id: 'users', label: 'User' },
              { id: 'models', label: 'Models' },
              { id: 'images', label: 'Images' },
              { id: 'generator', label: 'Generator' },
              { id: 'ranking', label: 'Ranking' },
              { id: 'galleries', label: 'Galleries' },
            ] as { id: AdminTab; label: string }[]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`admin__tab${activeTab === tab.id ? ' admin__tab--active' : ''}`}
              onClick={() => {
                setActiveTab(tab.id);
                resetStatus();
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        {status ? <p className={`admin__status admin__status--${status.type}`}>{status.message}</p> : null}
      </header>

      {activeTab === 'users' ? (
        <div className="admin__panel">
          <section className="admin__section admin__section--onboarding">
            <div className="admin__section-intro">
              <h3>Invite new teammates</h3>
              <p>
                Launch the guided dialog to collect essentials in focused steps. Presets prefill permissions while leaving every
                detail editable.
              </p>
            </div>
            <div className="user-onboarding-grid">
              <article className="user-onboarding-card">
                <header>
                  <h4>Member preset</h4>
                  <p>For community accounts that react and download without uploading content.</p>
                </header>
                <ul className="user-onboarding-list">
                  <li>Explore public galleries, models, and curator profiles.</li>
                  <li>Download approved assets through the secured storage proxy.</li>
                  <li>Engage with collections by leaving likes on favorite images.</li>
                </ul>
                <div className="user-onboarding-actions">
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => {
                      setUserDialogInitialRole('USER');
                      setIsCreateUserDialogOpen(true);
                    }}
                    disabled={isBusy}
                  >
                    Create member account
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setRoleSummary('USER')}
                  >
                    Quick preview
                  </button>
                </div>
              </article>
              <article className="user-onboarding-card">
                <header>
                  <h4>Curator preset</h4>
                  <p>For artists and moderators who manage uploads, tags, and galleries.</p>
                </header>
                <ul className="user-onboarding-list">
                  <li>Upload LoRA models and gallery images</li>
                  <li>Curate collections with tagging and visibility controls</li>
                  <li>Safe by default—no destructive admin tooling</li>
                </ul>
                <div className="user-onboarding-actions">
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => {
                      setUserDialogInitialRole('CURATOR');
                      setIsCreateUserDialogOpen(true);
                    }}
                    disabled={isBusy}
                  >
                    Create curator account
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setRoleSummary('CURATOR')}
                  >
                    Quick preview
                  </button>
                </div>
              </article>
              <article className="user-onboarding-card">
                <header>
                  <h4>Admin preset</h4>
                  <p>Equip trusted operators with end-to-end governance and rollout tooling.</p>
                </header>
                <ul className="user-onboarding-list">
                  <li>Full access to user, model, gallery, and storage management</li>
                  <li>Bulk actions for account cleanup and content governance</li>
                  <li>Ideal for platform leads and incident response teams</li>
                </ul>
                <div className="user-onboarding-actions">
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => {
                      setUserDialogInitialRole('ADMIN');
                      setIsCreateUserDialogOpen(true);
                    }}
                    disabled={isBusy}
                  >
                    Create admin account
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setRoleSummary('ADMIN')}
                  >
                    Review permissions
                  </button>
                </div>
              </article>
            </div>
            <p className="user-onboarding-footnote">
              Need something custom? Start with any preset and adjust fields directly inside the dialog-driven workflow.
            </p>
          </section>
          <UserCreationDialog
            isOpen={isCreateUserDialogOpen}
            onClose={() => setIsCreateUserDialogOpen(false)}
            onSubmit={handleCreateUser}
            isSubmitting={isBusy}
            initialRole={userDialogInitialRole}
          />
          <RoleSummaryDialog
            role={roleSummary ?? 'CURATOR'}
            isOpen={roleSummary !== null}
            onClose={() => setRoleSummary(null)}
          />

          <section className="admin__section">
            <div className="admin__section-header">
              <h3>Manage users</h3>
              <div className="admin__filters">
                <label>
                  <span>Search</span>
                  <input
                    type="search"
                    value={userFilter.query}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setUserFilter((previous) => ({ ...previous, query: value }));
                    }}
                    placeholder="Name, email, or bio"
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Role</span>
                  <select
                    value={userFilter.role}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setUserFilter((previous) => ({ ...previous, role: value as FilterValue<User['role']> }));
                    }}
                    disabled={isBusy}
                  >
                    <option value="all">All</option>
                    <option value="USER">Members</option>
                    <option value="CURATOR">Curators</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                </label>
                <label>
                  <span>Status</span>
                  <select
                    value={userFilter.status}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setUserFilter((previous) => ({
                        ...previous,
                        status: value as FilterValue<UserStatusFilter>,
                      }));
                    }}
                    disabled={isBusy}
                  >
                    <option value="all">All</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
              </div>
            </div>

            {renderSelectionToolbar(
              filteredUsers.length,
              selectedUsers.size,
              (checked) => toggleSelectAll(setSelectedUsers, filteredUsers.map((user) => user.id), checked),
              () => setSelectedUsers(new Set()),
              handleBulkDeleteUsers,
            )}

            <div className="admin__table" role="grid">
              <div className="admin__table-header admin__table-header--wide" role="row">
                <span className="admin__table-cell admin__table-cell--checkbox" role="columnheader" aria-label="Selection" />
                <span className="admin__table-cell" role="columnheader">
                  Account
                </span>
                <span className="admin__table-cell" role="columnheader">
                  Profile &amp; permissions
                </span>
                <span className="admin__table-cell admin__table-cell--actions" role="columnheader">
                  Actions
                </span>
              </div>
              <div className="admin__table-body">
                {filteredUsers.length === 0 ? (
                  <p className="admin__empty">No users available.</p>
                ) : (
                  filteredUsers.map((user) => (
                    <form
                      key={user.id}
                      className="admin-row"
                      onSubmit={(event) => handleUpdateUser(event, user.id)}
                      aria-label={`Settings for ${user.displayName}`}
                    >
                      <div className="admin-row__cell admin-row__cell--checkbox">
                        <input
                          type="checkbox"
                          checked={selectedUsers.has(user.id)}
                          onChange={(event) => toggleSelection(setSelectedUsers, user.id, event.currentTarget.checked)}
                          disabled={isBusy}
                          aria-label={`Select ${user.displayName}`}
                        />
                      </div>
                      <div className="admin-row__cell admin-row__cell--meta">
                        <h4>{user.displayName}</h4>
                        <span className="admin-row__subtitle">{user.email}</span>
                        <div className="admin-row__badges">
                          <span className={`admin-badge admin-badge--${user.role.toLowerCase()}`}>{user.role}</span>
                          <span
                            className={`admin-badge ${user.isActive === false ? 'admin-badge--muted' : 'admin-badge--success'}`}
                          >
                            {user.isActive === false ? 'inactive' : 'active'}
                          </span>
                        </div>
                      </div>
                      <div className="admin-row__cell admin-row__cell--form">
                        <label>
                          <span>Display name</span>
                          <input name="displayName" defaultValue={user.displayName} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Role</span>
                          <select name="role" defaultValue={user.role} disabled={isBusy}>
                            <option value="USER">Member</option>
                            <option value="CURATOR">Curator</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                        </label>
                        <label>
                          <span>Bio</span>
                          <textarea name="bio" rows={2} defaultValue={user.bio ?? ''} disabled={isBusy} />
                        </label>
                        <label>
                          <span>New password</span>
                          <input name="password" type="password" placeholder="Optional" disabled={isBusy} />
                        </label>
                        <label className="admin__checkbox">
                          <input type="checkbox" name="isActive" defaultChecked={user.isActive !== false} disabled={isBusy} />
                          <span>Account active</span>
                        </label>
                      </div>
                      <div className="admin-row__cell admin-row__cell--actions">
                        <button type="submit" className="button" disabled={isBusy}>
                          Save
                        </button>
                        <button
                          type="button"
                          className="button button--danger"
                          onClick={() => handleDeleteUser(user.id)}
                          disabled={isBusy}
                        >
                          Delete
                        </button>
                      </div>
                    </form>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === 'models' ? (
        <div className="admin__panel">
          <section className="admin__section">
            <div className="admin__section-header admin__section-header--split">
              <div>
                <h3>Models library</h3>
                <p className="admin__section-description">
                  Curate thousands of LoRA checkpoints with dense filters and drawer-style details.
                </p>
              </div>
              <div className="admin-collection__chip-group" role="group" aria-label="Model row density">
                <FilterChip
                  label="Comfortable"
                  isActive={modelDensity === 'comfortable'}
                  tone={modelDensity === 'comfortable' ? 'solid' : 'default'}
                  onClick={() => setModelDensity('comfortable')}
                  aria-pressed={modelDensity === 'comfortable'}
                />
                <FilterChip
                  label="Compact"
                  isActive={modelDensity === 'compact'}
                  tone={modelDensity === 'compact' ? 'solid' : 'default'}
                  onClick={() => setModelDensity('compact')}
                  aria-pressed={modelDensity === 'compact'}
                />
              </div>
            </div>
            <div className="admin__filters admin__filters--grid">
              <label>
                <span>Search</span>
                <input
                  type="search"
                  value={modelFilter.query}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setModelFilter((previous) => ({ ...previous, query: value }));
                  }}
                  placeholder="Title, description, owner, metadata"
                  disabled={isBusy}
                />
              </label>
              <label>
                <span>Owner</span>
                <select
                  value={modelFilter.owner}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setModelFilter((previous) => ({ ...previous, owner: value as FilterValue<string> }));
                  }}
                  disabled={isBusy}
                >
                  <option value="all">All</option>
                  {userOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Tag search</span>
                <input
                  type="search"
                  value={modelFilter.tag}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setModelFilter((previous) => ({ ...previous, tag: value }));
                  }}
                  placeholder="Tag filter"
                  disabled={isBusy}
                />
              </label>
              <label>
                <span>Metadata</span>
                <input
                  type="search"
                  value={modelFilter.metadata}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setModelFilter((previous) => ({ ...previous, metadata: value }));
                  }}
                  placeholder="Base model, checksum, filename…"
                  disabled={isBusy}
                />
              </label>
              <label>
                <span>Sort by</span>
                <select
                  value={modelFilter.sort}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setModelFilter((previous) => ({ ...previous, sort: value as typeof previous.sort }));
                  }}
                  disabled={isBusy}
                >
                  <option value="updated_desc">Recently updated</option>
                  <option value="title_asc">Title A → Z</option>
                  <option value="owner_asc">Owner A → Z</option>
                </select>
              </label>
            </div>
            <div className="admin-collection__chip-toolbar">
              <div className="admin-collection__chip-group" role="group" aria-label="Model visibility filter">
                <FilterChip
                  label="All visibility"
                  isActive={modelFilter.visibility === 'all'}
                  tone={modelFilter.visibility === 'all' ? 'solid' : 'default'}
                  onClick={() => setModelFilter((previous) => ({ ...previous, visibility: 'all' }))}
                  aria-pressed={modelFilter.visibility === 'all'}
                />
                <FilterChip
                  label="Public"
                  isActive={modelFilter.visibility === 'public'}
                  tone={modelFilter.visibility === 'public' ? 'solid' : 'default'}
                  onClick={() => setModelFilter((previous) => ({ ...previous, visibility: 'public' }))}
                  aria-pressed={modelFilter.visibility === 'public'}
                />
                <FilterChip
                  label="Private"
                  isActive={modelFilter.visibility === 'private'}
                  tone={modelFilter.visibility === 'private' ? 'solid' : 'default'}
                  onClick={() => setModelFilter((previous) => ({ ...previous, visibility: 'private' }))}
                  aria-pressed={modelFilter.visibility === 'private'}
                />
              </div>
            </div>
            {modelMetadataOptions.length > 0 ? (
              <div
                className="admin-collection__chip-group admin-collection__chip-group--scroll"
                role="group"
                aria-label="Popular model metadata"
              >
                <FilterChip
                  label="Any metadata"
                  isActive={modelFilter.metadata.trim().length === 0}
                  tone={modelFilter.metadata.trim().length === 0 ? 'solid' : 'default'}
                  onClick={() => setModelFilter((previous) => ({ ...previous, metadata: '' }))}
                  aria-pressed={modelFilter.metadata.trim().length === 0}
                />
                {modelMetadataOptions.map((option) => {
                  const normalized = option.label.toLowerCase();
                  const isActive = modelFilter.metadata.trim().toLowerCase() === normalized;
                  return (
                    <FilterChip
                      key={option.label}
                      label={option.label}
                      count={option.count}
                      isActive={isActive}
                      tone={isActive ? 'solid' : 'default'}
                      onClick={() => setModelFilter((previous) => ({ ...previous, metadata: option.label }))}
                      aria-pressed={isActive}
                    />
                  );
                })}
              </div>
            ) : null}
            {renderSelectionToolbar(
              filteredModels.length,
              selectedModels.size,
              (checked) => toggleSelectAll(setSelectedModels, filteredModels.map((model) => model.id), checked),
              () => setSelectedModels(new Set()),
              handleBulkDeleteModels,
            )}
            {filteredModels.length === 0 ? (
              <p className="admin__empty">No models match your filters.</p>
            ) : (
              <div
                className={`admin-collection ${modelDensity === 'compact' ? 'admin-collection--compact' : ''}`}
                role="list"
              >
                {filteredModels.map((model) => {
                  const isExpanded = expandedModelId === model.id;
                  const modelDetails = buildModelDetail(model);
                  const visibleTags = model.tags.slice(0, modelDensity === 'compact' ? 3 : 6);
                  const remainingTagCount = model.tags.length - visibleTags.length;
                  return (
                    <article
                      key={model.id}
                      className={`admin-collection__row${isExpanded ? ' admin-collection__row--expanded' : ''}`}
                      role="listitem"
                    >
                      <div className="admin-collection__row-main">
                        <label className="admin-collection__checkbox">
                          <input
                            type="checkbox"
                            checked={selectedModels.has(model.id)}
                            onChange={(event) =>
                              toggleSelection(setSelectedModels, model.id, event.currentTarget.checked)
                            }
                            disabled={isBusy}
                          />
                          <span className="sr-only">Select {model.title}</span>
                        </label>
                        <div className="admin-collection__primary">
                          <button
                            type="button"
                            className="admin-collection__title-button"
                            onClick={() => setExpandedModelId(isExpanded ? null : model.id)}
                            aria-expanded={isExpanded}
                          >
                            <span className="admin-collection__title">{model.title}</span>
                            <span className="admin-collection__subtitle">
                              v{model.version || '—'} · {modelDetails.updatedLabel}
                            </span>
                          </button>
                          <div className="admin-collection__badge-row">
                            <span className="admin-badge admin-badge--muted">{model.versions.length} versions</span>
                            {modelDetails.fileSizeLabel ? (
                              <span className="admin-badge admin-badge--muted">{modelDetails.fileSizeLabel}</span>
                            ) : null}
                            <span className={`admin-badge ${model.isPublic ? 'admin-badge--success' : 'admin-badge--muted'}`}>
                              {model.isPublic ? 'Public' : 'Private'}
                            </span>
                          </div>
                          {model.description ? (
                            <p className="admin-collection__excerpt">
                              {truncateText(model.description, modelDensity === 'compact' ? 120 : 220)}
                            </p>
                          ) : null}
                          {model.trigger ? (
                            <p className="admin-collection__muted">
                              Trigger: <strong>{model.trigger}</strong>
                            </p>
                          ) : null}
                          <div className="admin-collection__tag-row">
                            {visibleTags.map((tag) => (
                              <span key={tag.id} className="admin-badge">
                                {tag.label}
                              </span>
                            ))}
                            {remainingTagCount > 0 ? (
                              <span className="admin-badge admin-badge--muted">+{remainingTagCount} more</span>
                            ) : null}
                          </div>
                        </div>
                        <div className="admin-collection__meta">
                          <span className="admin-collection__owner">
                            by{' '}
                            {onOpenProfile ? (
                              <button
                                type="button"
                                className="curator-link"
                                onClick={() => onOpenProfile(model.owner.id)}
                              >
                                {model.owner.displayName}
                              </button>
                            ) : (
                              model.owner.displayName
                            )}
                          </span>
                        </div>
                        <div className="admin-collection__actions">
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => setExpandedModelId(isExpanded ? null : model.id)}
                          >
                            {isExpanded ? 'Hide details' : 'Details'}
                          </button>
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => handleOpenModelEdit(model)}
                            disabled={isBusy}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => handleOpenVersionUpload(model)}
                            disabled={isBusy}
                          >
                            New version
                          </button>
                          <button
                            type="button"
                            className="button button--danger"
                            onClick={() => handleDeleteModel(model)}
                            disabled={isBusy}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      {isExpanded ? (
                        <div className="admin-collection__details">
                          <div className="admin-collection__detail-grid">
                            <div className="admin-collection__detail-column">
                              <div className="admin-collection__preview">
                                {modelDetails.previewUrl ? (
                                  <img src={modelDetails.previewUrl} alt={model.title} loading="lazy" />
                                ) : (
                                  <div className="admin-collection__preview-placeholder">No preview</div>
                                )}
                              </div>
                              <div className="admin-collection__metadata">
                                <dl>
                                  {modelDetails.metadataEntries.map((entry) => (
                                    <div key={entry.label} className="admin-collection__metadata-row">
                                      <dt>{entry.label}</dt>
                                      <dd>
                                        {entry.href ? (
                                          <a href={entry.href} target="_blank" rel="noreferrer">
                                            {entry.value}
                                          </a>
                                        ) : (
                                          entry.value
                                        )}
                                      </dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                              <div className="admin-collection__detail-actions">
                                {modelDetails.previewUrl ? (
                                  <a
                                    className="button button--subtle"
                                    href={modelDetails.previewUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Preview
                                  </a>
                                ) : null}
                                <a
                                  className="button button--subtle"
                                  href={modelDetails.downloadUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Download latest
                                </a>
                              </div>
                            </div>
                            <div className="admin-collection__detail-column admin-collection__detail-column--wide">
                              <header className="admin-collection__detail-header">
                                <h5>Version history</h5>
                                <span className="admin-badge admin-badge--muted">{model.versions.length} total</span>
                              </header>
                              <ul className="admin-collection__version-list">
                                {model.versions.map((version) => {
                                  const versionDownloadUrl =
                                    resolveStorageUrl(
                                      version.storagePath,
                                      version.storageBucket,
                                      version.storageObject,
                                    ) ?? version.storagePath;
                                  const versionPreviewUrl =
                                    resolveCachedStorageUrl(
                                      version.previewImage,
                                      version.previewImageBucket,
                                      version.previewImageObject,
                                      { updatedAt: version.updatedAt, cacheKey: version.id },
                                    ) ?? version.previewImage ?? null;
                                  const versionUpdatedLabel = new Date(version.updatedAt).toLocaleDateString('en-US');
                                  const versionFileSizeLabel = formatFileSize(version.fileSize);
                                  return (
                                    <li key={version.id} className="admin-collection__version-row">
                                      <div className="admin-collection__version-main">
                                        <strong>{version.version}</strong>
                                        <div className="admin-collection__badge-row">
                                          {version.id === model.primaryVersionId ? (
                                            <span className="admin-badge">Primary</span>
                                          ) : null}
                                          {version.id === model.latestVersionId ? (
                                            <span className="admin-badge admin-badge--muted">Latest</span>
                                          ) : null}
                                          <span className="admin-badge admin-badge--muted">{versionUpdatedLabel}</span>
                                          {versionFileSizeLabel ? (
                                            <span className="admin-badge admin-badge--muted">{versionFileSizeLabel}</span>
                                          ) : null}
                                        </div>
                                      </div>
                                      <div className="admin-collection__version-actions">
                                        {versionPreviewUrl ? (
                                          <a
                                            className="button button--subtle"
                                            href={versionPreviewUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            Preview
                                          </a>
                                        ) : null}
                                        <a
                                          className="button button--subtle"
                                          href={versionDownloadUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          Download
                                        </a>
                                        {version.id !== model.primaryVersionId ? (
                                          <>
                                            <button
                                              type="button"
                                              className="button button--subtle"
                                              onClick={() => handlePromoteModelVersion(model, version)}
                                              disabled={isBusy}
                                            >
                                              Make primary
                                            </button>
                                            <button
                                              type="button"
                                              className="button button--subtle"
                                              onClick={() => handleOpenVersionRename(model, version)}
                                              disabled={isBusy}
                                            >
                                              Rename
                                            </button>
                                            <button
                                              type="button"
                                              className="button button--danger"
                                              onClick={() => handleDeleteModelVersion(model, version)}
                                              disabled={isBusy}
                                            >
                                              Delete
                                            </button>
                                          </>
                                        ) : null}
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === 'images' ? (
        <div className="admin__panel">
          <section className="admin__section">
            <div className="admin__section-header admin__section-header--split">
              <div>
                <h3>Image archive</h3>
                <p className="admin__section-description">
                  Review curated renders with metadata drill-downs and instant bulk actions.
                </p>
              </div>
              <div className="admin-collection__chip-group" role="group" aria-label="Image row density">
                <FilterChip
                  label="Comfortable"
                  isActive={imageDensity === 'comfortable'}
                  tone={imageDensity === 'comfortable' ? 'solid' : 'default'}
                  onClick={() => setImageDensity('comfortable')}
                  aria-pressed={imageDensity === 'comfortable'}
                />
                <FilterChip
                  label="Compact"
                  isActive={imageDensity === 'compact'}
                  tone={imageDensity === 'compact' ? 'solid' : 'default'}
                  onClick={() => setImageDensity('compact')}
                  aria-pressed={imageDensity === 'compact'}
                />
              </div>
            </div>
            <div className="admin__filters admin__filters--grid">
              <label>
                <span>Search</span>
                <input
                  type="search"
                  value={imageFilter.query}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setImageFilter((previous) => ({ ...previous, query: value }));
                  }}
                  placeholder="Title, prompt, metadata"
                  disabled={isBusy}
                />
              </label>
              <label>
                <span>Owner</span>
                <select
                  value={imageFilter.owner}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setImageFilter((previous) => ({ ...previous, owner: value as FilterValue<string> }));
                  }}
                  disabled={isBusy}
                >
                  <option value="all">All</option>
                  {userOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Metadata</span>
                <input
                  type="search"
                  value={imageFilter.metadata}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setImageFilter((previous) => ({ ...previous, metadata: value }));
                  }}
                  placeholder="Seed, model, sampler…"
                  disabled={isBusy}
                />
              </label>
              <label>
                <span>Sort by</span>
                <select
                  value={imageFilter.sort}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setImageFilter((previous) => ({ ...previous, sort: value as typeof previous.sort }));
                  }}
                  disabled={isBusy}
                >
                  <option value="updated_desc">Recently updated</option>
                  <option value="title_asc">Title A → Z</option>
                  <option value="owner_asc">Owner A → Z</option>
                </select>
              </label>
            </div>
            <div className="admin-collection__chip-toolbar">
              <div className="admin-collection__chip-group" role="group" aria-label="Image visibility filter">
                <FilterChip
                  label="All visibility"
                  isActive={imageFilter.visibility === 'all'}
                  tone={imageFilter.visibility === 'all' ? 'solid' : 'default'}
                  onClick={() => setImageFilter((previous) => ({ ...previous, visibility: 'all' }))}
                  aria-pressed={imageFilter.visibility === 'all'}
                />
                <FilterChip
                  label="Public"
                  isActive={imageFilter.visibility === 'public'}
                  tone={imageFilter.visibility === 'public' ? 'solid' : 'default'}
                  onClick={() => setImageFilter((previous) => ({ ...previous, visibility: 'public' }))}
                  aria-pressed={imageFilter.visibility === 'public'}
                />
                <FilterChip
                  label="Private"
                  isActive={imageFilter.visibility === 'private'}
                  tone={imageFilter.visibility === 'private' ? 'solid' : 'default'}
                  onClick={() => setImageFilter((previous) => ({ ...previous, visibility: 'private' }))}
                  aria-pressed={imageFilter.visibility === 'private'}
                />
              </div>
            </div>
            {imageMetadataOptions.length > 0 ? (
              <div
                className="admin-collection__chip-group admin-collection__chip-group--scroll"
                role="group"
                aria-label="Popular image metadata"
              >
                <FilterChip
                  label="Any metadata"
                  isActive={imageFilter.metadata.trim().length === 0}
                  tone={imageFilter.metadata.trim().length === 0 ? 'solid' : 'default'}
                  onClick={() => setImageFilter((previous) => ({ ...previous, metadata: '' }))}
                  aria-pressed={imageFilter.metadata.trim().length === 0}
                />
                {imageMetadataOptions.map((option) => {
                  const normalized = option.label.toLowerCase();
                  const isActive = imageFilter.metadata.trim().toLowerCase() === normalized;
                  return (
                    <FilterChip
                      key={option.label}
                      label={option.label}
                      count={option.count}
                      isActive={isActive}
                      tone={isActive ? 'solid' : 'default'}
                      onClick={() => setImageFilter((previous) => ({ ...previous, metadata: option.label }))}
                      aria-pressed={isActive}
                    />
                  );
                })}
              </div>
            ) : null}
            {renderSelectionToolbar(
              filteredImages.length,
              selectedImages.size,
              (checked) => toggleSelectAll(setSelectedImages, filteredImages.map((image) => image.id), checked),
              () => setSelectedImages(new Set()),
              handleBulkDeleteImages,
            )}
            {filteredImages.length === 0 ? (
              <p className="admin__empty">No images match your filters.</p>
            ) : (
              <div
                className={`admin-collection ${imageDensity === 'compact' ? 'admin-collection--compact' : ''}`}
                role="list"
              >
                {filteredImages.map((image) => {
                  const isExpanded = expandedImageId === image.id;
                  const imageDetails = buildImageDetail(image);
                  const metadataEntries = [
                    image.metadata?.seed ? { label: 'Seed', value: image.metadata.seed } : null,
                    image.metadata?.model ? { label: 'Model', value: image.metadata.model } : null,
                    image.metadata?.sampler ? { label: 'Sampler', value: image.metadata.sampler } : null,
                    image.metadata?.cfgScale != null
                      ? { label: 'CFG', value: image.metadata.cfgScale.toString() }
                      : null,
                    image.metadata?.steps != null
                      ? { label: 'Steps', value: image.metadata.steps.toString() }
                      : null,
                  ].filter((entry): entry is { label: string; value: string } => Boolean(entry));
                  const visibleTags = image.tags.slice(0, imageDensity === 'compact' ? 4 : 8);
                  const remainingTagCount = image.tags.length - visibleTags.length;
                  return (
                    <article
                      key={image.id}
                      className={`admin-collection__row${isExpanded ? ' admin-collection__row--expanded' : ''}`}
                      role="listitem"
                    >
                      <div className="admin-collection__row-main">
                        <label className="admin-collection__checkbox">
                          <input
                            type="checkbox"
                            checked={selectedImages.has(image.id)}
                            onChange={(event) =>
                              toggleSelection(setSelectedImages, image.id, event.currentTarget.checked)
                            }
                            disabled={isBusy}
                          />
                          <span className="sr-only">Select {image.title}</span>
                        </label>
                        <div className="admin-collection__primary">
                          <button
                            type="button"
                            className="admin-collection__title-button"
                            onClick={() => setExpandedImageId(isExpanded ? null : image.id)}
                            aria-expanded={isExpanded}
                          >
                            <span className="admin-collection__title">{image.title}</span>
                            <span className="admin-collection__subtitle">{imageDetails.updatedLabel}</span>
                          </button>
                          <div className="admin-collection__badge-row">
                            {imageDetails.dimensionsLabel ? (
                              <span className="admin-badge admin-badge--muted">{imageDetails.dimensionsLabel}</span>
                            ) : null}
                            {imageDetails.fileSizeLabel ? (
                              <span className="admin-badge admin-badge--muted">{imageDetails.fileSizeLabel}</span>
                            ) : null}
                            <span className={`admin-badge ${image.isPublic ? 'admin-badge--success' : 'admin-badge--muted'}`}>
                              {image.isPublic ? 'Public' : 'Private'}
                            </span>
                          </div>
                          {image.prompt ? (
                            <p className="admin-collection__excerpt">
                              <strong>Prompt:</strong>{' '}
                              {truncateText(image.prompt, imageDensity === 'compact' ? 120 : 220)}
                            </p>
                          ) : null}
                          {image.negativePrompt ? (
                            <p className="admin-collection__muted">
                              <strong>Negative:</strong>{' '}
                              {truncateText(image.negativePrompt, 160)}
                            </p>
                          ) : null}
                          <div className="admin-collection__tag-row">
                            {visibleTags.map((tag) => (
                              <span key={tag.id} className="admin-badge">
                                {tag.label}
                              </span>
                            ))}
                            {remainingTagCount > 0 ? (
                              <span className="admin-badge admin-badge--muted">+{remainingTagCount} more</span>
                            ) : null}
                          </div>
                        </div>
                        <div className="admin-collection__meta">
                          <span className="admin-collection__owner">
                            by{' '}
                            {onOpenProfile ? (
                              <button
                                type="button"
                                className="curator-link"
                                onClick={() => onOpenProfile(image.owner.id)}
                              >
                                {image.owner.displayName}
                              </button>
                            ) : (
                              image.owner.displayName
                            )}
                          </span>
                        </div>
                        <div className="admin-collection__actions">
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => setExpandedImageId(isExpanded ? null : image.id)}
                          >
                            {isExpanded ? 'Hide details' : 'Details'}
                          </button>
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => handleOpenImageEdit(image)}
                            disabled={isBusy}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="button button--danger"
                            onClick={() => handleDeleteImage(image)}
                            disabled={isBusy}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      {isExpanded ? (
                        <div className="admin-collection__details">
                          <div className="admin-collection__detail-grid">
                            <div className="admin-collection__detail-column admin-collection__detail-column--media">
                              <div className="admin-collection__preview admin-collection__preview--image">
                                {imageDetails.previewUrl ? (
                                  <img src={imageDetails.previewUrl} alt={image.title} loading="lazy" />
                                ) : (
                                  <div className="admin-collection__preview-placeholder">No preview</div>
                                )}
                              </div>
                              <div className="admin-collection__detail-actions">
                                {imageDetails.previewUrl ? (
                                  <a
                                    className="button button--subtle"
                                    href={imageDetails.previewUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open
                                  </a>
                                ) : null}
                                <a
                                  className="button button--subtle"
                                  href={imageDetails.downloadUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Download
                                </a>
                              </div>
                            </div>
                            <div className="admin-collection__detail-column admin-collection__detail-column--wide">
                              <div className="admin-collection__metadata">
                                <dl>
                                  {metadataEntries.map((entry) => (
                                    <div key={entry.label} className="admin-collection__metadata-row">
                                      <dt>{entry.label}</dt>
                                      <dd>{entry.value}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                              <div className="admin-collection__prompts">
                                {image.prompt ? (
                                  <p>
                                    <strong>Prompt:</strong> {image.prompt}
                                  </p>
                                ) : null}
                                {image.negativePrompt ? (
                                  <p>
                                    <strong>Negative:</strong> {image.negativePrompt}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === 'generator' ? (
        <div className="admin__panel">
          <section className="admin__section admin__section--generator">
            <div className="admin__section-intro">
              <h3>On-Site Generator visibility</h3>
              <p>
                Decide who sees the generator entry in the sidebar. Admin-only mode keeps the rollout private while the GPU
                worker comes online; member mode exposes the wizard to every authenticated account (guests stay excluded).
              </p>
            </div>
            <form className="generator-settings" onSubmit={handleGeneratorSettingsSubmit}>
              <fieldset>
                <legend>Choose the visibility mode</legend>
                <label className="generator-settings__option">
                  <input
                    type="radio"
                    name="generator-access"
                    value="ADMIN_ONLY"
                    checked={generatorAccessMode === 'ADMIN_ONLY'}
                    onChange={() => handleGeneratorAccessChange('ADMIN_ONLY')}
                  />
                  <span>
                    <strong>Admin only</strong>
                    <small>Only administrators see and can use the generator interface.</small>
                  </span>
                </label>
                <label className="generator-settings__option">
                  <input
                    type="radio"
                    name="generator-access"
                    value="MEMBERS"
                    checked={generatorAccessMode === 'MEMBERS'}
                    onChange={() => handleGeneratorAccessChange('MEMBERS')}
                  />
                  <span>
                    <strong>Members & curators</strong>
                    <small>All signed-in users (USER, CURATOR, ADMIN) can request renders; guests remain blocked.</small>
                  </span>
                </label>
              </fieldset>
              <section className="generator-base-models">
                <div className="generator-base-models__header">
                  <h4>Base model presets</h4>
                  <p>Define the checkpoints exposed inside the On-Site Generator wizard.</p>
                </div>
                {baseModelDrafts.length === 0 ? (
                  <p className="generator-base-models__empty">
                    No base models configured yet. Add at least one checkpoint so users can request renders.
                  </p>
                ) : (
                  <ol className="generator-base-models__list">
                    {baseModelDrafts.map((entry, index) => (
                      <li key={`generator-base-model-${index}`} className="generator-base-models__entry">
                        <div className="generator-base-models__grid">
                          <label>
                            <span>Type</span>
                            <select
                              value={entry.type}
                              onChange={(event) => handleBaseModelFieldChange(index, 'type', event.target.value)}
                            >
                              {generatorBaseModelTypeOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>Name</span>
                            <input
                              type="text"
                              value={entry.name}
                              onChange={(event) => handleBaseModelFieldChange(index, 'name', event.target.value)}
                              placeholder="Display label shown to users"
                            />
                          </label>
                          <label>
                            <span>Filename</span>
                            <input
                              type="text"
                              value={entry.filename}
                              onChange={(event) => handleBaseModelFieldChange(index, 'filename', event.target.value)}
                              placeholder="Model filename or object path"
                            />
                          </label>
                        </div>
                        <div className="generator-base-models__row-actions">
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => handleRemoveBaseModel(index)}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="generator-base-models__footer">
                  <button type="button" className="button button--ghost" onClick={handleAddBaseModel}>
                    Add base model
                  </button>
                </div>
              </section>
              {generatorSettingsError ? (
                <p className="generator-settings__error">{generatorSettingsError}</p>
              ) : null}
              <div className="generator-settings__actions">
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={!isGeneratorDirty || isSavingGeneratorSettings}
                >
                  {isSavingGeneratorSettings ? 'Saving…' : 'Save access level'}
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={handleResetGeneratorAccess}
                  disabled={isSavingGeneratorSettings || !isGeneratorDirty}
                >
                  Revert changes
                </button>
              </div>
            </form>
          </section>
          <section className="admin__section admin__section--generator-notes">
            <h4>Rollout playbook</h4>
            <ul className="generator-guidance-list">
              <li>
                Keep the mode on <strong>Admin only</strong> while syncing checkpoints, LoRAs, and validating GPU worker health.
              </li>
              <li>
                Switch to <strong>Members & curators</strong> once the agent can hot-load models and return outputs reliably.
              </li>
              <li>
                Switching modes updates the sidebar instantly—no deployment or browser refresh required.
              </li>
            </ul>
          </section>
        </div>
      ) : null}

      {activeTab === 'ranking' ? (
        <div className="admin__panel">
          <section className="admin__section">
            <div className="admin__section-intro">
              <h3>Score weighting</h3>
              <p>Adjust how models, galleries, and images contribute to curator rankings.</p>
              {rankingSettings?.isFallback ? (
                <p className="admin__note">Currently using fallback weights until custom values are saved.</p>
              ) : null}
            </div>
            <form className="admin__form admin__form-grid admin-ranking__weights" onSubmit={handleRankingSettingsSubmit}>
              <label>
                <span>Model weight</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={weightDraft.modelWeight}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setWeightDraft((previous) => ({ ...previous, modelWeight: value }));
                  }}
                  disabled={isBusy}
                  required
                />
              </label>
              <label>
                <span>Gallery weight</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={weightDraft.galleryWeight}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setWeightDraft((previous) => ({ ...previous, galleryWeight: value }));
                  }}
                  disabled={isBusy}
                  required
                />
              </label>
              <label>
                <span>Image weight</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={weightDraft.imageWeight}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setWeightDraft((previous) => ({ ...previous, imageWeight: value }));
                  }}
                  disabled={isBusy}
                  required
                />
              </label>
              <div className="admin__form-actions">
                <button type="submit" className="button button--primary" disabled={isBusy}>
                  Save weights
                </button>
              </div>
            </form>
          </section>

          <section className="admin__section">
            <div className="admin__section-intro">
              <h3>Rank tiers</h3>
              <p>Maintain the ladder of recognition tiers and their score thresholds.</p>
              {rankingTiersFallback ? (
                <p className="admin__note">Showing fallback tiers. Create a tier to persist custom rankings.</p>
              ) : null}
            </div>
            <div className="admin-ranking__tier-list">
              {rankingTiers.length === 0 ? (
                <p className="admin__empty">No tiers configured yet.</p>
              ) : (
                rankingTiers.map((tier) => {
                  const tierId = tier.id;
                  if (!tierId) {
                    return (
                      <article
                        key={`fallback-${tier.label}-${tier.minimumScore}`}
                        className="admin-ranking__tier admin-ranking__tier--readonly"
                      >
                        <header className="admin-ranking__tier-header">
                          <h4>{tier.label}</h4>
                          <span className="admin-badge admin-badge--muted">Min score {tier.minimumScore}</span>
                        </header>
                        <p>{tier.description}</p>
                        <p className="admin__note">Fallback tier—create a custom tier to edit.</p>
                      </article>
                    );
                  }

                  const draft =
                    tierDrafts[tierId] ?? {
                      label: tier.label,
                      description: tier.description,
                      minimumScore: tier.minimumScore.toString(),
                      position:
                        tier.position !== undefined && tier.position !== null ? String(tier.position) : '',
                      isActive: tier.isActive ?? true,
                    };

                  return (
                    <form key={tierId} className="admin-ranking__tier admin__form" onSubmit={(event) => handleTierUpdate(event, tierId)}>
                      <div className="admin__form-grid admin-ranking__tier-grid">
                        <label>
                          <span>Label</span>
                          <input
                            type="text"
                            value={draft.label}
                            onChange={(event) => updateTierDraft(tierId, { label: event.currentTarget.value })}
                            disabled={isBusy}
                            required
                          />
                        </label>
                        <label>
                          <span>Minimum score</span>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={draft.minimumScore}
                            onChange={(event) =>
                              updateTierDraft(tierId, { minimumScore: event.currentTarget.value })
                            }
                            disabled={isBusy}
                            required
                          />
                        </label>
                        <label>
                          <span>Position</span>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={draft.position}
                            onChange={(event) => updateTierDraft(tierId, { position: event.currentTarget.value })}
                            disabled={isBusy}
                            placeholder="Auto"
                          />
                        </label>
                        <label className="admin-ranking__checkbox">
                          <span>Active</span>
                          <input
                            type="checkbox"
                            checked={draft.isActive}
                            onChange={(event) => updateTierDraft(tierId, { isActive: event.currentTarget.checked })}
                            disabled={isBusy}
                          />
                        </label>
                      </div>
                      <label>
                        <span>Description</span>
                        <textarea
                          value={draft.description}
                          onChange={(event) => updateTierDraft(tierId, { description: event.currentTarget.value })}
                          disabled={isBusy}
                          rows={3}
                          required
                        />
                      </label>
                      <div className="admin__form-actions">
                        <button type="submit" className="button button--primary" disabled={isBusy}>
                          Save tier
                        </button>
                        <button
                          type="button"
                          className="button button--danger"
                          onClick={() => handleTierDelete(tier)}
                          disabled={isBusy}
                        >
                          Delete tier
                        </button>
                      </div>
                    </form>
                  );
                })
              )}
            </div>
            <div className="admin-ranking__create">
              <h4>Add new tier</h4>
              <form className="admin__form admin__form-grid" onSubmit={handleCreateTier}>
                <label>
                  <span>Label</span>
                  <input
                    type="text"
                    value={newTierDraft.label}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setNewTierDraft((previous) => ({ ...previous, label: value }));
                    }}
                    disabled={isBusy}
                    required
                  />
                </label>
                <label>
                  <span>Minimum score</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={newTierDraft.minimumScore}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setNewTierDraft((previous) => ({ ...previous, minimumScore: value }));
                    }}
                    disabled={isBusy}
                    required
                  />
                </label>
                <label>
                  <span>Position</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={newTierDraft.position}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setNewTierDraft((previous) => ({ ...previous, position: value }));
                    }}
                    disabled={isBusy}
                    placeholder="Auto"
                  />
                </label>
                <label className="admin-ranking__checkbox">
                  <span>Active</span>
                  <input
                    type="checkbox"
                    checked={newTierDraft.isActive}
                    onChange={(event) => {
                      const { checked } = event.currentTarget;
                      setNewTierDraft((previous) => ({ ...previous, isActive: checked }));
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="admin-ranking__textarea">
                  <span>Description</span>
                  <textarea
                    value={newTierDraft.description}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setNewTierDraft((previous) => ({ ...previous, description: value }));
                    }}
                    disabled={isBusy}
                    rows={3}
                    required
                  />
                </label>
                <div className="admin__form-actions">
                  <button type="submit" className="button button--primary" disabled={isBusy}>
                    Create tier
                  </button>
                </div>
              </form>
            </div>
          </section>

          <section className="admin__section">
            <div className="admin__section-intro">
              <h3>Curator ranking actions</h3>
              <p>Reset scores or toggle blocks for individual curators without impacting their uploads.</p>
            </div>
            <div className="admin__form admin-ranking__user-controls">
              <label>
                <span>Curator</span>
                <input
                  type="text"
                  list="admin-ranking-users"
                  placeholder="Select a user or paste their ID"
                  value={rankingUserId}
                  onChange={(event) => setRankingUserId(event.currentTarget.value)}
                  disabled={isBusy}
                />
                {userOptions.length > 0 ? (
                  <datalist id="admin-ranking-users">
                    {userOptions.map((option) => (
                      <option key={option.id} value={option.id} label={`${option.label} (${option.id})`} />
                    ))}
                  </datalist>
                ) : null}
              </label>
              <div className="admin__form-actions admin-ranking__user-buttons">
                <button
                  type="button"
                  className="button"
                  onClick={() => handleRankingUserAction('reset')}
                  disabled={isBusy || !hasRankingUserSelection}
                >
                  Reset score
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => handleRankingUserAction('block')}
                  disabled={isBusy || !hasRankingUserSelection}
                >
                  Block ranking
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => handleRankingUserAction('unblock')}
                  disabled={isBusy || !hasRankingUserSelection}
                >
                  Unblock ranking
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === 'galleries' ? (
        <div className="admin__panel">
          <section className="admin__section">
            <div className="admin__section-header">
              <h3>Galleries &amp; albums</h3>
              <div className="admin__filters">
                <label>
                  <span>Search</span>
                  <input
                    type="search"
                    value={galleryFilter.query}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setGalleryFilter((previous) => ({ ...previous, query: value }));
                    }}
                    placeholder="Title or slug"
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Owner</span>
                  <select
                    value={galleryFilter.owner}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setGalleryFilter((previous) => ({ ...previous, owner: value as FilterValue<string> }));
                    }}
                    disabled={isBusy}
                  >
                    <option value="all">All</option>
                    {userOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Visibility</span>
                  <select
                    value={galleryFilter.visibility}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setGalleryFilter((previous) => ({
                        ...previous,
                        visibility: value as FilterValue<VisibilityFilter>,
                      }));
                    }}
                    disabled={isBusy}
                  >
                    <option value="all">All</option>
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="admin__table" role="grid">
              <div className="admin__table-header" role="row">
                <span className="admin__table-cell" role="columnheader">
                  Gallery
                </span>
                <span className="admin__table-cell" role="columnheader">
                  Metadata &amp; entries
                </span>
                <span className="admin__table-cell admin__table-cell--actions" role="columnheader">
                  Actions
                </span>
              </div>
              <div className="admin__table-body">
                {filteredGalleries.length === 0 ? (
                  <p className="admin__empty">No galleries available.</p>
                ) : (
                  filteredGalleries.map((gallery) => (
                    <form
                      key={gallery.id}
                      className="admin-row admin-row--wide"
                      onSubmit={(event) => handleUpdateGallery(event, gallery)}
                      aria-label={`Settings for ${gallery.title}`}
                    >
                      <div className="admin-row__cell admin-row__cell--meta">
                        <h4>{gallery.title}</h4>
                        <span className="admin-row__subtitle">Slug: {gallery.slug}</span>
                        <div className="admin-row__badges">
                          <span className="admin-badge">{gallery.isPublic ? 'public' : 'private'}</span>
                          <span className="admin-badge admin-badge--muted">
                            {new Date(gallery.updatedAt).toLocaleDateString('en-US')}
                          </span>
                          <span className="admin-badge">{gallery.entries.length} entries</span>
                        </div>
                      </div>
                      <div className="admin-row__cell admin-row__cell--form">
                        <label>
                          <span>Title</span>
                          <input name="title" defaultValue={gallery.title} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Description</span>
                          <textarea name="description" rows={2} defaultValue={gallery.description ?? ''} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Visibility</span>
                          <select name="visibility" defaultValue={gallery.isPublic ? 'public' : 'private'} disabled={isBusy}>
                            <option value="public">Public</option>
                            <option value="private">Private</option>
                          </select>
                        </label>
                        <label>
                          <span>Owner</span>
                          <select name="ownerId" defaultValue={gallery.owner.id} disabled={isBusy}>
                            {userOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Cover storage path</span>
                          <input
                            name="coverImage"
                            defaultValue={gallery.coverImage ?? ''}
                            placeholder="leave empty to remove"
                            disabled={isBusy}
                          />
                        </label>
                        <div className="admin-gallery-entries">
                          <h5>Entries</h5>
                          {gallery.entries.length === 0 ? (
                            <p className="admin__empty admin__empty--sub">No items linked yet.</p>
                          ) : (
                            gallery.entries.map((entry) => (
                              <fieldset key={entry.id} className="admin-gallery-entry">
                                <legend>
                                  {entry.position + 1}.{' '}
                                  {entry.modelAsset ? `Model: ${entry.modelAsset.title}` : entry.imageAsset ? `Image: ${entry.imageAsset.title}` : 'Unlinked'}
                                </legend>
                                <div className="admin-gallery-entry__grid">
                                  <label>
                                    <span>Position</span>
                                    <input
                                      name={`entry-${entry.id}-position`}
                                      type="number"
                                      defaultValue={entry.position}
                                      disabled={isBusy}
                                      min={0}
                                    />
                                  </label>
                                  <label className="admin__checkbox admin-gallery-entry__remove">
                                    <input name={`entry-${entry.id}-remove`} type="checkbox" disabled={isBusy} />
                                    <span>Remove</span>
                                  </label>
                                </div>
                                <label>
                                  <span>Note</span>
                                  <textarea
                                    name={`entry-${entry.id}-note`}
                                    rows={2}
                                    defaultValue={entry.note ?? ''}
                                    disabled={isBusy}
                                  />
                                </label>
                              </fieldset>
                            ))
                          )}
                        </div>
                      </div>
                      <div className="admin-row__cell admin-row__cell--actions admin-row__cell--stacked">
                        <button type="submit" className="button" disabled={isBusy}>
                          Save
                        </button>
                        <button
                          type="button"
                          className="button button--danger"
                          onClick={() => handleDeleteGallery(gallery)}
                          disabled={isBusy}
                        >
                          Delete
                        </button>
                      </div>
                    </form>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {modelToEdit ? (
        <ModelAssetEditDialog
          isOpen
          onClose={() => setModelToEdit(null)}
          model={modelToEdit}
          token={token}
          onSuccess={(updated) => {
            void handleModelEditSuccess(updated);
          }}
          owners={userOptions}
        />
      ) : null}
      {modelForVersionUpload ? (
        <ModelVersionDialog
          isOpen
          onClose={() => setModelForVersionUpload(null)}
          model={modelForVersionUpload}
          token={token}
          onSuccess={(updated) => {
            void handleVersionUploadSuccess(updated);
          }}
        />
      ) : null}
      {modelVersionToEdit ? (
        <ModelVersionEditDialog
          isOpen
          onClose={() => setModelVersionToEdit(null)}
          model={modelVersionToEdit.model}
          version={modelVersionToEdit.version}
          token={token}
          onSuccess={(updated) => {
            void handleVersionRenameSuccess(updated);
          }}
        />
      ) : null}
      {imageToEdit ? (
        <ImageAssetEditDialog
          isOpen
          onClose={() => setImageToEdit(null)}
          image={imageToEdit}
          token={token}
          onSuccess={() => {
            void handleImageEditSuccess();
          }}
          owners={userOptions}
        />
      ) : null}
    </section>
  );
};
