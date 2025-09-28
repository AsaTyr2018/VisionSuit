import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '../lib/api';
import { resolveCachedStorageUrl, resolveStorageUrl } from '../lib/storage';
import type {
  Gallery,
  GeneratorAccessMode,
  GeneratorBaseModelConfig,
  GeneratorFailureLogResponse,
  GeneratorRequestSummary,
  GeneratorQueueResponse,
  GeneratorSettings,
  ImageAsset,
  ModerationQueue,
  ModerationReport,
  ModelAsset,
  RankTier,
  RankingSettings,
  AdultSafetyKeyword,
  User,
  AdminSettings,
  PlatformConfig,
  MetadataThresholdPreview,
  NsfwRescanSummary,
  NsfwSnapshot,
  NsfwReason,
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

const metadataPreviewCategories = [
  {
    id: 'adult' as const,
    label: 'Adult keywords',
    note: 'LoRAs marked adult for catalog visibility and safe-mode filters.',
  },
  {
    id: 'minor' as const,
    label: 'Minor-coded keywords',
    note: 'Assets automatically hidden and queued for moderation review.',
  },
  {
    id: 'beast' as const,
    label: 'Bestiality keywords',
    note: 'Assets automatically hidden and queued for moderation review.',
  },
] as const;

type ModerationSeverity = 'BLOCKED' | 'ADULT' | 'SUGGESTIVE' | 'USER';

const moderationSeverityPriority: Record<ModerationSeverity, number> = {
  BLOCKED: 0,
  ADULT: 1,
  SUGGESTIVE: 2,
  USER: 3,
};

const moderationSeverityLabels: Record<ModerationSeverity, string> = {
  BLOCKED: 'Blocked',
  ADULT: 'Adult',
  SUGGESTIVE: 'Suggestive',
  USER: 'User flags',
};

const nsfwReasonLabels: Record<NsfwReason, string> = {
  KEYWORD: 'Keyword',
  METADATA: 'Metadata',
  OPENCV: 'OpenCV',
};

type ModerationEntry =
  | {
      entity: 'model';
      asset: ModelAsset;
      severity: ModerationSeverity;
      nsfw: NsfwSnapshot | undefined;
      flaggedAt: string | null;
    }
  | {
      entity: 'image';
      asset: ImageAsset;
      severity: ModerationSeverity;
      nsfw: NsfwSnapshot | undefined;
      flaggedAt: string | null;
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
  onPlatformConfigUpdated?: (config: PlatformConfig) => void;
}

type AdminTab =
  | 'settings'
  | 'users'
  | 'models'
  | 'images'
  | 'moderation'
  | 'generator'
  | 'galleries'
  | 'ranking'
  | 'safety';

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
type GeneratorErrorEntry = GeneratorFailureLogResponse['errors'][number];

const generatorBaseModelTypeOptions: GeneratorBaseModelConfig['type'][] = ['SD1.5', 'SDXL', 'PonyXL'];

const generatorSectionTabs = [
  {
    id: 'queue',
    label: 'Queue & blocks',
    description: 'Monitor GPU load, retry jobs, and manage temporary account blocks.',
  },
  {
    id: 'failures',
    label: 'Failure log',
    description: 'Review recent GPU agent errors with prompt and model context.',
  },
  {
    id: 'settings',
    label: 'Access & presets',
    description: 'Control who sees the generator and curate available base models.',
  },
] as const;

type GeneratorSectionTab = (typeof generatorSectionTabs)[number]['id'];

const normalizeGeneratorBaseModel = (entry: GeneratorBaseModelConfig): GeneratorBaseModelConfig => ({
  type: entry.type,
  name: entry.name.trim(),
  filename: entry.filename.trim(),
});

const summarizePrompt = (prompt: string, limit = 160) => {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  const safeLimit = Math.max(1, limit - 1);
  return `${normalized.slice(0, safeLimit)}…`;
};

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
  onPlatformConfigUpdated,
}: AdminPanelProps) => {
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isCreateUserDialogOpen, setIsCreateUserDialogOpen] = useState(false);
  const [userDialogInitialRole, setUserDialogInitialRole] = useState<User['role']>('CURATOR');
  const [roleSummary, setRoleSummary] = useState<User['role'] | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AdminSettings | null>(null);
  const [initialSettings, setInitialSettings] = useState<AdminSettings | null>(null);
  const [activeSettingsTab, setActiveSettingsTab] = useState<'general' | 'connections'>('general');
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingSafetyThresholds, setIsSavingSafetyThresholds] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [metadataPreview, setMetadataPreview] = useState<MetadataThresholdPreview | null>(null);
  const [isMetadataPreviewLoading, setIsMetadataPreviewLoading] = useState(false);
  const [metadataPreviewError, setMetadataPreviewError] = useState<string | null>(null);
  const [isRescanningNsfw, setIsRescanningNsfw] = useState(false);
  const [nsfwRescanSummary, setNsfwRescanSummary] = useState<NsfwRescanSummary | null>(null);
  const [adultKeywords, setAdultKeywords] = useState<AdultSafetyKeyword[]>([]);
  const [isAdultKeywordsLoading, setIsAdultKeywordsLoading] = useState(false);
  const [adultKeywordError, setAdultKeywordError] = useState<string | null>(null);
  const [newAdultKeyword, setNewAdultKeyword] = useState('');
  const [isCreatingAdultKeyword, setIsCreatingAdultKeyword] = useState(false);
  const [activeAdultKeywordRemoval, setActiveAdultKeywordRemoval] = useState<string | null>(null);
  const [activeGeneratorSection, setActiveGeneratorSection] = useState<GeneratorSectionTab>('queue');

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
  const [moderationSeverityFilter, setModerationSeverityFilter] = useState<'all' | ModerationSeverity>('all');
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
  const isGpuEnabledFromSettings = generatorSettings?.isGpuEnabled ?? true;
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
  const [isGpuModuleEnabled, setIsGpuModuleEnabled] = useState(isGpuEnabledFromSettings);
  const [isSavingGeneratorSettings, setIsSavingGeneratorSettings] = useState(false);
  const [generatorSettingsError, setGeneratorSettingsError] = useState<string | null>(null);
  const [generatorQueue, setGeneratorQueue] = useState<GeneratorQueueResponse | null>(null);
  const [isQueueLoading, setIsQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [isQueueActionRunning, setIsQueueActionRunning] = useState(false);
  const [queueRedispatch, setQueueRedispatch] = useState<GeneratorQueueResponse['redispatch'] | null>(null);
  const [generatorErrorLog, setGeneratorErrorLog] = useState<GeneratorErrorEntry[]>([]);
  const [generatorErrorLogTotal, setGeneratorErrorLogTotal] = useState(0);
  const [isGeneratorErrorLogLoading, setIsGeneratorErrorLogLoading] = useState(false);
  const [generatorErrorLogError, setGeneratorErrorLogError] = useState<string | null>(null);
  const [activeGeneratorRequests, setActiveGeneratorRequests] = useState<GeneratorRequestSummary[]>([]);
  const [isActiveGeneratorRequestsLoading, setIsActiveGeneratorRequestsLoading] = useState(false);
  const [activeGeneratorRequestsError, setActiveGeneratorRequestsError] = useState<string | null>(null);
  const [activeGeneratorActionId, setActiveGeneratorActionId] = useState<string | null>(null);
  const [blockUserId, setBlockUserId] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const flaggedModelCount = moderationQueue?.models.length ?? 0;
  const flaggedImageCount = moderationQueue?.images.length ?? 0;
  const totalModerationCount = flaggedModelCount + flaggedImageCount;

  const moderationEntries = useMemo<ModerationEntry[]>(() => {
    if (!moderationQueue) {
      return [];
    }

    const entries: ModerationEntry[] = [];

    const resolveSeverity = (snapshot: NsfwSnapshot | undefined, reports?: ModerationReport[] | null): ModerationSeverity => {
      if (snapshot) {
        if (snapshot.visibility === 'BLOCKED') {
          return 'BLOCKED';
        }
        if (snapshot.visibility === 'ADULT') {
          return 'ADULT';
        }
        if (snapshot.visibility === 'SUGGESTIVE' || snapshot.pendingReview) {
          return 'SUGGESTIVE';
        }
      }

      return reports && reports.length > 0 ? 'USER' : 'USER';
    };

    for (const model of moderationQueue.models) {
      entries.push({
        entity: 'model',
        asset: model,
        severity: resolveSeverity(model.nsfw, model.moderationReports),
        nsfw: model.nsfw,
        flaggedAt: model.flaggedAt ?? null,
      });
    }

    for (const image of moderationQueue.images) {
      entries.push({
        entity: 'image',
        asset: image,
        severity: resolveSeverity(image.nsfw, image.moderationReports),
        nsfw: image.nsfw,
        flaggedAt: image.flaggedAt ?? null,
      });
    }

    return entries.sort((a, b) => {
      const severityDiff = moderationSeverityPriority[a.severity] - moderationSeverityPriority[b.severity];
      if (severityDiff !== 0) {
        return severityDiff;
      }

      const aTime = a.flaggedAt ? Date.parse(a.flaggedAt) : 0;
      const bTime = b.flaggedAt ? Date.parse(b.flaggedAt) : 0;
      return bTime - aTime;
    });
  }, [moderationQueue]);

  const filteredModerationEntries = useMemo(() => {
    if (moderationSeverityFilter === 'all') {
      return moderationEntries;
    }

    return moderationEntries.filter((entry) => entry.severity === moderationSeverityFilter);
  }, [moderationEntries, moderationSeverityFilter]);

  const selectedModerationAsset = useMemo<ModerationEntry | null>(() => {
    if (!activeModerationTarget) {
      return null;
    }

    return (
      moderationEntries.find(
        (candidate) =>
          candidate.entity === activeModerationTarget.entity && candidate.asset.id === activeModerationTarget.id,
      ) ?? null
    );
  }, [activeModerationTarget, moderationEntries]);

  useEffect(() => {
    if (filteredModerationEntries.length === 0) {
      if (activeModerationTarget !== null) {
        setActiveModerationTarget(null);
      }
      return;
    }

    const currentMatch = activeModerationTarget
      ? filteredModerationEntries.some(
          (entry) =>
            entry.entity === activeModerationTarget.entity && entry.asset.id === activeModerationTarget.id,
        )
      : false;

    if (!currentMatch) {
      const [fallback] = filteredModerationEntries;
      setActiveModerationTarget({ entity: fallback.entity, id: fallback.asset.id });
    }
  }, [filteredModerationEntries, activeModerationTarget]);

  const closeModerationDialog = useCallback(() => {
    setActiveModerationTarget(null);
    setModerationDecisionReason('');
  }, []);

  const moderationDialogAsset = selectedModerationAsset?.asset ?? null;
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
  const trimmedModerationDecisionReason = moderationDecisionReason.trim();

  useEffect(() => {
    setGeneratorAccessMode((current) =>
      current === generatorAccessModeFromSettings ? current : generatorAccessModeFromSettings,
    );
  }, [generatorAccessModeFromSettings]);

  useEffect(() => {
    setBaseModelDrafts(generatorBaseModelsFromSettings);
  }, [generatorBaseModelsFromSettings]);

  useEffect(() => {
    setIsGpuModuleEnabled(isGpuEnabledFromSettings);
  }, [isGpuEnabledFromSettings]);

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
    isGpuModuleEnabled !== isGpuEnabledFromSettings ||
    JSON.stringify(normalizedBaseModelDrafts) !== JSON.stringify(normalizedSettingsBaseModels);

  const metadataThresholdsChanged = Boolean(
    settingsDraft &&
      initialSettings &&
      (settingsDraft.safety.metadataThresholds.adult !== initialSettings.safety.metadataThresholds.adult ||
        settingsDraft.safety.metadataThresholds.minor !== initialSettings.safety.metadataThresholds.minor ||
        settingsDraft.safety.metadataThresholds.beast !== initialSettings.safety.metadataThresholds.beast),
  );

  const fetchMetadataPreview = useCallback(
    async (options?: { signal?: AbortSignal; silent?: boolean }) => {
      setMetadataPreviewError(null);

      if (!token) {
        setMetadataPreview(null);
        if (!options?.silent) {
          setIsMetadataPreviewLoading(false);
        }
        return;
      }

      if (!options?.silent) {
        setIsMetadataPreviewLoading(true);
      }

      try {
        const preview = await api.getMetadataThresholdPreview(token);
        if (options?.signal?.aborted) {
          return;
        }
        setMetadataPreview(preview);
      } catch (error) {
        if (options?.signal?.aborted) {
          return;
        }
        const message =
          error instanceof ApiError
            ? error.message
            : 'Failed to load metadata screening snapshot.';
        setMetadataPreviewError(message);
        setMetadataPreview(null);
      } finally {
        if (!options?.signal?.aborted && !options?.silent) {
          setIsMetadataPreviewLoading(false);
        }
      }
    },
    [token],
  );

  const userOptions = useMemo(() => users.map((user) => ({ id: user.id, label: user.displayName })), [users]);

  useEffect(() => {
    if (activeTab !== 'generator') {
      setActiveGeneratorSection('queue');
    }
  }, [activeTab]);

  useEffect(() => {
    if (!token) {
      setSettingsDraft(null);
      setInitialSettings(null);
      setSettingsError(null);
      return;
    }

    let isMounted = true;
    setIsSettingsLoading(true);
    setSettingsError(null);

    api
      .getAdminSettings(token)
      .then((settings) => {
        if (!isMounted) {
          return;
        }
        setSettingsDraft(settings);
        setInitialSettings(settings);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        const message =
          error instanceof ApiError ? error.message : 'Failed to load platform settings.';
        setSettingsError(message);
      })
      .finally(() => {
        if (isMounted) {
          setIsSettingsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [token]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchMetadataPreview({ signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [fetchMetadataPreview]);

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

  const fetchGeneratorQueue = useCallback(async () => {
    setIsQueueLoading(true);
    setQueueError(null);
    try {
      const response = await api.getGeneratorQueue(token);
      setGeneratorQueue(response);
      setQueueRedispatch(response.redispatch ?? null);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to load generator queue.';
      setQueueError(message);
      setStatus({ type: 'error', message });
    } finally {
      setIsQueueLoading(false);
    }
  }, [token, setStatus]);

  const fetchGeneratorErrorLog = useCallback(async () => {
    setIsGeneratorErrorLogLoading(true);
    setGeneratorErrorLogError(null);
    try {
      const response = await api.getGeneratorFailureLog(token);
      setGeneratorErrorLog(response.errors);
      setGeneratorErrorLogTotal(response.total);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Failed to load generator failure log.';
      setGeneratorErrorLogError(message);
    } finally {
      setIsGeneratorErrorLogLoading(false);
    }
  }, [token]);

  const fetchActiveGeneratorRequests = useCallback(async () => {
    setIsActiveGeneratorRequestsLoading(true);
    setActiveGeneratorRequestsError(null);
    try {
      const requests = await api.getGeneratorRequests(token, 'all', { statuses: ['running', 'uploading'] });
      setActiveGeneratorRequests(requests);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Failed to load active generator jobs.';
      setActiveGeneratorRequestsError(message);
    } finally {
      setIsActiveGeneratorRequestsLoading(false);
    }
  }, [token]);

  const runQueueAction = useCallback(
    async (
      action: () => Promise<GeneratorQueueResponse>,
      successMessage: string | ((response: GeneratorQueueResponse) => string),
    ) => {
      setIsQueueActionRunning(true);
      try {
        const response = await action();
        setGeneratorQueue(response);
        setQueueRedispatch(response.redispatch ?? null);
        setQueueError(null);
        const message = typeof successMessage === 'function' ? successMessage(response) : successMessage;
        setStatus({ type: 'success', message });
        void fetchActiveGeneratorRequests();
        void fetchGeneratorErrorLog();
        return response;
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'Queue operation failed.';
        setQueueError(message);
        setStatus({ type: 'error', message });
        throw error;
      } finally {
        setIsQueueActionRunning(false);
      }
    },
    [fetchActiveGeneratorRequests, fetchGeneratorErrorLog, setStatus],
  );

  const handlePauseQueue = useCallback(() => {
    void runQueueAction(() => api.pauseGeneratorQueue(token), 'Generator queue paused.');
  }, [runQueueAction, token]);

  const handleResumeQueue = useCallback(() => {
    void runQueueAction(() => api.resumeGeneratorQueue(token), 'Generator queue resumed.');
  }, [runQueueAction, token]);

  const handleRetryQueue = useCallback(() => {
    void runQueueAction(() => api.retryGeneratorQueue(token), 'Retry dispatched for pending jobs.');
  }, [runQueueAction, token]);

  const handleClearQueue = useCallback(() => {
    void runQueueAction(
      () => api.clearGeneratorQueue(token),
      (response) => {
        const removed = response.cleared?.removed ?? 0;
        if (removed === 0) {
          return 'Queue already empty. No jobs required clearing.';
        }
        return removed === 1 ? 'Cleared 1 job from the queue.' : `Cleared ${removed} jobs from the queue.`;
      },
    );
  }, [runQueueAction, token]);

  const handleRefreshQueue = useCallback(() => {
    void fetchGeneratorQueue();
    void fetchGeneratorErrorLog();
    void fetchActiveGeneratorRequests();
  }, [fetchActiveGeneratorRequests, fetchGeneratorErrorLog, fetchGeneratorQueue]);

  const handleRefreshErrorLog = useCallback(() => {
    void fetchGeneratorErrorLog();
  }, [fetchGeneratorErrorLog]);

  const handleRefreshActiveGeneratorRequests = useCallback(() => {
    void fetchActiveGeneratorRequests();
  }, [fetchActiveGeneratorRequests]);

  const handleCancelActiveGeneratorRequest = useCallback(
    async (requestId: string) => {
      setActiveGeneratorActionId(requestId);
      try {
        const cancelled = await api.cancelGeneratorRequest(token, requestId);
        setStatus({ type: 'success', message: 'Generator job cancelled.' });
        setActiveGeneratorRequests((entries) =>
          entries.filter((entry) => entry.id !== cancelled.id),
        );
        setActiveGeneratorRequestsError(null);
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'Failed to cancel generator job.';
        setStatus({ type: 'error', message });
        setActiveGeneratorRequestsError(message);
      } finally {
        setActiveGeneratorActionId(null);
        void fetchActiveGeneratorRequests();
        void fetchGeneratorQueue();
      }
    },
    [fetchActiveGeneratorRequests, fetchGeneratorQueue, setStatus, token],
  );

  const handleBlockUserSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedId = blockUserId.trim();
      if (!trimmedId) {
        setStatus({ type: 'error', message: 'Select a user before blocking generator access.' });
        return;
      }

      const reason = blockReason.trim();
      try {
        await runQueueAction(
          () => api.blockGeneratorUser(token, { userId: trimmedId, reason: reason || undefined }),
          'User blocked from generator access.',
        );
        setBlockUserId('');
        setBlockReason('');
      } catch {
        // Feedback already handled by runQueueAction.
      }
    },
    [blockUserId, blockReason, runQueueAction, setStatus, token],
  );

  const handleUnblockUser = useCallback(
    async (userId: string) => {
      try {
        await runQueueAction(() => api.unblockGeneratorUser(token, userId), 'Generator access restored.');
      } catch {
        // Notification already handled.
      }
    },
    [runQueueAction, token],
  );

  const queueBusy = isQueueLoading || isQueueActionRunning;
  const isQueuePaused = generatorQueue?.state?.isPaused ?? false;
  const queueDeclines = generatorQueue?.state?.declineNewRequests ?? false;
  const blockedUserIds = useMemo(
    () => new Set(generatorQueue?.blocks?.map((entry) => entry.user.id) ?? []),
    [generatorQueue?.blocks],
  );
  const blockableUsers = useMemo(
    () => users.filter((user) => !blockedUserIds.has(user.id)),
    [users, blockedUserIds],
  );
  const queueActivityDetails = useMemo(() => {
    if (!generatorQueue?.activity?.data || typeof generatorQueue.activity.data !== 'object') {
      return null;
    }

    const raw = generatorQueue.activity.data as Record<string, unknown>;
    const container =
      raw.queue && typeof raw.queue === 'object' ? (raw.queue as Record<string, unknown>) : raw;

    const extractCount = (value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (Array.isArray(value)) {
        return value.length;
      }
      return null;
    };

    const pending = extractCount(container.pending ?? container.queue_pending);
    const running = extractCount(container.running ?? container.queue_running);

    return {
      pending,
      running,
      updatedAt: generatorQueue.activity?.updatedAt ?? null,
    };
  }, [generatorQueue]);
  const queueStats = generatorQueue?.globalStats ?? generatorQueue?.stats ?? null;
  const queueStatusLabel = isQueuePaused ? 'Paused' : queueDeclines ? 'Restricted' : 'Active';

  useEffect(() => {
    if (activeTab === 'generator') {
      void fetchGeneratorQueue();
      void fetchGeneratorErrorLog();
      void fetchActiveGeneratorRequests();
    }
  }, [activeTab, fetchActiveGeneratorRequests, fetchGeneratorErrorLog, fetchGeneratorQueue]);

  const updateGeneralSetting = <K extends keyof AdminSettings['general']>(
    key: K,
    value: AdminSettings['general'][K],
  ) => {
    setSettingsDraft((previous) =>
      previous
        ? {
            ...previous,
            general: {
              ...previous.general,
              [key]: value,
            },
          }
        : previous,
    );
  };

  const updateConnectionSetting = <K extends keyof AdminSettings['connections']>(
    key: K,
    value: AdminSettings['connections'][K],
  ) => {
    setSettingsDraft((previous) =>
      previous
        ? {
            ...previous,
            connections: {
              ...previous.connections,
              [key]: value,
            },
          }
        : previous,
    );
  };

  const clampThresholdValue = (value: number) => Math.max(0, Math.min(250, Math.floor(value)));

  const parseThresholdInput = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  const updateMetadataThreshold = (
    key: keyof AdminSettings['safety']['metadataThresholds'],
    value: number,
  ) => {
    setSettingsDraft((previous) =>
      previous
        ? {
            ...previous,
            safety: {
              ...previous.safety,
              metadataThresholds: {
                ...previous.safety.metadataThresholds,
                [key]: clampThresholdValue(value),
              },
            },
          }
        : previous,
    );
  };

  const handleSaveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !settingsDraft) {
      return;
    }

    setIsSavingSettings(true);
    setStatus(null);
    setSettingsError(null);

    const connectionChanged =
      initialSettings !== null &&
      (initialSettings.connections.backendHost !== settingsDraft.connections.backendHost ||
        initialSettings.connections.frontendHost !== settingsDraft.connections.frontendHost ||
        initialSettings.connections.minioEndpoint !== settingsDraft.connections.minioEndpoint ||
        initialSettings.connections.generatorNode !== settingsDraft.connections.generatorNode);

    try {
      const updated = await api.updateAdminSettings(token, settingsDraft);
      setSettingsDraft(updated);
      setInitialSettings(updated);
      setStatus({
        type: 'success',
        message: connectionChanged
          ? 'Settings saved. Restart the backend, frontend, and GPU worker to apply connection changes.'
          : 'Settings saved successfully.',
      });

      if (onPlatformConfigUpdated) {
        try {
          const platform = await api.getPlatformConfig();
          onPlatformConfigUpdated(platform);
        } catch (configError) {
          if (process.env.NODE_ENV === 'development') {
            console.warn('Failed to refresh platform config after settings update', configError);
          }
        }
      }
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to update settings.';
      setStatus({ type: 'error', message });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleSaveSafetyThresholds = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !settingsDraft) {
      return;
    }

    setIsSavingSafetyThresholds(true);
    setStatus(null);

    try {
      const updated = await api.updateAdminSettings(token, settingsDraft);
      setSettingsDraft(updated);
      setInitialSettings(updated);
      setStatus({ type: 'success', message: 'Metadata thresholds saved successfully.' });
      void fetchMetadataPreview();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to update metadata thresholds.';
      setStatus({ type: 'error', message });
    } finally {
      setIsSavingSafetyThresholds(false);
    }
  };

  const handleTriggerNsfwRescan = useCallback(async () => {
    if (!token) {
      setStatus({ type: 'error', message: 'Authentication required to trigger the NSFW rescan.' });
      return;
    }

    setIsRescanningNsfw(true);
    setStatus(null);

    try {
      const summary = await api.triggerNsfwRescan(token);
      setNsfwRescanSummary(summary);
      setStatus({ type: 'success', message: 'NSFW rescan completed successfully.' });
      void fetchMetadataPreview({ silent: true });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Failed to trigger the NSFW rescan.';
      setStatus({ type: 'error', message });
    } finally {
      setIsRescanningNsfw(false);
    }
  }, [token, fetchMetadataPreview]);

  const loadAdultKeywords = useCallback(async () => {
    if (!token) {
      setAdultKeywords([]);
      return;
    }

    setIsAdultKeywordsLoading(true);
    setAdultKeywordError(null);
    try {
      const response = await api.getAdultSafetyKeywords(token);
      setAdultKeywords(response.keywords);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : 'Failed to load adult keyword configuration. Please try again.';
      setAdultKeywordError(message);
      setAdultKeywords([]);
    } finally {
      setIsAdultKeywordsLoading(false);
    }
  }, [token]);

  const handleAddAdultKeyword = useCallback(async () => {
    if (!token) {
      setAdultKeywordError('Authentication required to add safety keywords.');
      return;
    }

    const value = newAdultKeyword.trim();
    if (value.length === 0) {
      setAdultKeywordError('Enter a keyword before adding it.');
      return;
    }

    setIsCreatingAdultKeyword(true);
    setAdultKeywordError(null);
    try {
      await api.createAdultSafetyKeyword(token, value);
      setStatus({ type: 'success', message: `Added prompt keyword "${value}".` });
      setNewAdultKeyword('');
      await loadAdultKeywords();
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Failed to add the adult safety keyword. Please try again.';
      setAdultKeywordError(message);
      setStatus({ type: 'error', message });
    } finally {
      setIsCreatingAdultKeyword(false);
    }
  }, [token, newAdultKeyword, loadAdultKeywords]);

  const handleDeleteAdultKeyword = useCallback(
    async (keyword: AdultSafetyKeyword) => {
      if (!token) {
        setAdultKeywordError('Authentication required to remove safety keywords.');
        return;
      }

      setActiveAdultKeywordRemoval(keyword.id);
      setAdultKeywordError(null);
      try {
        await api.deleteAdultSafetyKeyword(token, keyword.id);
        setStatus({ type: 'success', message: `Removed prompt keyword "${keyword.label}".` });
        await loadAdultKeywords();
      } catch (error) {
        const message =
          error instanceof ApiError ? error.message : 'Failed to remove the adult safety keyword. Please try again.';
        setAdultKeywordError(message);
        setStatus({ type: 'error', message });
      } finally {
        setActiveAdultKeywordRemoval(null);
      }
    },
    [token, loadAdultKeywords],
  );

  useEffect(() => {
    if (activeTab === 'safety') {
      loadAdultKeywords().catch((error) => console.error('Failed to load adult keyword configuration', error));
    }
  }, [activeTab, loadAdultKeywords]);

  useEffect(() => {
    if (activeTab !== 'safety' && adultKeywordError) {
      setAdultKeywordError(null);
    }
  }, [activeTab, adultKeywordError]);

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

  const handleGpuModuleToggle = (enabled: boolean) => {
    setIsGpuModuleEnabled(enabled);
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
    setIsGpuModuleEnabled(isGpuEnabledFromSettings);
    setGeneratorSettingsError(null);
    resetStatus();
  };

  const handleGeneratorSettingsSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isGeneratorDirty) {
      setStatus({
        type: 'success',
        message: 'Generator module already matches the stored configuration.',
      });
      return;
    }

    if (isGpuModuleEnabled && normalizedBaseModelDrafts.length === 0) {
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
        isGpuEnabled: isGpuModuleEnabled,
      });
      setBaseModelDrafts(updated.baseModels.map((entry) => ({ ...entry })));
      setIsGpuModuleEnabled(updated.isGpuEnabled);
      setStatus({ type: 'success', message: 'Generator module settings updated successfully.' });
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
              { id: 'settings', label: 'Settings' },
              { id: 'users', label: 'User' },
              { id: 'models', label: 'Models' },
              { id: 'images', label: 'Images' },
              { id: 'moderation', label: 'Moderation' },
              { id: 'safety', label: 'Safety' },
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
        {status && activeTab !== 'safety' ? (
          <p className={`admin__status admin__status--${status.type}`}>{status.message}</p>
        ) : null}
      </header>

      {activeTab === 'settings' ? (
        <div className="admin__panel">
          <section className="admin__section admin__section--settings">
            <div className="admin__section-header admin__section-header--split">
              <div>
                <h3>Platform settings</h3>
                <p className="admin__section-description">
                  Configure branding, public access, and service endpoints. Restart services after updating connection values.
                </p>
              </div>
              <div className="admin-settings__tabs" role="tablist" aria-label="Settings categories">
                {([
                  { id: 'general', label: 'General' },
                  { id: 'connections', label: 'Connections' },
                ] as { id: 'general' | 'connections'; label: string }[]).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`admin-settings__tab${
                      activeSettingsTab === entry.id ? ' admin-settings__tab--active' : ''
                    }`}
                    onClick={() => setActiveSettingsTab(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
            {isSettingsLoading ? (
              <p className="admin__loading">Loading settings…</p>
            ) : settingsDraft ? (
              <form className="admin__form" onSubmit={handleSaveSettings}>
                {activeSettingsTab === 'general' ? (
                  <>
                    <div className="admin__form-grid">
                      <label>
                        <span>Site title</span>
                        <input
                          type="text"
                          value={settingsDraft.general.siteTitle}
                          onChange={(event) =>
                            updateGeneralSetting('siteTitle', event.currentTarget.value)
                          }
                          placeholder="VisionSuit"
                          disabled={isSavingSettings}
                        />
                      </label>
                    </div>
                    <div className="admin-settings__toggles">
                      <label className="admin__checkbox">
                        <input
                          type="checkbox"
                          checked={settingsDraft.general.allowRegistration}
                          onChange={(event) =>
                            updateGeneralSetting('allowRegistration', event.currentTarget.checked)
                          }
                          disabled={isSavingSettings}
                        />
                        <span>Allow self-service registration</span>
                      </label>
                      <label className="admin__checkbox">
                        <input
                          type="checkbox"
                          checked={settingsDraft.general.maintenanceMode}
                          onChange={(event) =>
                            updateGeneralSetting('maintenanceMode', event.currentTarget.checked)
                          }
                          disabled={isSavingSettings}
                        />
                        <span>Enable maintenance mode (admins only)</span>
                      </label>
                      <label className="admin__checkbox">
                        <input
                          type="checkbox"
                          checked={settingsDraft.general.bypassNsfwFilter}
                          onChange={(event) =>
                            updateGeneralSetting('bypassNsfwFilter', event.currentTarget.checked)
                          }
                          disabled={isSavingSettings}
                        />
                        <span>Bypass NSFW upload filtering</span>
                      </label>
                    </div>
                  </>
                ) : (
                  <div className="admin__form-grid admin-settings__grid">
                    <label>
                      <span>Backend host/IP</span>
                      <input
                        type="text"
                        value={settingsDraft.connections.backendHost}
                        onChange={(event) =>
                          updateConnectionSetting('backendHost', event.currentTarget.value)
                        }
                        placeholder="127.0.0.1"
                        disabled={isSavingSettings}
                      />
                    </label>
                    <label>
                      <span>Frontend host/IP</span>
                      <input
                        type="text"
                        value={settingsDraft.connections.frontendHost}
                        onChange={(event) =>
                          updateConnectionSetting('frontendHost', event.currentTarget.value)
                        }
                        placeholder="127.0.0.1"
                        disabled={isSavingSettings}
                      />
                    </label>
                    <label>
                      <span>MinIO endpoint</span>
                      <input
                        type="text"
                        value={settingsDraft.connections.minioEndpoint}
                        onChange={(event) =>
                          updateConnectionSetting('minioEndpoint', event.currentTarget.value)
                        }
                        placeholder="127.0.0.1"
                        disabled={isSavingSettings}
                      />
                    </label>
                    <label>
                      <span>GPU node address</span>
                      <input
                        type="text"
                        value={settingsDraft.connections.generatorNode}
                        onChange={(event) =>
                          updateConnectionSetting('generatorNode', event.currentTarget.value)
                        }
                        placeholder="192.168.1.50:8188"
                        disabled={isSavingSettings}
                      />
                    </label>
                    <label>
                      <span>Public domain</span>
                      <input
                        type="text"
                        value={settingsDraft.connections.publicDomain}
                        onChange={(event) =>
                          updateConnectionSetting('publicDomain', event.currentTarget.value)
                        }
                        placeholder="example.com"
                        disabled={isSavingSettings}
                      />
                    </label>
                  </div>
                )}
                <div className="admin__form-actions">
                  <button type="submit" className="button button--primary" disabled={isSavingSettings}>
                    {isSavingSettings ? 'Saving…' : 'Save settings'}
                  </button>
                </div>
                <p className="admin__footnote">
                  Restart the backend, frontend, and GPU worker after changing connection values so new endpoints apply.
                </p>
              </form>
            ) : settingsError ? (
              <p className="admin__empty">{settingsError}</p>
            ) : (
              <p className="admin__empty">Settings are not available right now.</p>
            )}
          </section>
        </div>
      ) : activeTab === 'users' ? (
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

      {activeTab === 'safety' ? (
        <div className="admin__panel">
          {status && status.message ? (
            <p className={`admin__status admin__status--${status.type}`} role="status">{status.message}</p>
          ) : null}
          <section className="admin__section">
            <div className="admin__section-intro">
              <h3>Metadata thresholds</h3>
              <p>Tune the LoRA metadata scores that automatically route uploads into adult or moderation queues.</p>
            </div>
            {settingsDraft ? (
              <>
                <form className="admin__form admin__form-grid safety-threshold-form" onSubmit={handleSaveSafetyThresholds}>
                  <label className="safety-threshold-form__field">
                    <span>Adult score threshold</span>
                    <div className="safety-threshold-form__controls">
                      <input
                        type="range"
                        min={0}
                        max={250}
                        step={1}
                        value={settingsDraft.safety.metadataThresholds.adult}
                        onChange={(event) => updateMetadataThreshold('adult', parseThresholdInput(event.currentTarget.value))}
                      />
                      <input
                        type="number"
                        min={0}
                        max={250}
                        step={1}
                        value={settingsDraft.safety.metadataThresholds.adult}
                        onChange={(event) => updateMetadataThreshold('adult', parseThresholdInput(event.currentTarget.value))}
                      />
                    </div>
                    <p className="safety-threshold-form__hint">
                      LoRA metadata adult scores at or above this value mark the asset as adult.
                    </p>
                  </label>
                  <label className="safety-threshold-form__field">
                    <span>Minor keyword threshold</span>
                    <div className="safety-threshold-form__controls">
                      <input
                        type="range"
                        min={0}
                        max={250}
                        step={1}
                        value={settingsDraft.safety.metadataThresholds.minor}
                        onChange={(event) => updateMetadataThreshold('minor', parseThresholdInput(event.currentTarget.value))}
                      />
                      <input
                        type="number"
                        min={0}
                        max={250}
                        step={1}
                        value={settingsDraft.safety.metadataThresholds.minor}
                        onChange={(event) => updateMetadataThreshold('minor', parseThresholdInput(event.currentTarget.value))}
                      />
                    </div>
                    <p className="safety-threshold-form__hint">
                      Any LoRA metadata score meeting or exceeding this value is flagged for moderation as potential minor content.
                    </p>
                  </label>
                  <label className="safety-threshold-form__field">
                    <span>Bestiality keyword threshold</span>
                    <div className="safety-threshold-form__controls">
                      <input
                        type="range"
                        min={0}
                        max={250}
                        step={1}
                        value={settingsDraft.safety.metadataThresholds.beast}
                        onChange={(event) => updateMetadataThreshold('beast', parseThresholdInput(event.currentTarget.value))}
                      />
                      <input
                        type="number"
                        min={0}
                        max={250}
                        step={1}
                        value={settingsDraft.safety.metadataThresholds.beast}
                        onChange={(event) => updateMetadataThreshold('beast', parseThresholdInput(event.currentTarget.value))}
                      />
                    </div>
                    <p className="safety-threshold-form__hint">
                      Scores at or above this level immediately move the asset into the moderation queue for review.
                    </p>
                  </label>
                  <div className="admin__form-actions">
                    <button
                      type="submit"
                      className="button button--primary"
                      disabled={!metadataThresholdsChanged || isSavingSafetyThresholds}
                    >
                      {isSavingSafetyThresholds ? 'Saving…' : 'Save thresholds'}
                    </button>
                  </div>
                </form>
                <div className="safety-threshold-preview">
                  <div className="safety-threshold-preview__header">
                    <h4>Metadata screening snapshot</h4>
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => {
                        void fetchMetadataPreview();
                      }}
                      disabled={isMetadataPreviewLoading}
                    >
                      {isMetadataPreviewLoading ? 'Refreshing…' : 'Refresh snapshot'}
                    </button>
                  </div>
                  <p className="safety-threshold-preview__description">
                    Review how many stored LoRAs currently exceed the configured metadata thresholds.
                  </p>
                  {metadataPreviewError ? (
                    <p className="admin__status admin__status--error" role="alert">{metadataPreviewError}</p>
                  ) : null}
                  {isMetadataPreviewLoading ? (
                    <p className="admin__loading" role="status">
                      Calculating metadata scores…
                    </p>
                  ) : metadataPreview ? (
                    <>
                      <p className="safety-threshold-preview__meta">
                        Evaluated {metadataPreview.evaluatedModelCount} of {metadataPreview.totalModelCount} LoRAs on{' '}
                        {new Date(metadataPreview.generatedAt).toLocaleString('en-US')}.
                      </p>
                      <table className="admin__table safety-threshold-preview__table">
                        <thead>
                          <tr>
                            <th scope="col">Category</th>
                            <th scope="col">Threshold</th>
                            <th scope="col">LoRAs above limit</th>
                            <th scope="col">Sample matches</th>
                          </tr>
                        </thead>
                        <tbody>
                          {metadataPreviewCategories.map((category) => {
                            const snapshot = metadataPreview.categories[category.id];
                            return (
                              <tr key={category.id}>
                                <th scope="row">
                                  <span className="safety-threshold-preview__category">{category.label}</span>
                                  <span className="safety-threshold-preview__category-note">{category.note}</span>
                                </th>
                                <td>
                                  {snapshot.isEnabled ? (
                                    <>
                                      ≥ <strong>{snapshot.threshold}</strong>
                                    </>
                                  ) : (
                                    <span className="safety-threshold-preview__disabled">Disabled</span>
                                  )}
                                </td>
                                <td>{snapshot.isEnabled ? snapshot.matchingModelCount : '—'}</td>
                                <td>
                                  {snapshot.isEnabled ? (
                                    snapshot.sample.length > 0 ? (
                                      <ul className="safety-threshold-preview__sample-list">
                                        {snapshot.sample.map((item) => (
                                          <li key={item.id} className="safety-threshold-preview__sample-item">
                                            <span className="safety-threshold-preview__sample-title">{item.title}</span>
                                            <span className="safety-threshold-preview__sample-score">Score {item.score}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <span className="safety-threshold-preview__empty">No matches</span>
                                    )
                                  ) : (
                                    <span className="safety-threshold-preview__empty">Threshold disabled</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </>
                  ) : (
                    <p className="admin__empty">Metadata screening metrics are not available right now.</p>
                  )}
                </div>
              </>
            ) : settingsError ? (
              <p className="admin__empty">{settingsError}</p>
            ) : (
              <p className="admin__empty">Safety thresholds are not available right now.</p>
            )}
          </section>
          <section className="admin__section">
            <div className="admin__section-intro">
              <h3>NSFW rescan</h3>
              <p>Re-run the on-upload checks across existing LoRAs and gallery images.</p>
            </div>
            <div className="admin__form-actions admin__form-actions--inline">
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  void handleTriggerNsfwRescan();
                }}
                disabled={isRescanningNsfw}
              >
                {isRescanningNsfw ? 'Rescanning…' : 'Rescan catalog'}
              </button>
            </div>
            {nsfwRescanSummary ? (
              <div className="nsfw-rescan-summary">
                <table className="admin__table nsfw-rescan-summary__table">
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th scope="col">Scanned</th>
                      <th scope="col">Adult ↑</th>
                      <th scope="col">Adult ↓</th>
                      <th scope="col">Flagged</th>
                      <th scope="col">Unflagged</th>
                      <th scope="col">Errors</th>
                      <th scope="col">Analysis failures</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nsfwRescanSummary.models ? (
                      <tr>
                        <th scope="row">Models</th>
                        <td>{nsfwRescanSummary.models.scanned}</td>
                        <td>{nsfwRescanSummary.models.adultMarked}</td>
                        <td>{nsfwRescanSummary.models.adultCleared}</td>
                        <td>{nsfwRescanSummary.models.flagged}</td>
                        <td>{nsfwRescanSummary.models.unflagged}</td>
                        <td>{nsfwRescanSummary.models.errors}</td>
                        <td>—</td>
                      </tr>
                    ) : null}
                    {nsfwRescanSummary.images ? (
                      <tr>
                        <th scope="row">Images</th>
                        <td>{nsfwRescanSummary.images.scanned}</td>
                        <td>{nsfwRescanSummary.images.adultMarked}</td>
                        <td>{nsfwRescanSummary.images.adultCleared}</td>
                        <td>{nsfwRescanSummary.images.flagged}</td>
                        <td>{nsfwRescanSummary.images.unflagged}</td>
                        <td>{nsfwRescanSummary.images.errors}</td>
                        <td>{nsfwRescanSummary.images.analysisFailed}</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                <p className="admin__footnote">
                  Summary reflects the most recent rescan triggered from this session.
                </p>
              </div>
            ) : (
              <p className="admin__footnote">No NSFW rescan has run in this session.</p>
            )}
          </section>
          <section className="admin__section">
            <div className="admin__section-intro">
              <h3>Adult prompt keywords</h3>
              <p>Configure prompt keywords that automatically flag images as adult when detected in metadata.</p>
            </div>
            {adultKeywordError ? (
              <p className="admin__status admin__status--error" role="alert">{adultKeywordError}</p>
            ) : null}
            <form
              className="adult-keyword-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleAddAdultKeyword();
              }}
            >
              <label className="adult-keyword-form__field">
                <span>New keyword</span>
                <input
                  type="text"
                  value={newAdultKeyword}
                  onChange={(event) => setNewAdultKeyword(event.currentTarget.value)}
                  placeholder="e.g. explicit content phrase"
                  disabled={isCreatingAdultKeyword || isAdultKeywordsLoading}
                />
              </label>
              <button
                type="submit"
                className="button button--primary"
                disabled={isCreatingAdultKeyword || newAdultKeyword.trim().length === 0}
              >
                {isCreatingAdultKeyword ? 'Adding…' : 'Add keyword'}
              </button>
            </form>
            {isAdultKeywordsLoading ? (
              <p className="admin__loading" role="status">
                Loading keyword configuration…
              </p>
            ) : adultKeywords.length === 0 ? (
              <p className="admin__empty">No adult keywords configured yet. Add one to start scanning prompts.</p>
            ) : (
              <table className="adult-keyword-table">
                <thead>
                  <tr>
                    <th scope="col">Keyword</th>
                    <th scope="col">Created</th>
                    <th scope="col">Updated</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {adultKeywords.map((keyword) => (
                    <tr key={keyword.id}>
                      <th scope="row">{keyword.label}</th>
                      <td>{new Date(keyword.createdAt).toLocaleDateString('en-US')}</td>
                      <td>{new Date(keyword.updatedAt).toLocaleDateString('en-US')}</td>
                      <td>
                        <button
                          type="button"
                          className="button button--ghost"
                          onClick={() => handleDeleteAdultKeyword(keyword)}
                          disabled={activeAdultKeywordRemoval === keyword.id}
                        >
                          {activeAdultKeywordRemoval === keyword.id ? 'Removing…' : 'Remove'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="admin__footnote">
              Keywords are matched against prompt metadata for every upload. Any match marks the asset as adult-only for safe
              browsing controls.
            </p>
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
            <div className="moderation-queue__filters" role="toolbar" aria-label="Moderation severity filters">
              {[{ id: 'all', label: 'All' }, ...Object.entries(moderationSeverityLabels).map(([id, label]) => ({ id, label }))].map(
                (filter) => {
                  const isActive = moderationSeverityFilter === filter.id;
                  return (
                    <button
                      key={filter.id}
                      type="button"
                      className={`moderation-filter${isActive ? ' moderation-filter--active' : ''}`}
                      onClick={() => setModerationSeverityFilter(filter.id as 'all' | ModerationSeverity)}
                      aria-pressed={isActive}
                    >
                      {filter.label}
                    </button>
                  );
                },
              )}
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
              <div className="moderation-workspace">
                <aside className="moderation-workspace__queue" aria-label="Flagged assets">
                  {filteredModerationEntries.length === 0 ? (
                    <p className="moderation-workspace__empty">Nothing matches this severity filter.</p>
                  ) : (
                    <ul className="moderation-list" role="list">
                      {filteredModerationEntries.map((entry) => {
                        const asset = entry.asset;
                        const isSelected =
                          selectedModerationAsset?.entity === entry.entity &&
                          selectedModerationAsset.asset.id === asset.id;
                        const summary = summarizeModerationReports(asset.moderationReports);
                        const flaggedLabel = formatModerationTimestamp(asset.flaggedAt);
                        const isBusy = moderationActionMatches(entry.entity, 'approve', asset.id) ||
                          moderationActionMatches(entry.entity, 'remove', asset.id) ||
                          isModerationLoading;
                        const nsfw = entry.nsfw;
                        const reasonBadges = nsfw?.reasons ?? [];

                        return (
                          <li key={`${entry.entity}-${asset.id}`} className="moderation-list__item">
                            <button
                              type="button"
                              className={`moderation-list-item${isSelected ? ' moderation-list-item--active' : ''}`}
                              onClick={() => {
                                setActiveModerationTarget({ entity: entry.entity, id: asset.id });
                                setModerationDecisionReason('');
                              }}
                              disabled={isBusy}
                              aria-pressed={isSelected}
                            >
                              <div className="moderation-list-item__header">
                                <span
                                  className={`moderation-severity moderation-severity--${entry.severity.toLowerCase()}`}
                                >
                                  {moderationSeverityLabels[entry.severity]}
                                </span>
                                {nsfw?.pendingReview ? (
                                  <span className="moderation-severity moderation-severity--pending">Pending review</span>
                                ) : null}
                              </div>
                              <h4 className="moderation-list-item__title">{asset.title}</h4>
                              <p className="moderation-list-item__meta">{asset.owner.displayName}</p>
                              <p className="moderation-list-item__meta moderation-list-item__meta--muted">
                                Flagged {flaggedLabel}
                              </p>
                              <div className="moderation-list-item__badges">
                                {reasonBadges.map((reason) => (
                                  <span
                                    key={reason}
                                    className={`moderation-reason moderation-reason--${reason.toLowerCase()}`}
                                  >
                                    {nsfwReasonLabels[reason]}
                                  </span>
                                ))}
                                {asset.moderationReports && asset.moderationReports.length > 0 ? (
                                  <span className="moderation-reason moderation-reason--user">
                                    User flag
                                  </span>
                                ) : null}
                              </div>
                              <div className="moderation-list-item__footer">
                                <span>{summary.total} reports</span>
                                <span aria-hidden="true">•</span>
                                <span>{entry.entity === 'model' ? 'Model' : 'Image'}</span>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </aside>
                <div className="moderation-workspace__detail">
                  {selectedModerationAsset ? (
                    <div className="moderation-detail" aria-live="polite">
                      <header className="moderation-detail__header">
                        <h3>{selectedModerationAsset.asset.title}</h3>
                        <div className="moderation-detail__badges">
                          <span
                            className={`moderation-severity moderation-severity--${selectedModerationAsset.severity.toLowerCase()}`}
                          >
                            {moderationSeverityLabels[selectedModerationAsset.severity]}
                          </span>
                          {selectedModerationAsset.nsfw?.pendingReview ? (
                            <span className="moderation-severity moderation-severity--pending">Pending review</span>
                          ) : null}
                        </div>
                      </header>
                      <div className="moderation-detail__body">
                        <div className="moderation-detail__media">
                          {selectedModerationAsset.entity === 'model' ? (
                            moderationDialogPreviewUrl ? (
                              <img src={moderationDialogPreviewUrl} alt={selectedModerationAsset.asset.title} />
                            ) : (
                              <div className="moderation-detail__media-placeholder" aria-hidden="true" />
                            )
                          ) : moderationDialogPreviewUrl ? (
                            <img src={moderationDialogPreviewUrl} alt={selectedModerationAsset.asset.title} />
                          ) : (
                            <div className="moderation-detail__media-placeholder" aria-hidden="true" />
                          )}
                        </div>
                        <div className="moderation-detail__summary">
                          <dl className="moderation-detail__facts">
                            <div>
                              <dt>Type</dt>
                              <dd>{selectedModerationAsset.entity === 'model' ? 'Model' : 'Image'}</dd>
                            </div>
                            <div>
                              <dt>Owner</dt>
                              <dd>{selectedModerationAsset.asset.owner.displayName}</dd>
                            </div>
                            <div>
                              <dt>Flagged</dt>
                              <dd>{formatModerationTimestamp(selectedModerationAsset.asset.flaggedAt)}</dd>
                            </div>
                            <div>
                              <dt>Reports</dt>
                              <dd>{moderationDialogSummary.total}</dd>
                            </div>
                          </dl>
                          <div className="moderation-detail__badges-row">
                            {(selectedModerationAsset.nsfw?.reasons ?? []).map((reason) => (
                              <span
                                key={reason}
                                className={`moderation-reason moderation-reason--${reason.toLowerCase()}`}
                              >
                                {nsfwReasonLabels[reason]}
                              </span>
                            ))}
                            {selectedModerationAsset.asset.moderationReports &&
                            selectedModerationAsset.asset.moderationReports.length > 0 ? (
                              <span className="moderation-reason moderation-reason--user">User flag</span>
                            ) : null}
                          </div>
                          {selectedModerationAsset.nsfw ? (
                            <div className="moderation-detail__nsfw">
                              <h4>NSFW signals</h4>
                              <dl>
                                <div>
                                  <dt>Visibility</dt>
                                  <dd>{selectedModerationAsset.nsfw.visibility}</dd>
                                </div>
                                <div>
                                  <dt>Adult score</dt>
                                  <dd>
                                    {selectedModerationAsset.nsfw.signals.moderationAdultScore !== null
                                      ? selectedModerationAsset.nsfw.signals.moderationAdultScore.toFixed(2)
                                      : '—'}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Suggestive score</dt>
                                  <dd>
                                    {selectedModerationAsset.nsfw.signals.moderationSuggestiveScore !== null
                                      ? selectedModerationAsset.nsfw.signals.moderationSuggestiveScore.toFixed(2)
                                      : '—'}
                                  </dd>
                                </div>
                                {selectedModerationAsset.nsfw.metadata ? (
                                  <div>
                                    <dt>Metadata scores</dt>
                                    <dd>
                                      adult {selectedModerationAsset.nsfw.metadata.adultScore ?? '0'} • minor {selectedModerationAsset.nsfw.metadata.minorScore ?? '0'} • beast {selectedModerationAsset.nsfw.metadata.beastScore ?? '0'}
                                    </dd>
                                  </div>
                                ) : null}
                              </dl>
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="moderation-detail__actions">
                        <button
                          type="button"
                          className="button"
                          onClick={() => closeModerationDialog()}
                        >
                          Deselect
                        </button>
                        <div className="moderation-detail__action-buttons">
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => {
                              setModerationDecisionReason('');
                              if (selectedModerationAsset.entity === 'model') {
                                void handleApproveModel(selectedModerationAsset.asset);
                              } else {
                                void handleApproveImage(selectedModerationAsset.asset);
                              }
                            }}
                            disabled={isModerationApproveBusy}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="button button--danger"
                            onClick={() => {
                              if (!trimmedModerationDecisionReason) {
                                return;
                              }
                              if (selectedModerationAsset.entity === 'model') {
                                void handleRemoveModel(
                                  selectedModerationAsset.asset,
                                  trimmedModerationDecisionReason,
                                );
                              } else {
                                void handleRemoveImage(
                                  selectedModerationAsset.asset,
                                  trimmedModerationDecisionReason,
                                );
                              }
                            }}
                            disabled={
                              isModerationRemoveBusy || trimmedModerationDecisionReason.length === 0 || !selectedModerationAsset
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      <div className="moderation-detail__notes">
                        <label htmlFor="moderation-decision-reason">Removal reason</label>
                        <textarea
                          id="moderation-decision-reason"
                          value={moderationDecisionReason}
                          onChange={(event) => setModerationDecisionReason(event.currentTarget.value)}
                          rows={3}
                          placeholder="Explain why this asset is being removed."
                        />
                      </div>
                      <section className="moderation-detail__section">
                        <h4>Report log ({moderationDialogSummary.total})</h4>
                        {moderationDialogSummary.total === 0 ? (
                          <p>No community reports were filed for this asset.</p>
                        ) : (
                          <ul className="moderation-detail-dialog__report-list">
                            {moderationDialogReports.map((report) => (
                              <li key={report.id} className="moderation-detail-dialog__report">
                                <div className="moderation-detail-dialog__report-header">
                                  <span>{report.reporter.displayName}</span>
                                  <time dateTime={report.createdAt}>{formatModerationTimestamp(report.createdAt)}</time>
                                </div>
                                {report.reason ? <p>{report.reason}</p> : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    </div>
                  ) : (
                    <p className="moderation-workspace__empty">Select a flagged asset to review details.</p>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {activeTab === 'generator' ? (
        <div className="admin__panel admin__panel--generator">
          <section className="admin__section admin__section--generator-overview">
            <div className="admin__section-intro">
              <h3>Generator administration</h3>
              <p>
                Focus queue operations, telemetry, or access presets with the controls below—no more endless scrolling through
                every tool at once.
              </p>
            </div>
            <nav className="generator-subnav" aria-label="Generator administration sections">
              {generatorSectionTabs.map((tab) => {
                const isActive = activeGeneratorSection === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`generator-subnav__tab${isActive ? ' generator-subnav__tab--active' : ''}`}
                    onClick={() => setActiveGeneratorSection(tab.id)}
                    aria-pressed={isActive}
                  >
                    <span>{tab.label}</span>
                    <small>{tab.description}</small>
                  </button>
                );
              })}
            </nav>
          </section>
          {activeGeneratorSection === 'queue' ? (
            <section className="admin__section admin__section--generator-queue">
              <div className="admin__section-intro">
                <h3>Queue maintenance</h3>
                <p>Pause GPU dispatch, retry held jobs, and temporarily block members while investigating issues.</p>
              </div>
            <div className="generator-queue__summary" role="status">
              <div className="generator-queue__status">
                <span
                  className={`generator-queue__status-indicator generator-queue__status-indicator--${
                    isQueuePaused ? 'paused' : 'active'
                  }`}
                  aria-hidden="true"
                />
                <strong>{queueStatusLabel}</strong>
                {isQueueLoading ? <small>Refreshing…</small> : null}
                {generatorQueue?.state.pausedAt && isQueuePaused ? (
                  <small>since {new Date(generatorQueue.state.pausedAt).toLocaleString()}</small>
                ) : null}
              </div>
              <div className="generator-queue__metrics">
                <span>
                  Pending <strong>{queueStats?.pending ?? 0}</strong>
                </span>
                <span>
                  Running <strong>{queueStats?.running ?? 0}</strong>
                </span>
                <span>
                  Queued <strong>{queueStats?.queued ?? 0}</strong>
                </span>
                <span>
                  Failed <strong>{queueStats?.failed ?? 0}</strong>
                </span>
              </div>
              {queueActivityDetails ? (
                <div className="generator-queue__activity">
                  <span>
                    GPU activity:{' '}
                    <strong>{queueActivityDetails.running ?? '—'}</strong> running ·{' '}
                    <strong>{queueActivityDetails.pending ?? '—'}</strong> waiting
                  </span>
                  {queueActivityDetails.updatedAt ? (
                    <small>
                      Updated {new Date(queueActivityDetails.updatedAt).toLocaleTimeString()}
                    </small>
                  ) : null}
                </div>
              ) : null}
            </div>
            {queueRedispatch ? (
              <p className="generator-queue__note">
                Last retry attempted {queueRedispatch.attempted} job(s) — queued {queueRedispatch.queued}, busy{' '}
                {queueRedispatch.busy}
                {queueRedispatch.errors?.length
                  ? `, errors ${queueRedispatch.errors.length}`
                  : ''}
                .
              </p>
            ) : null}
            {queueError ? <p className="generator-queue__error">{queueError}</p> : null}
            <div className="generator-queue__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={isQueuePaused ? handleResumeQueue : handlePauseQueue}
                disabled={queueBusy}
              >
                {isQueuePaused ? 'Resume queue' : 'Pause queue'}
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={handleRetryQueue}
                disabled={queueBusy || isQueuePaused}
              >
                Retry pending jobs
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={handleClearQueue}
                disabled={queueBusy}
              >
                Clear active queue
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={handleRefreshQueue}
                disabled={isQueueLoading}
              >
                Refresh status
              </button>
            </div>
            <section className="generator-queue__active" aria-live="polite">
              <div className="generator-queue__active-header">
                <h4>Active jobs</h4>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={handleRefreshActiveGeneratorRequests}
                  disabled={isActiveGeneratorRequestsLoading}
                >
                  {isActiveGeneratorRequestsLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
              {activeGeneratorRequestsError ? (
                <p className="generator-queue__error">{activeGeneratorRequestsError}</p>
              ) : null}
              {isActiveGeneratorRequestsLoading &&
              activeGeneratorRequests.length === 0 &&
              !activeGeneratorRequestsError ? (
                <p className="generator-queue__status-message">Loading active jobs…</p>
              ) : null}
              {!isActiveGeneratorRequestsLoading &&
              activeGeneratorRequests.length === 0 &&
              !activeGeneratorRequestsError ? (
                <p className="generator-queue__empty">No jobs are currently running.</p>
              ) : null}
              {activeGeneratorRequests.length > 0 ? (
                <ul className="generator-queue__active-list">
                  {activeGeneratorRequests.map((request) => {
                    const jobBaseModels =
                      request.baseModels.length > 0
                        ? request.baseModels
                        : [
                            {
                              id: request.baseModel.id,
                              name: request.baseModel.title,
                              type: null,
                              title: request.baseModel.title,
                              slug: request.baseModel.slug,
                              version: request.baseModel.version,
                              filename: null,
                            },
                          ];
                    const baseModelSummary = jobBaseModels
                      .map((entry) => entry.name)
                      .filter((value): value is string => Boolean(value))
                      .join(', ');
                    const createdAt = new Date(request.createdAt);
                    const statusLabel = request.status.replace(/_/g, ' ');
                    const promptPreview = summarizePrompt(request.prompt);
                    const isCancelling = activeGeneratorActionId === request.id;
                    return (
                      <li key={request.id} className="generator-queue__active-item">
                        <div className="generator-queue__active-body">
                          <div className="generator-queue__active-title">
                            <span
                              className={`generator-history__status-tag generator-history__status-tag--${request.status}`}
                            >
                              {statusLabel}
                            </span>
                            <strong>{jobBaseModels[0]?.name ?? request.baseModel.title}</strong>
                          </div>
                          <p className="generator-queue__active-meta">
                            Requested by <strong>{request.owner.displayName}</strong> ·{' '}
                            <span>{createdAt.toLocaleString()}</span>
                          </p>
                          <p className="generator-queue__active-meta">
                            Dimensions {request.width} × {request.height}
                            {baseModelSummary ? ` • ${baseModelSummary}` : ''}
                          </p>
                          {promptPreview ? (
                            <p className="generator-queue__active-prompt" title={request.prompt}>
                              {promptPreview}
                            </p>
                          ) : null}
                        </div>
                        <div className="generator-queue__active-actions">
                          <button
                            type="button"
                            className="button button--danger"
                            onClick={() => handleCancelActiveGeneratorRequest(request.id)}
                            disabled={isCancelling}
                          >
                            {isCancelling ? 'Cancelling…' : 'Cancel job'}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
            <form className="generator-queue__block-form" onSubmit={handleBlockUserSubmit}>
              <div className="generator-queue__block-fields">
                <label>
                  <span>User</span>
                  <select
                    value={blockUserId}
                    onChange={(event) => setBlockUserId(event.target.value)}
                    disabled={queueBusy || blockableUsers.length === 0}
                  >
                    <option value="">Select account</option>
                    {blockableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName} ({user.role.toLowerCase()})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Reason (optional)</span>
                  <input
                    type="text"
                    value={blockReason}
                    onChange={(event) => setBlockReason(event.target.value)}
                    placeholder="Document why access is blocked"
                    disabled={queueBusy}
                  />
                </label>
              </div>
              <div className="generator-queue__block-actions">
                <button
                  type="submit"
                  className="button button--ghost"
                  disabled={queueBusy || blockableUsers.length === 0}
                >
                  Block user
                </button>
              </div>
            </form>
            <div className="generator-queue__blocked-list">
              <h4>Blocked users</h4>
              {generatorQueue?.blocks && generatorQueue.blocks.length > 0 ? (
                <ul className="generator-queue__blocked-items">
                  {generatorQueue.blocks.map((block) => (
                    <li key={block.user.id} className="generator-queue__blocked-entry">
                      <div>
                        <strong>{block.user.displayName}</strong>{' '}
                        <span className="generator-queue__blocked-role">
                          ({block.user.role.toLowerCase()})
                        </span>
                        {block.reason ? (
                          <p className="generator-queue__blocked-reason">{block.reason}</p>
                        ) : (
                          <p className="generator-queue__blocked-reason generator-queue__blocked-reason--muted">
                            No reason provided.
                          </p>
                        )}
                        <small>Blocked {new Date(block.createdAt).toLocaleString()}</small>
                      </div>
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => handleUnblockUser(block.user.id)}
                        disabled={queueBusy}
                      >
                        Unblock
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="generator-queue__empty">No users are currently blocked from generating.</p>
              )}
            </div>
          </section>
          ) : null}
          {activeGeneratorSection === 'failures' ? (
            <section className="admin__section admin__section--generator-errors">
              <div className="admin__section-intro">
                <h3>Generation failure log</h3>
                <p>Inspect recent GPU agent errors. Detailed diagnostics remain available only to administrators.</p>
              </div>
              <div className="generator-errors__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={handleRefreshErrorLog}
                  disabled={isGeneratorErrorLogLoading}
                >
                  {isGeneratorErrorLogLoading ? 'Refreshing…' : 'Refresh log'}
                </button>
                <span>
                  Showing <strong>{generatorErrorLog.length}</strong> of{' '}
                  <strong>{generatorErrorLogTotal}</strong> failures
                </span>
              </div>
              {generatorErrorLogError ? (
                <p className="generator-errors__error">{generatorErrorLogError}</p>
              ) : null}
              {isGeneratorErrorLogLoading ? (
                <p className="generator-errors__status">Loading failure log…</p>
              ) : null}
              {!isGeneratorErrorLogLoading && generatorErrorLog.length === 0 && !generatorErrorLogError ? (
                <p className="generator-errors__empty">No generator failures recorded in the selected window.</p>
              ) : null}
              {generatorErrorLog.length > 0 ? (
                <ul className="generator-errors__list">
                  {generatorErrorLog.map((entry) => {
                    const failureMoment = new Date(entry.updatedAt);
                    const detail = entry.errorDetail ?? entry.errorReason ?? 'Reason not provided.';
                    const baseSummary =
                      entry.baseModels.length > 0
                        ? entry.baseModels.map((model) => model.name).join(', ')
                        : entry.baseModel.title;
                    return (
                      <li key={entry.id} className="generator-errors__item">
                        <header className="generator-errors__item-header">
                          <div>
                            <strong>{entry.owner.displayName}</strong>
                            <span
                              className={`generator-errors__status-tag generator-errors__status-tag--${entry.status.toLowerCase()}`}
                            >
                              {entry.status.replace(/_/g, ' ')}
                            </span>
                          </div>
                          <time dateTime={entry.updatedAt}>{failureMoment.toLocaleString()}</time>
                        </header>
                        <p className="generator-errors__item-reason">{detail}</p>
                        <dl className="generator-errors__meta">
                          <div>
                            <dt>Job ID</dt>
                            <dd>{entry.id}</dd>
                          </div>
                          <div>
                            <dt>Base models</dt>
                            <dd>{baseSummary}</dd>
                          </div>
                          <div>
                            <dt>Prompt</dt>
                            <dd>{entry.prompt}</dd>
                          </div>
                          <div>
                            <dt>Resolution</dt>
                            <dd>
                              {entry.width} × {entry.height}
                            </dd>
                          </div>
                        </dl>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          ) : null}
          {activeGeneratorSection === 'settings' ? (
            <>
              <section className="admin__section admin__section--generator">
                <div className="admin__section-intro">
                  <h3>Access & presets</h3>
                  <p>
                    Decide who sees the generator entry in the sidebar and curate the checkpoint presets exposed to the wizard.
                  </p>
                </div>
                <form className="generator-settings" onSubmit={handleGeneratorSettingsSubmit}>
                  <div className="generator-settings__switch">
                    <div className="generator-settings__switch-copy">
                      <h4>GPU module</h4>
                      <p>
                        Disable the GPU agent to hide the On-Site Generator and surface the module as
                        <em>Deactivated</em> on the live status page.
                      </p>
                    </div>
                    <label
                      className={`generator-settings__switch-toggle${
                        isGpuModuleEnabled ? ' generator-settings__switch-toggle--active' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isGpuModuleEnabled}
                        onChange={(event) => handleGpuModuleToggle(event.target.checked)}
                      />
                      <span>{isGpuModuleEnabled ? 'Enabled' : 'Disabled'}</span>
                    </label>
                  </div>
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
            </>
          ) : null}
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
