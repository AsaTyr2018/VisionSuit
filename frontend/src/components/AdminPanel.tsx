import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '../lib/api';
import { resolveCachedStorageUrl, resolveStorageUrl } from '../lib/storage';
import type {
  Gallery,
  GeneratorAccessMode,
  GeneratorBaseModelConfig,
  GeneratorSettings,
  ImageAsset,
  ModerationQueue,
  ModerationReport,
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

type AdminTab = 'users' | 'models' | 'images' | 'moderation' | 'generator' | 'galleries' | 'ranking';

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

const formatModerationTimestamp = (value?: string | null) => {
  if (!value) {
    return '—';
  }

  try {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to format moderation timestamp', error);
    }
    return value;
  }
};

type ModerationReportSummary = {
  total: number;
  reporters: string[];
  reasons: string[];
};

const summarizeModerationReports = (reports?: ModerationReport[] | null): ModerationReportSummary => {
  if (!reports || reports.length === 0) {
    return { total: 0, reporters: [], reasons: [] };
  }

  const reporterMap = new Map<string, string>();
  const reasonSet = new Set<string>();
  let includeMissingReason = false;

  reports.forEach((report) => {
    const name = report.reporter.displayName?.trim() || report.reporter.email;
    reporterMap.set(report.reporter.id, name);

    const normalizedReason = report.reason?.trim();
    if (normalizedReason && normalizedReason.length > 0) {
      reasonSet.add(normalizedReason);
    } else {
      includeMissingReason = true;
    }
  });

  if (includeMissingReason) {
    reasonSet.add('No reason provided');
  }

  return {
    total: reports.length,
    reporters: Array.from(reporterMap.values()),
    reasons: Array.from(reasonSet.values()),
  };
};

const formatCompactList = (
  values: string[],
  { max = 2, separator = ', ' }: { max?: number; separator?: string } = {},
) => {
  if (values.length === 0) {
    return { display: '—', title: '—' };
  }

  if (values.length <= max) {
    const label = values.join(separator);
    return { display: label, title: values.join('\n') };
  }

  const visible = values.slice(0, max);
  const remainder = values.length - visible.length;
  return {
    display: `${visible.join(separator)} +${remainder} more`,
    title: values.join('\n'),
  };
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
    model: string;
    visibility: FilterValue<VisibilityFilter>;
    sort: 'updated_desc' | 'title_asc' | 'owner_asc';
  }>({
    query: '',
    owner: 'all',
    metadata: '',
    model: '',
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
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [moderationQueue, setModerationQueue] = useState<ModerationQueue | null>(null);
  const [isModerationLoading, setIsModerationLoading] = useState(false);
  const [moderationError, setModerationError] = useState<string | null>(null);
  const [moderationAction, setModerationAction] = useState<
    { entity: 'model' | 'image'; action: 'approve' | 'remove'; id: string } | null
  >(null);
  const [activeModerationTarget, setActiveModerationTarget] = useState<
    { entity: 'model' | 'image'; id: string } | null
  >(null);
  const [moderationDecisionReason, setModerationDecisionReason] = useState('');
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<{ url: string; title: string } | null>(null);
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
  const flaggedModelCount = moderationQueue?.models.length ?? 0;
  const flaggedImageCount = moderationQueue?.images.length ?? 0;
  const totalModerationCount = flaggedModelCount + flaggedImageCount;

  const selectedModerationAsset = useMemo(() => {
    if (!activeModerationTarget || !moderationQueue) {
      return null;
    }

    if (activeModerationTarget.entity === 'model') {
      const asset = moderationQueue.models.find((entry) => entry.id === activeModerationTarget.id);
      return asset ? { entity: 'model' as const, asset } : null;
    }

    const asset = moderationQueue.images.find((entry) => entry.id === activeModerationTarget.id);
    return asset ? { entity: 'image' as const, asset } : null;
  }, [activeModerationTarget, moderationQueue]);

  const closeModerationDialog = useCallback(() => {
    setActiveModerationTarget(null);
    setModerationDecisionReason('');
  }, []);

  const moderationDialogAsset = selectedModerationAsset?.asset ?? null;
  const moderationDialogEntity = selectedModerationAsset?.entity ?? null;
  const moderationDialogReports = moderationDialogAsset?.moderationReports ?? [];
  const moderationDialogSummary = summarizeModerationReports(moderationDialogReports);
  const moderationDialogPreviewUrl = selectedModerationAsset
    ? selectedModerationAsset.entity === 'model'
      ? resolveCachedStorageUrl(
          selectedModerationAsset.asset.previewImage,
          selectedModerationAsset.asset.previewImageBucket,
          selectedModerationAsset.asset.previewImageObject,
          { updatedAt: selectedModerationAsset.asset.updatedAt, cacheKey: selectedModerationAsset.asset.id },
        ) ?? selectedModerationAsset.asset.previewImage ?? null
      : resolveCachedStorageUrl(
          selectedModerationAsset.asset.storagePath,
          selectedModerationAsset.asset.storageBucket,
          selectedModerationAsset.asset.storageObject,
          { updatedAt: selectedModerationAsset.asset.updatedAt, cacheKey: selectedModerationAsset.asset.id },
        ) ?? selectedModerationAsset.asset.storagePath
    : null;
  const moderationActionMatches = useCallback(
    (entity: 'model' | 'image', action: 'approve' | 'remove', id: string) =>
      moderationAction?.entity === entity &&
      moderationAction?.action === action &&
      moderationAction?.id === id,
    [moderationAction],
  );
  const isModerationApproveBusy = selectedModerationAsset
    ? moderationActionMatches(selectedModerationAsset.entity, 'approve', selectedModerationAsset.asset.id)
    : false;
  const isModerationRemoveBusy = selectedModerationAsset
    ? moderationActionMatches(selectedModerationAsset.entity, 'remove', selectedModerationAsset.asset.id)
    : false;
  const isModerationDialogBusy = isModerationApproveBusy || isModerationRemoveBusy || isModerationLoading;
  const trimmedModerationDecisionReason = moderationDecisionReason.trim();

  const handleApproveSelectedAsset = () => {
    if (!selectedModerationAsset) {
      return;
    }

    if (selectedModerationAsset.entity === 'model') {
      void handleApproveModel(selectedModerationAsset.asset);
    } else {
      void handleApproveImage(selectedModerationAsset.asset);
    }
  };

  const handleRejectSelectedAsset = () => {
    if (!selectedModerationAsset) {
      return;
    }

    if (selectedModerationAsset.entity === 'model') {
      void handleRemoveModel(selectedModerationAsset.asset, trimmedModerationDecisionReason);
    } else {
      void handleRemoveImage(selectedModerationAsset.asset, trimmedModerationDecisionReason);
    }
  };

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

  const fetchModerationQueue = useCallback(async () => {
    setIsModerationLoading(true);
    setModerationError(null);
    try {
      const response = await api.getModerationQueue(token);
      setModerationQueue(response);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Failed to load moderation queue.';
      setModerationError(message);
    } finally {
      setIsModerationLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (activeTab === 'moderation') {
      void fetchModerationQueue();
    }
  }, [activeTab, fetchModerationQueue]);

  const resetStatus = () => setStatus(null);

  const handleApproveModel = async (model: ModelAsset) => {
    resetStatus();
    setModerationAction({ entity: 'model', action: 'approve', id: model.id });
    try {
      const response = await api.approveModelModeration(token, model.id);
      setModerationQueue((queue) =>
        queue
          ? {
              ...queue,
              models: queue.models.filter((entry) => entry.id !== model.id),
            }
          : queue,
      );
      if (activeModerationTarget?.entity === 'model' && activeModerationTarget.id === model.id) {
        closeModerationDialog();
      }
      setStatus({ type: 'success', message: `Approved "${response.model.title}".` });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Failed to approve the flagged model.';
      setStatus({ type: 'error', message });
    } finally {
      setModerationAction(null);
    }
  };

  const handleRemoveModel = async (model: ModelAsset, reason: string) => {
    resetStatus();
    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0) {
      setStatus({ type: 'error', message: 'Removal requires a brief audit note.' });
      return;
    }

    setModerationAction({ entity: 'model', action: 'remove', id: model.id });
    try {
      await api.removeModelModeration(token, model.id, { reason: trimmedReason });
      setModerationQueue((queue) =>
        queue
          ? {
              ...queue,
              models: queue.models.filter((entry) => entry.id !== model.id),
            }
          : queue,
      );
      if (activeModerationTarget?.entity === 'model' && activeModerationTarget.id === model.id) {
        closeModerationDialog();
      }
      setStatus({ type: 'success', message: `Removed "${model.title}".` });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Failed to remove the flagged model.';
      setStatus({ type: 'error', message });
    } finally {
      setModerationAction(null);
    }
  };

  const handleApproveImage = async (image: ImageAsset) => {
    resetStatus();
    setModerationAction({ entity: 'image', action: 'approve', id: image.id });
    try {
      const response = await api.approveImageModeration(token, image.id);
      setModerationQueue((queue) =>
        queue
          ? {
              ...queue,
              images: queue.images.filter((entry) => entry.id !== image.id),
            }
          : queue,
      );
      if (activeModerationTarget?.entity === 'image' && activeModerationTarget.id === image.id) {
        closeModerationDialog();
      }
      setStatus({ type: 'success', message: `Approved "${response.image.title}".` });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Failed to approve the flagged image.';
      setStatus({ type: 'error', message });
    } finally {
      setModerationAction(null);
    }
  };

  const handleRemoveImage = async (image: ImageAsset, reason: string) => {
    resetStatus();
    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0) {
      setStatus({ type: 'error', message: 'Removal requires a brief audit note.' });
      return;
    }

    setModerationAction({ entity: 'image', action: 'remove', id: image.id });
    try {
      await api.removeImageModeration(token, image.id, { reason: trimmedReason });
      setModerationQueue((queue) =>
        queue
          ? {
              ...queue,
              images: queue.images.filter((entry) => entry.id !== image.id),
            }
          : queue,
      );
      if (activeModerationTarget?.entity === 'image' && activeModerationTarget.id === image.id) {
        closeModerationDialog();
      }
      setStatus({ type: 'success', message: `Removed "${image.title}".` });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Failed to remove the flagged image.';
      setStatus({ type: 'error', message });
    } finally {
      setModerationAction(null);
    }
  };

  const handleRefreshModerationQueue = () => {
    resetStatus();
    void fetchModerationQueue();
  };

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

  const activeModelDetail = useMemo(() => {
    if (!activeModelId) {
      return null;
    }

    return models.find((model) => model.id === activeModelId) ?? null;
  }, [activeModelId, models]);

  const imageModelOptions = useMemo(() => {
    const models = new Set<string>();
    images.forEach((image) => {
      const candidate = image.metadata?.model;
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          models.add(trimmed);
        }
      }
    });

    return Array.from(models).sort((a, b) => a.localeCompare(b));
  }, [images]);

  const filteredImages = useMemo(() => {
    const metadataQuery = imageFilter.metadata.trim().toLowerCase();
    const modelQuery = imageFilter.model.trim().toLowerCase();
    const searchQuery = imageFilter.query.trim();

    const filtered = images.filter((image) => {
      const metadataValues = collectImageMetadataStrings(image.metadata);
      const imageModel =
        typeof image.metadata?.model === 'string' ? image.metadata.model.trim().toLowerCase() : '';
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

      if (modelQuery && !imageModel.includes(modelQuery)) {
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

  const activeImageDetail = useMemo(() => {
    if (!activeImageId) {
      return null;
    }

    return images.find((image) => image.id === activeImageId) ?? null;
  }, [activeImageId, images]);

  useEffect(() => {
    if (!previewAsset) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewAsset(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [previewAsset]);

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
    setActiveModelId((previous) => {
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
    setActiveModelId((previous) => (previous === model.id ? null : previous));
  };

  const handleOpenModelEdit = (model: ModelAsset) => {
    setModelToEdit(model);
    resetStatus();
  };

  const handleModelEditSuccess = async (updated: ModelAsset) => {
    setStatus({ type: 'success', message: 'Model details updated.' });
    await onRefresh();
    setActiveModelId((previous) => previous ?? updated.id);
  };

  const handleOpenVersionUpload = (model: ModelAsset) => {
    setModelForVersionUpload(model);
    resetStatus();
  };

  const handleVersionUploadSuccess = async (updated: ModelAsset) => {
    setStatus({ type: 'success', message: 'New model version uploaded.' });
    await onRefresh();
    setActiveModelId(updated.id);
  };

  const handleOpenVersionRename = (model: ModelAsset, version: ModelVersionEntry) => {
    setModelVersionToEdit({ model, version });
    resetStatus();
  };

  const handleVersionRenameSuccess = async (updated: ModelAsset) => {
    setStatus({ type: 'success', message: 'Version label updated.' });
    await onRefresh();
    setActiveModelId(updated.id);
  };

  const handleToggleModelVisibility = async (model: ModelAsset) => {
    const nextIsPublic = !model.isPublic;
    const message = nextIsPublic ? 'Model visibility set to public.' : 'Model visibility set to private.';
    await withStatus(
      () => api.updateModelAsset(token, model.id, { isPublic: nextIsPublic }).then(() => undefined),
      message,
    );
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
    setActiveImageId((previous) => (previous === image.id ? null : previous));
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
        }),
      `${ids.length} images removed.`,
    );
    setActiveImageId((previous) => {
      if (!previous) {
        return previous;
      }
      return ids.includes(previous) ? null : previous;
    });
  };

  const handleToggleImageVisibility = async (image: ImageAsset) => {
    const nextIsPublic = !image.isPublic;
    const message = nextIsPublic ? 'Image visibility set to public.' : 'Image visibility set to private.';
    await withStatus(
      () => api.updateImageAsset(token, image.id, { isPublic: nextIsPublic }).then(() => undefined),
      message,
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
              { id: 'moderation', label: 'Moderation' },
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
          {activeModelDetail ? (
            (() => {
              const modelDetails = buildModelDetail(activeModelDetail);
              return (
                <section className="admin__section admin-detail">
                  <div className="admin-detail__header">
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => setActiveModelId(null)}
                    >
                      ← Back to models
                    </button>
                    <div className="admin-detail__headline">
                      <h3>{activeModelDetail.title}</h3>
                      <p className="admin-detail__subtitle">
                        Owned by{' '}
                        {onOpenProfile ? (
                          <button
                            type="button"
                            className="curator-link"
                            onClick={() => onOpenProfile(activeModelDetail.owner.id)}
                          >
                            {activeModelDetail.owner.displayName}
                          </button>
                        ) : (
                          activeModelDetail.owner.displayName
                        )}
                      </p>
                      <div className="admin-detail__badge-row">
                        <span
                          className={`admin-badge ${
                            activeModelDetail.isPublic ? 'admin-badge--success' : 'admin-badge--muted'
                          }`}
                        >
                          {activeModelDetail.isPublic ? 'Public' : 'Private'}
                        </span>
                        <span className="admin-badge admin-badge--muted">
                          Updated {modelDetails.updatedLabel}
                        </span>
                        <span className="admin-badge admin-badge--muted">
                          {activeModelDetail.versions.length} versions
                        </span>
                        {modelDetails.fileSizeLabel ? (
                          <span className="admin-badge admin-badge--muted">{modelDetails.fileSizeLabel}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="admin-detail__actions">
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => handleOpenModelEdit(activeModelDetail)}
                        disabled={isBusy}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => handleOpenVersionUpload(activeModelDetail)}
                        disabled={isBusy}
                      >
                        New version
                      </button>
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => handleToggleModelVisibility(activeModelDetail)}
                        disabled={isBusy}
                      >
                        {activeModelDetail.isPublic ? 'Make private' : 'Make public'}
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => handleDeleteModel(activeModelDetail)}
                        disabled={isBusy}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {activeModelDetail.description ? (
                    <p className="admin-detail__description">{activeModelDetail.description}</p>
                  ) : null}
                  {activeModelDetail.trigger ? (
                    <p className="admin-detail__muted">
                      Trigger phrase: <strong>{activeModelDetail.trigger}</strong>
                    </p>
                  ) : null}
                  {activeModelDetail.tags.length > 0 ? (
                    <div className="admin-detail__tags" role="list">
                      {activeModelDetail.tags.map((tag) => (
                        <span key={tag.id} className="admin-badge" role="listitem">
                          {tag.label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="admin-collection__details">
                    <div className="admin-collection__detail-grid">
                      <div className="admin-collection__detail-column">
                        <div className="admin-collection__preview">
                          {modelDetails.previewUrl ? (
                            <button
                              type="button"
                              className="admin-detail__preview-button"
                              onClick={() =>
                                setPreviewAsset({ url: modelDetails.previewUrl ?? '', title: activeModelDetail.title })
                              }
                            >
                              <img src={modelDetails.previewUrl} alt={activeModelDetail.title} loading="lazy" />
                            </button>
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
                          <span className="admin-badge admin-badge--muted">
                            {activeModelDetail.versions.length} total
                          </span>
                        </header>
                        <ul className="admin-collection__version-list">
                          {activeModelDetail.versions.map((version) => {
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
                                    {version.id === activeModelDetail.primaryVersionId ? (
                                      <span className="admin-badge">Primary</span>
                                    ) : null}
                                    {version.id === activeModelDetail.latestVersionId ? (
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
                                  {version.id !== activeModelDetail.primaryVersionId ? (
                                    <>
                                      <button
                                        type="button"
                                        className="button button--subtle"
                                        onClick={() => handlePromoteModelVersion(activeModelDetail, version)}
                                        disabled={isBusy}
                                      >
                                        Make primary
                                      </button>
                                      <button
                                        type="button"
                                        className="button button--subtle"
                                        onClick={() => handleOpenVersionRename(activeModelDetail, version)}
                                        disabled={isBusy}
                                      >
                                        Rename
                                      </button>
                                      <button
                                        type="button"
                                        className="button button--danger"
                                        onClick={() => handleDeleteModelVersion(activeModelDetail, version)}
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
                </section>
              );
            })()
          ) : (
            <section className="admin__section">
              <div className="admin__section-header">
                <div>
                  <h3>Models library</h3>
                  <p className="admin__section-description">
                    Review LoRA assets with quick visibility controls and focused detail pages.
                  </p>
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
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Tag</span>
                  <input
                    value={modelFilter.tag}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setModelFilter((previous) => ({ ...previous, tag: value }));
                    }}
                    placeholder="Tag label"
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Metadata</span>
                  <input
                    value={modelFilter.metadata}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setModelFilter((previous) => ({ ...previous, metadata: value }));
                    }}
                    placeholder="Base model, trigger, etc."
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Visibility</span>
                  <div className="admin-collection__chip-group" role="group" aria-label="Model visibility filter">
                    <FilterChip
                      label="All"
                      isActive={modelFilter.visibility === 'all'}
                      onClick={() => setModelFilter((previous) => ({ ...previous, visibility: 'all' }))}
                      aria-pressed={modelFilter.visibility === 'all'}
                    />
                    <FilterChip
                      label="Public"
                      isActive={modelFilter.visibility === 'public'}
                      onClick={() => setModelFilter((previous) => ({ ...previous, visibility: 'public' }))}
                      aria-pressed={modelFilter.visibility === 'public'}
                    />
                    <FilterChip
                      label="Private"
                      isActive={modelFilter.visibility === 'private'}
                      onClick={() => setModelFilter((previous) => ({ ...previous, visibility: 'private' }))}
                      aria-pressed={modelFilter.visibility === 'private'}
                    />
                  </div>
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
                    <option value="title_asc">Title A–Z</option>
                    <option value="owner_asc">Owner A–Z</option>
                  </select>
                </label>
                <div className="admin__filter-chips">
                  {modelMetadataOptions.length === 0 ? (
                    <p className="admin__note">No metadata values detected yet.</p>
                  ) : (
                    <>
                      <span className="admin__filter-label">Popular metadata</span>
                      <div className="admin-collection__chip-group admin-collection__chip-group--scroll" role="group">
                        <FilterChip
                          label="All"
                          isActive={modelFilter.metadata.length === 0}
                          onClick={() => setModelFilter((previous) => ({ ...previous, metadata: '' }))}
                          aria-pressed={modelFilter.metadata.length === 0}
                        />
                        {modelMetadataOptions.map((option) => (
                          <FilterChip
                            key={option.label}
                            label={`${option.label} (${option.count})`}
                            isActive={modelFilter.metadata === option.label}
                            onClick={() => setModelFilter((previous) => ({ ...previous, metadata: option.label }))}
                            aria-pressed={modelFilter.metadata === option.label}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
              {renderSelectionToolbar(
                filteredModels.length,
                selectedModels.size,
                (checked) => toggleSelectAll(setSelectedModels, filteredModels.map((model) => model.id), checked),
                () => setSelectedModels(new Set()),
                handleBulkDeleteModels,
              )}
              {filteredModels.length === 0 ? (
                <p className="admin__empty">No models match the current filters.</p>
              ) : (
                <div className="admin-asset-grid" role="list">
                  {filteredModels.map((model) => {
                    const modelDetails = buildModelDetail(model);
                    const previewUrl = modelDetails.previewUrl;
                    return (
                      <article key={model.id} className="admin-asset-card" role="listitem">
                        <div className="admin-asset-card__header">
                          <label className="admin-asset-card__checkbox" aria-label={`Select ${model.title}`}>
                            <input
                              type="checkbox"
                              checked={selectedModels.has(model.id)}
                              onChange={(event) =>
                                toggleSelection(setSelectedModels, model.id, event.currentTarget.checked)
                              }
                              disabled={isBusy}
                            />
                            <span />
                          </label>
                          <span
                            className={`admin-asset-card__status${
                              model.isPublic ? ' admin-asset-card__status--public' : ''
                            }`}
                          >
                            {model.isPublic ? 'Public' : 'Private'}
                          </span>
                        </div>
                        <div className="admin-asset-card__preview-wrapper">
                          {previewUrl ? (
                            <button
                              type="button"
                              className="admin-asset-card__preview-button"
                              onClick={() => setPreviewAsset({ url: previewUrl, title: model.title })}
                              aria-label={`Open preview for ${model.title}`}
                            >
                              <img src={previewUrl} alt={model.title} loading="lazy" />
                            </button>
                          ) : (
                            <div className="admin-asset-card__preview-placeholder">No preview</div>
                          )}
                        </div>
                        <div className="admin-asset-card__body">
                          <h4>{model.title}</h4>
                          <span className="admin-asset-card__meta">{model.owner.displayName}</span>
                        </div>
                        <div className="admin-asset-card__actions">
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => setActiveModelId(model.id)}
                          >
                            Open details
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
                            className="button button--ghost"
                            onClick={() => handleToggleModelVisibility(model)}
                            disabled={isBusy}
                          >
                            {model.isPublic ? 'Make private' : 'Make public'}
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
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      ) : null}
      {activeTab === 'images' ? (
        <div className="admin__panel">
          {activeImageDetail ? (
            (() => {
              const imageDetails = buildImageDetail(activeImageDetail);
              const metadataEntries = [
                activeImageDetail.metadata?.seed ? { label: 'Seed', value: activeImageDetail.metadata.seed } : null,
                activeImageDetail.metadata?.model ? { label: 'Model', value: activeImageDetail.metadata.model } : null,
                activeImageDetail.metadata?.sampler ? { label: 'Sampler', value: activeImageDetail.metadata.sampler } : null,
                activeImageDetail.metadata?.cfgScale != null
                  ? { label: 'CFG', value: activeImageDetail.metadata.cfgScale.toString() }
                  : null,
                activeImageDetail.metadata?.steps != null
                  ? { label: 'Steps', value: activeImageDetail.metadata.steps.toString() }
                  : null,
              ].filter((entry): entry is { label: string; value: string } => Boolean(entry));
              return (
                <section className="admin__section admin-detail">
                  <div className="admin-detail__header">
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => setActiveImageId(null)}
                    >
                      ← Back to images
                    </button>
                    <div className="admin-detail__headline">
                      <h3>{activeImageDetail.title}</h3>
                      <p className="admin-detail__subtitle">
                        Uploaded by{' '}
                        {onOpenProfile ? (
                          <button
                            type="button"
                            className="curator-link"
                            onClick={() => onOpenProfile(activeImageDetail.owner.id)}
                          >
                            {activeImageDetail.owner.displayName}
                          </button>
                        ) : (
                          activeImageDetail.owner.displayName
                        )}
                      </p>
                      <div className="admin-detail__badge-row">
                        <span
                          className={`admin-badge ${
                            activeImageDetail.isPublic ? 'admin-badge--success' : 'admin-badge--muted'
                          }`}
                        >
                          {activeImageDetail.isPublic ? 'Public' : 'Private'}
                        </span>
                        <span className="admin-badge admin-badge--muted">
                          Updated {imageDetails.updatedLabel}
                        </span>
                        {imageDetails.dimensionsLabel ? (
                          <span className="admin-badge admin-badge--muted">{imageDetails.dimensionsLabel}</span>
                        ) : null}
                        {imageDetails.fileSizeLabel ? (
                          <span className="admin-badge admin-badge--muted">{imageDetails.fileSizeLabel}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="admin-detail__actions">
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => handleOpenImageEdit(activeImageDetail)}
                        disabled={isBusy}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => handleToggleImageVisibility(activeImageDetail)}
                        disabled={isBusy}
                      >
                        {activeImageDetail.isPublic ? 'Make private' : 'Make public'}
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => handleDeleteImage(activeImageDetail)}
                        disabled={isBusy}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {activeImageDetail.description ? (
                    <p className="admin-detail__description">{activeImageDetail.description}</p>
                  ) : null}
                  {activeImageDetail.prompt ? (
                    <div className="admin-detail__prompt">
                      <h5>Prompt</h5>
                      <p>{activeImageDetail.prompt}</p>
                    </div>
                  ) : null}
                  {activeImageDetail.negativePrompt ? (
                    <div className="admin-detail__prompt admin-detail__prompt--muted">
                      <h5>Negative prompt</h5>
                      <p>{activeImageDetail.negativePrompt}</p>
                    </div>
                  ) : null}
                  {activeImageDetail.tags.length > 0 ? (
                    <div className="admin-detail__tags" role="list">
                      {activeImageDetail.tags.map((tag) => (
                        <span key={tag.id} className="admin-badge" role="listitem">
                          {tag.label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="admin-collection__details">
                    <div className="admin-collection__detail-grid">
                      <div className="admin-collection__detail-column">
                        <div className="admin-collection__preview admin-collection__preview--image">
                          {imageDetails.previewUrl ? (
                            <button
                              type="button"
                              className="admin-detail__preview-button"
                              onClick={() =>
                                setPreviewAsset({ url: imageDetails.previewUrl ?? '', title: activeImageDetail.title })
                              }
                            >
                              <img src={imageDetails.previewUrl} alt={activeImageDetail.title} loading="lazy" />
                            </button>
                          ) : (
                            <div className="admin-collection__preview-placeholder">No preview</div>
                          )}
                        </div>
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
                        <div className="admin-collection__detail-actions">
                          {imageDetails.previewUrl ? (
                            <a
                              className="button button--subtle"
                              href={imageDetails.previewUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Preview
                            </a>
                          ) : null}
                          <a
                            className="button button--subtle"
                            href={imageDetails.downloadUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Download original
                          </a>
                        </div>
                      </div>
                      <div className="admin-collection__detail-column admin-collection__detail-column--wide">
                        <div className="admin-detail__meta-grid">
                          <div>
                            <h5>Storage</h5>
                            <dl className="admin-detail__meta-list">
                              <div>
                                <dt>Bucket</dt>
                                <dd>{activeImageDetail.storageBucket ?? '—'}</dd>
                              </div>
                              <div>
                                <dt>Object</dt>
                                <dd>{activeImageDetail.storageObject ?? activeImageDetail.storagePath}</dd>
                              </div>
                            </dl>
                          </div>
                          <div>
                            <h5>Owner</h5>
                            <dl className="admin-detail__meta-list">
                              <div>
                                <dt>Name</dt>
                                <dd>{activeImageDetail.owner.displayName}</dd>
                              </div>
                              <div>
                                <dt>Email</dt>
                                <dd>{activeImageDetail.owner.email}</dd>
                              </div>
                            </dl>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              );
            })()
          ) : (
            <section className="admin__section">
              <div className="admin__section-header">
                <div>
                  <h3>Image archive</h3>
                  <p className="admin__section-description">
                    Audit curated imagery with quick previews and streamlined visibility controls.
                  </p>
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
                    placeholder="Title, description, prompt, metadata"
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
                    placeholder="Seed, sampler…"
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Model</span>
                  <input
                    type="search"
                    list="admin-image-models"
                    value={imageFilter.model}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setImageFilter((previous) => ({ ...previous, model: value }));
                    }}
                    placeholder="Select or search a model"
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Visibility</span>
                  <div className="admin-collection__chip-group" role="group" aria-label="Image visibility filter">
                    <FilterChip
                      label="All"
                      isActive={imageFilter.visibility === 'all'}
                      onClick={() => setImageFilter((previous) => ({ ...previous, visibility: 'all' }))}
                      aria-pressed={imageFilter.visibility === 'all'}
                    />
                    <FilterChip
                      label="Public"
                      isActive={imageFilter.visibility === 'public'}
                      onClick={() => setImageFilter((previous) => ({ ...previous, visibility: 'public' }))}
                      aria-pressed={imageFilter.visibility === 'public'}
                    />
                    <FilterChip
                      label="Private"
                      isActive={imageFilter.visibility === 'private'}
                      onClick={() => setImageFilter((previous) => ({ ...previous, visibility: 'private' }))}
                      aria-pressed={imageFilter.visibility === 'private'}
                    />
                  </div>
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
                <datalist id="admin-image-models">
                  {imageModelOptions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </div>
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
                <div className="admin-asset-grid" role="list">
                  {filteredImages.map((image) => {
                    const imageDetails = buildImageDetail(image);
                    const previewUrl = imageDetails.previewUrl;
                    return (
                      <article key={image.id} className="admin-asset-card" role="listitem">
                        <div className="admin-asset-card__header">
                          <label className="admin-asset-card__checkbox" aria-label={`Select ${image.title}`}>
                            <input
                              type="checkbox"
                              checked={selectedImages.has(image.id)}
                              onChange={(event) =>
                                toggleSelection(setSelectedImages, image.id, event.currentTarget.checked)
                              }
                              disabled={isBusy}
                            />
                            <span />
                          </label>
                          <span
                            className={`admin-asset-card__status${
                              image.isPublic ? ' admin-asset-card__status--public' : ''
                            }`}
                          >
                            {image.isPublic ? 'Public' : 'Private'}
                          </span>
                        </div>
                        <div className="admin-asset-card__preview-wrapper">
                          {previewUrl ? (
                            <button
                              type="button"
                              className="admin-asset-card__preview-button"
                              onClick={() => setPreviewAsset({ url: previewUrl, title: image.title })}
                              aria-label={`Open preview for ${image.title}`}
                            >
                              <img src={previewUrl} alt={image.title} loading="lazy" />
                            </button>
                          ) : (
                            <div className="admin-asset-card__preview-placeholder">No preview</div>
                          )}
                        </div>
                        <div className="admin-asset-card__body">
                          <h4>{image.title}</h4>
                          <span className="admin-asset-card__meta">{image.owner.displayName}</span>
                        </div>
                        <div className="admin-asset-card__actions">
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => setActiveImageId(image.id)}
                          >
                            Open details
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
                            className="button button--ghost"
                            onClick={() => handleToggleImageVisibility(image)}
                            disabled={isBusy}
                          >
                            {image.isPublic ? 'Make private' : 'Make public'}
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
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      ) : null}
      {activeTab === 'moderation' ? (
        <div className="admin__panel">
          <section className="admin__section admin__section--moderation">
            <div className="admin__section-heading">
              <h3>Moderation queue</h3>
              <span className="admin__section-count">{totalModerationCount}</span>
            </div>
            <p className="moderation-queue__intro">
              Flagged models and images stay hidden from members until an administrator approves or removes them.
            </p>
            <div className="moderation-queue__toolbar">
              <button
                type="button"
                className="button button--primary moderation-queue__refresh"
                onClick={handleRefreshModerationQueue}
                disabled={isModerationLoading}
              >
                {isModerationLoading ? 'Refreshing…' : 'Refresh queue'}
              </button>
              <div className="moderation-queue__counts" role="status">
                <span>{flaggedModelCount} models</span>
                <span aria-hidden="true">•</span>
                <span>{flaggedImageCount} images</span>
              </div>
            </div>
            {moderationError ? <p className="moderation-queue__error">{moderationError}</p> : null}
            {isModerationLoading && totalModerationCount === 0 && !moderationError ? (
              <p className="moderation-queue__status">Loading moderation queue…</p>
            ) : null}
            {isModerationLoading && totalModerationCount > 0 ? (
              <p className="moderation-queue__status moderation-queue__status--inline">
                Refreshing moderation queue…
              </p>
            ) : null}
            {!isModerationLoading && totalModerationCount === 0 && !moderationError ? (
              <p className="moderation-queue__empty">No flagged assets require review right now.</p>
            ) : null}
            {totalModerationCount > 0 ? (
              <div className="moderation-queue">
                {flaggedModelCount > 0 ? (
                  <section className="moderation-queue__group" aria-labelledby="moderation-models-heading">
                    <header className="moderation-queue__group-header">
                      <h4 id="moderation-models-heading">Flagged models</h4>
                      <span className="moderation-queue__group-count" aria-label={`${flaggedModelCount} flagged models`}>
                        {flaggedModelCount}
                      </span>
                    </header>
                    <div className="moderation-queue__grid" role="list">
                      {moderationQueue?.models.map((model) => {
                        const previewUrl =
                          resolveCachedStorageUrl(
                            model.previewImage,
                            model.previewImageBucket,
                            model.previewImageObject,
                            { updatedAt: model.updatedAt, cacheKey: model.id },
                          ) ?? model.previewImage ?? null;
                        const summary = summarizeModerationReports(model.moderationReports);
                        const reporterSummary = formatCompactList(summary.reporters, { max: 3 });
                        const reasonSummary = formatCompactList(summary.reasons, {
                          max: 2,
                          separator: ' • ',
                        });
                        const flaggedLabel = formatModerationTimestamp(model.flaggedAt);
                        const isBusy =
                          moderationActionMatches('model', 'approve', model.id) ||
                          moderationActionMatches('model', 'remove', model.id) ||
                          isModerationLoading;

                        return (
                          <button
                            key={model.id}
                            type="button"
                            className="moderation-card"
                            role="listitem"
                            onClick={() => {
                              setActiveModerationTarget({ entity: 'model', id: model.id });
                              setModerationDecisionReason('');
                            }}
                            disabled={isBusy}
                            aria-label={`Review ${model.title}`}
                          >
                            <div
                              className={`moderation-card__preview${
                                previewUrl ? '' : ' moderation-card__preview--empty'
                              }`}
                            >
                              {previewUrl ? (
                                <img src={previewUrl} alt={model.title} loading="lazy" />
                              ) : (
                                <span>No preview</span>
                              )}
                              <span className="moderation-overlay moderation-overlay--visible">
                                <span className="moderation-overlay__label">In audit</span>
                              </span>
                              {summary.total > 0 ? (
                                <span className="moderation-card__badge" aria-label={`${summary.total} reports`}>
                                  {summary.total}
                                </span>
                              ) : null}
                            </div>
                            <div className="moderation-card__body">
                              <h5>{model.title}</h5>
                              <div className="moderation-card__meta">
                                <span className="moderation-card__meta-label">Owner</span>
                                <span className="moderation-card__meta-value">{model.owner.displayName}</span>
                              </div>
                              <div className="moderation-card__meta">
                                <span className="moderation-card__meta-label">Flagged</span>
                                <span className="moderation-card__meta-value">{flaggedLabel}</span>
                              </div>
                              <div className="moderation-card__meta">
                                <span className="moderation-card__meta-label">Reported by</span>
                                <span
                                  className="moderation-card__meta-value"
                                  title={reporterSummary.title}
                                >
                                  {reporterSummary.display}
                                </span>
                              </div>
                              <div className="moderation-card__meta">
                                <span className="moderation-card__meta-label">Reasons</span>
                                <span className="moderation-card__meta-value" title={reasonSummary.title}>
                                  {reasonSummary.display}
                                </span>
                              </div>
                              <div className="moderation-card__meta moderation-card__meta--accent">
                                <span className="moderation-card__meta-label">Times reported</span>
                                <span className="moderation-card__meta-value">{summary.total}</span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
                {flaggedImageCount > 0 ? (
                  <section className="moderation-queue__group" aria-labelledby="moderation-images-heading">
                    <header className="moderation-queue__group-header">
                      <h4 id="moderation-images-heading">Flagged images</h4>
                      <span className="moderation-queue__group-count" aria-label={`${flaggedImageCount} flagged images`}>
                        {flaggedImageCount}
                      </span>
                    </header>
                    <div className="moderation-queue__grid" role="list">
                      {moderationQueue?.images.map((image) => {
                        const previewUrl =
                          resolveCachedStorageUrl(
                            image.storagePath,
                            image.storageBucket,
                            image.storageObject,
                            { updatedAt: image.updatedAt, cacheKey: image.id },
                          ) ?? image.storagePath;
                        const summary = summarizeModerationReports(image.moderationReports);
                        const reporterSummary = formatCompactList(summary.reporters, { max: 3 });
                        const reasonSummary = formatCompactList(summary.reasons, {
                          max: 2,
                          separator: ' • ',
                        });
                        const flaggedLabel = formatModerationTimestamp(image.flaggedAt);
                        const isBusy =
                          moderationActionMatches('image', 'approve', image.id) ||
                          moderationActionMatches('image', 'remove', image.id) ||
                          isModerationLoading;

                        return (
                          <button
                            key={image.id}
                            type="button"
                            className="moderation-card"
                            role="listitem"
                            onClick={() => {
                              setActiveModerationTarget({ entity: 'image', id: image.id });
                              setModerationDecisionReason('');
                            }}
                            disabled={isBusy}
                            aria-label={`Review ${image.title}`}
                          >
                            <div className="moderation-card__preview">
                              <img src={previewUrl} alt={image.title} loading="lazy" />
                              <span className="moderation-overlay moderation-overlay--visible">
                                <span className="moderation-overlay__label">In audit</span>
                              </span>
                              {summary.total > 0 ? (
                                <span className="moderation-card__badge" aria-label={`${summary.total} reports`}>
                                  {summary.total}
                                </span>
                              ) : null}
                            </div>
                            <div className="moderation-card__body">
                              <h5>{image.title}</h5>
                              <div className="moderation-card__meta">
                                <span className="moderation-card__meta-label">Owner</span>
                                <span className="moderation-card__meta-value">{image.owner.displayName}</span>
                              </div>
                              <div className="moderation-card__meta">
                                <span className="moderation-card__meta-label">Flagged</span>
                                <span className="moderation-card__meta-value">{flaggedLabel}</span>
                              </div>
                              <div className="moderation-card__meta">
                                <span className="moderation-card__meta-label">Reported by</span>
                                <span
                                  className="moderation-card__meta-value"
                                  title={reporterSummary.title}
                                >
                                  {reporterSummary.display}
                                </span>
                              </div>
                              <div className="moderation-card__meta">
                                <span className="moderation-card__meta-label">Reasons</span>
                                <span className="moderation-card__meta-value" title={reasonSummary.title}>
                                  {reasonSummary.display}
                                </span>
                              </div>
                              <div className="moderation-card__meta moderation-card__meta--accent">
                                <span className="moderation-card__meta-label">Times reported</span>
                                <span className="moderation-card__meta-value">{summary.total}</span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}
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
      {selectedModerationAsset && moderationDialogAsset ? (
        <div className="modal moderation-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="moderation-detail-title">
          <div className="modal__backdrop" onClick={closeModerationDialog} aria-hidden="true" />
          <div className="modal__content moderation-detail-dialog__content">
            <header className="modal__header">
              <h2 id="moderation-detail-title">{moderationDialogAsset.title}</h2>
              <button
                type="button"
                className="modal__close"
                onClick={closeModerationDialog}
                aria-label="Close moderation dialog"
                disabled={isModerationDialogBusy}
              >
                ×
              </button>
            </header>
            <div className="modal__body moderation-detail-dialog__body">
              <div className="moderation-detail-dialog__media">
                {moderationDialogPreviewUrl ? (
                  <img src={moderationDialogPreviewUrl} alt={moderationDialogAsset.title} />
                ) : (
                  <span>No preview available</span>
                )}
              </div>
              <section className="moderation-detail-dialog__section">
                <h3>Summary</h3>
                <dl>
                  <div>
                    <dt>Type</dt>
                    <dd>{moderationDialogEntity === 'model' ? 'Model' : 'Image'}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{moderationDialogAsset.owner.displayName}</dd>
                  </div>
                  <div>
                    <dt>Flagged</dt>
                    <dd>{formatModerationTimestamp(moderationDialogAsset.flaggedAt)}</dd>
                  </div>
                  <div>
                    <dt>Times reported</dt>
                    <dd>{moderationDialogSummary.total}</dd>
                  </div>
                  <div>
                    <dt>Reported by</dt>
                    <dd>
                      {moderationDialogSummary.reporters.length > 0 ? (
                        <ul className="moderation-detail-dialog__chip-list">
                          {moderationDialogSummary.reporters.map((name) => (
                            <li key={name} className="moderation-detail-dialog__chip">
                              {name}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span>—</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Reasons</dt>
                    <dd>
                      {moderationDialogSummary.reasons.length > 0 ? (
                        <ul className="moderation-detail-dialog__chip-list">
                          {moderationDialogSummary.reasons.map((reason) => (
                            <li key={reason} className="moderation-detail-dialog__chip" title={reason}>
                              {reason}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span>—</span>
                      )}
                    </dd>
                  </div>
                  {moderationDialogEntity === 'model' ? (
                    <div>
                      <dt>Version</dt>
                      <dd>v{moderationDialogAsset.version}</dd>
                    </div>
                  ) : (
                    <div>
                      <dt>Model metadata</dt>
                      <dd>{moderationDialogAsset.metadata?.model ?? '—'}</dd>
                    </div>
                  )}
                </dl>
              </section>
              <section className="moderation-detail-dialog__section">
                <h3>Report log ({moderationDialogSummary.total})</h3>
                {moderationDialogSummary.total === 0 ? (
                  <p>No detailed reports have been recorded.</p>
                ) : (
                  <ul className="moderation-detail-dialog__report-list">
                    {moderationDialogReports.map((report) => (
                      <li key={report.id} className="moderation-detail-dialog__report">
                        <div className="moderation-detail-dialog__report-header">
                          <span>{report.reporter.displayName}</span>
                          <time dateTime={report.createdAt}>{formatModerationTimestamp(report.createdAt)}</time>
                        </div>
                        <p>{report.reason ?? 'No reason provided.'}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="moderation-detail-dialog__section">
                <h3>Decision</h3>
                <label className="moderation-detail-dialog__label" htmlFor="moderation-decision-reason">
                  Rejection note (required for rejection)
                </label>
                <textarea
                  id="moderation-decision-reason"
                  value={moderationDecisionReason}
                  onChange={(event) => setModerationDecisionReason(event.currentTarget.value)}
                  placeholder="Provide a short explanation for rejecting the asset"
                  rows={3}
                  disabled={isModerationDialogBusy}
                />
              </section>
            </div>
            <div className="modal__actions moderation-detail-dialog__actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={closeModerationDialog}
                disabled={isModerationDialogBusy}
              >
                Close
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={handleApproveSelectedAsset}
                disabled={isModerationDialogBusy || !selectedModerationAsset}
              >
                {isModerationApproveBusy ? 'Approving…' : 'Approve'}
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={handleRejectSelectedAsset}
                disabled={
                  isModerationDialogBusy || trimmedModerationDecisionReason.length === 0 || !selectedModerationAsset
                }
              >
                {isModerationRemoveBusy ? 'Rejecting…' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {previewAsset ? (
        <div
          className="admin-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`${previewAsset.title} preview`}
        >
          <div
            className="admin-preview-modal__backdrop"
            onClick={() => setPreviewAsset(null)}
            aria-hidden="true"
          />
          <div className="admin-preview-modal__content">
            <header className="admin-preview-modal__header">
              <h3>{previewAsset.title}</h3>
              <button
                type="button"
                className="admin-preview-modal__close"
                onClick={() => setPreviewAsset(null)}
                aria-label="Close preview"
              >
                ×
              </button>
            </header>
            <div className="admin-preview-modal__body">
              <img src={previewAsset.url} alt={previewAsset.title} />
            </div>
          </div>
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
