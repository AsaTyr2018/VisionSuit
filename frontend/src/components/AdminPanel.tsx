import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '../lib/api';
import { resolveStorageUrl } from '../lib/storage';
import type { Gallery, ImageAsset, ModelAsset, RankTier, RankingSettings, User } from '../types/api';
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
}

type AdminTab = 'users' | 'models' | 'images' | 'galleries' | 'ranking';

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

const parseCommaList = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

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
  const [modelFilter, setModelFilter] = useState<{ query: string; owner: FilterValue<string>; tag: string }>({
    query: '',
    owner: 'all',
    tag: '',
  });
  const [imageFilter, setImageFilter] = useState<{ query: string; owner: FilterValue<string> }>({ query: '', owner: 'all' });
  const [galleryFilter, setGalleryFilter] = useState<{
    query: string;
    owner: FilterValue<string>;
    visibility: FilterValue<VisibilityFilter>;
  }>({ query: '', owner: 'all', visibility: 'all' });

  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);
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

  const filteredModels = useMemo(() => {
    const tagQuery = modelFilter.tag.trim().toLowerCase();

    return models.filter((model) => {
      const metadataMatches =
        modelFilter.query.trim().length > 0 &&
        collectModelMetadataStrings(model.metadata).some((value) => matchText(value, modelFilter.query));

      const matchesQuery =
        matchText(model.title, modelFilter.query) ||
        matchText(model.description ?? '', modelFilter.query) ||
        matchText(model.version, modelFilter.query) ||
        matchText(model.owner.displayName, modelFilter.query) ||
        matchText(model.trigger ?? '', modelFilter.query) ||
        metadataMatches;

      if (!matchesQuery) {
        return false;
      }

      if (modelFilter.owner !== 'all' && model.owner.id !== modelFilter.owner) {
        return false;
      }

      if (tagQuery && !getTagLabels(model.tags).some((tag) => tag.includes(tagQuery))) {
        return false;
      }

      return true;
    });
  }, [models, modelFilter]);

  const activeModel = useMemo(() => {
    if (!activeModelId) {
      return null;
    }

    return models.find((model) => model.id === activeModelId) ?? null;
  }, [models, activeModelId]);

  const activeModelDetails = useMemo(() => {
    if (!activeModel) {
      return null;
    }

    const previewUrl =
      resolveStorageUrl(activeModel.previewImage, activeModel.previewImageBucket, activeModel.previewImageObject) ??
      activeModel.previewImage ??
      null;
    const downloadUrl =
      resolveStorageUrl(activeModel.storagePath, activeModel.storageBucket, activeModel.storageObject) ??
      activeModel.storagePath;
    const updatedLabel = new Date(activeModel.updatedAt).toLocaleDateString('en-US');
    const fileSizeLabel = formatFileSize(activeModel.fileSize);
    const versionCount = activeModel.versions.length;
    const metadataEntries = [
      { label: 'Slug', value: activeModel.slug },
      activeModel.storageBucket ? { label: 'Bucket', value: activeModel.storageBucket } : null,
      {
        label: 'Storage object',
        value: activeModel.storageObject ?? activeModel.storagePath,
        href: downloadUrl,
      },
      {
        label: 'Checksum',
        value: activeModel.checksum ?? '—',
      },
    ].filter((entry): entry is { label: string; value: string; href?: string } => Boolean(entry));

    return {
      previewUrl,
      downloadUrl,
      updatedLabel,
      fileSizeLabel,
      versionCount,
      metadataEntries,
    };
  }, [activeModel]);

  useEffect(() => {
    if (!activeModelId) {
      return;
    }

    const isVisible = filteredModels.some((model) => model.id === activeModelId);
    if (!isVisible) {
      setActiveModelId(null);
    }
  }, [activeModelId, filteredModels]);

  const filteredImages = useMemo(() => {
    return images.filter((image) => {
      const metadataMatches =
        imageFilter.query.trim().length > 0 &&
        collectImageMetadataStrings(image.metadata).some((value) => matchText(value, imageFilter.query));
      const matchesQuery =
        matchText(image.title, imageFilter.query) ||
        matchText(image.description ?? '', imageFilter.query) ||
        matchText(image.prompt ?? '', imageFilter.query) ||
        matchText(image.negativePrompt ?? '', imageFilter.query) ||
        metadataMatches ||
        getTagLabels(image.tags).some((tag) => tag.includes(imageFilter.query.toLowerCase()));

      if (!matchesQuery) {
        return false;
      }

      if (imageFilter.owner !== 'all' && image.owner.id !== imageFilter.owner) {
        return false;
      }

      return true;
    });
  }, [images, imageFilter]);

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

  const handleUpdateModel = async (event: FormEvent<HTMLFormElement>, model: ModelAsset) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const title = (formData.get('title') as string | null)?.trim();
    const version = (formData.get('version') as string | null)?.trim();
    const trigger = (formData.get('trigger') as string | null)?.trim();
    const description = (formData.get('description') as string | null)?.trim();
    const tagsValue = (formData.get('tags') as string | null) ?? '';
    const ownerId = (formData.get('ownerId') as string | null) ?? model.owner.id;

    const payload = {
      title: title ?? undefined,
      version: version ?? undefined,
      trigger: trigger && trigger.length > 0 ? trigger : null,
      description: description && description.length > 0 ? description : null,
      tags: parseCommaList(tagsValue),
      ownerId,
    };

    await withStatus(() => api.updateModelAsset(token, model.id, payload), 'Model updated.');
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

  const handleRenameModelVersion = async (model: ModelAsset, version: ModelAsset['versions'][number]) => {
    const original = version.version.trim();
    const nextLabel = window.prompt('Enter a new label for this version', original);

    if (nextLabel === null) {
      return;
    }

    const trimmed = nextLabel.trim();
    if (trimmed.length === 0) {
      setStatus({ type: 'error', message: 'Version label cannot be empty.' });
      return;
    }

    if (trimmed === original) {
      return;
    }

    await withStatus(
      () => api.updateModelVersion(token, model.id, version.id, { version: trimmed }).then(() => undefined),
      'Version label updated.',
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
    setActiveModelId(null);
  };

  const handleUpdateImage = async (event: FormEvent<HTMLFormElement>, image: ImageAsset) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const title = (formData.get('title') as string | null)?.trim();
    const description = (formData.get('description') as string | null)?.trim();
    const prompt = (formData.get('prompt') as string | null)?.trim();
    const negativePrompt = (formData.get('negativePrompt') as string | null)?.trim();
    const tagsValue = (formData.get('tags') as string | null) ?? '';
    const ownerId = (formData.get('ownerId') as string | null) ?? image.owner.id;
    const seed = (formData.get('seed') as string | null)?.trim();
    const modelName = (formData.get('model') as string | null)?.trim();
    const sampler = (formData.get('sampler') as string | null)?.trim();
    const cfgScaleRaw = (formData.get('cfgScale') as string | null)?.trim();
    const stepsRaw = (formData.get('steps') as string | null)?.trim();
    const cfgScale = cfgScaleRaw && cfgScaleRaw.length > 0 ? Number.parseFloat(cfgScaleRaw) : null;
    const steps = stepsRaw && stepsRaw.length > 0 ? Number.parseInt(stepsRaw, 10) : null;

    const payload = {
      title: title ?? undefined,
      description: description && description.length > 0 ? description : null,
      prompt: prompt && prompt.length > 0 ? prompt : null,
      negativePrompt: negativePrompt && negativePrompt.length > 0 ? negativePrompt : null,
      tags: parseCommaList(tagsValue),
      ownerId,
      metadata: {
        seed: seed && seed.length > 0 ? seed : null,
        model: modelName && modelName.length > 0 ? modelName : null,
        sampler: sampler && sampler.length > 0 ? sampler : null,
        cfgScale: cfgScale !== null && !Number.isNaN(cfgScale) ? cfgScale : null,
        steps: steps !== null && !Number.isNaN(steps) ? steps : null,
      },
    };

    await withStatus(() => api.updateImageAsset(token, image.id, payload), 'Image updated.');
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
            <div className="admin__section-header">
              <h3>Manage models</h3>
              <div className="admin__filters">
                <label>
                  <span>Search</span>
                  <input
                    type="search"
                    value={modelFilter.query}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setModelFilter((previous) => ({ ...previous, query: value }));
                    }}
                    placeholder="Title, description, or owner"
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
              <p className="admin__empty">No models available.</p>
            ) : (
              <div className="admin-model-grid" role="list">
                {filteredModels.map((model) => {
                  const previewUrl =
                    resolveStorageUrl(model.previewImage, model.previewImageBucket, model.previewImageObject) ??
                    model.previewImage ??
                    null;
                  const isActive = activeModelId === model.id;

                  return (
                    <article
                      key={model.id}
                      className={`admin-model-card${isActive ? ' admin-model-card--active' : ''}`}
                      role="listitem"
                    >
                      <label className="admin-model-card__checkbox">
                        <input
                          type="checkbox"
                          checked={selectedModels.has(model.id)}
                          onChange={(event) =>
                            toggleSelection(setSelectedModels, model.id, event.currentTarget.checked)
                          }
                          disabled={isBusy}
                          aria-label={`Select ${model.title}`}
                        />
                        <span className="sr-only">Select {model.title}</span>
                      </label>
                      <div className="admin-model-card__media">
                        {previewUrl ? (
                          <img src={previewUrl} alt={model.title} loading="lazy" />
                        ) : (
                          <div className="admin-model-card__placeholder">No preview</div>
                        )}
                      </div>
                      <h4 className="admin-model-card__title">{model.title}</h4>
                      <button
                        type="button"
                        className="button button--primary admin-model-card__manage"
                        onClick={() => setActiveModelId(model.id)}
                        aria-controls="admin-model-mainframe"
                      >
                        Manage
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          {activeModel && activeModelDetails ? (
            <section
              className="admin__section admin-model-mainframe"
              id="admin-model-mainframe"
              aria-labelledby="admin-model-mainframe-title"
            >
              <div className="admin-model-mainframe__header">
                <div>
                  <h3 id="admin-model-mainframe-title">{activeModel.title}</h3>
                  <p className="admin-model-mainframe__subtitle">
                    Owned by{' '}
                    {onOpenProfile ? (
                      <button
                        type="button"
                        className="curator-link"
                        onClick={() => onOpenProfile(activeModel.owner.id)}
                      >
                        {activeModel.owner.displayName}
                      </button>
                    ) : (
                      activeModel.owner.displayName
                    )}
                  </p>
                </div>
                <div className="admin-model-mainframe__actions">
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setActiveModelId(null)}
                    disabled={isBusy}
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="admin-model-mainframe__layout">
                <div className="admin-model-mainframe__overview">
                  <div className="admin-model-mainframe__media admin-model-card__media">
                    {activeModelDetails.previewUrl ? (
                      <img src={activeModelDetails.previewUrl} alt={activeModel.title} />
                    ) : (
                      <div className="admin-model-card__placeholder">No preview</div>
                    )}
                  </div>
                  <div className="admin-model-mainframe__badges">
                    <span className="admin-badge">{activeModel.version}</span>
                    <span className="admin-badge admin-badge--muted">{activeModelDetails.updatedLabel}</span>
                    {activeModelDetails.fileSizeLabel ? (
                      <span className="admin-badge admin-badge--muted">{activeModelDetails.fileSizeLabel}</span>
                    ) : null}
                    <span className="admin-badge admin-badge--muted">
                      {activeModelDetails.versionCount} versions
                    </span>
                  </div>
                  {activeModel.tags.length > 0 ? (
                    <div className="admin-model-card__tags">
                      {activeModel.tags.map((tag) => (
                        <span key={tag.id} className="admin-badge">
                          {tag.label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {activeModel.description ? (
                    <p className="admin-model-card__description">{activeModel.description}</p>
                  ) : null}
                  {activeModel.trigger ? (
                    <p className="admin-model-card__trigger">
                      <strong>Trigger:</strong> {activeModel.trigger}
                    </p>
                  ) : null}
                  <ul className="admin-model-card__metadata">
                    {activeModelDetails.metadataEntries.map((entry) => (
                      <li key={entry.label}>
                        <span>{entry.label}</span>
                        {entry.href ? (
                          <strong>
                            <a href={entry.href} target="_blank" rel="noreferrer">
                              {entry.value}
                            </a>
                          </strong>
                        ) : (
                          <strong>{entry.value}</strong>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="admin-model-card__quick-actions">
                    {activeModelDetails.previewUrl ? (
                      <a
                        className="button button--subtle"
                        href={activeModelDetails.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Preview
                      </a>
                    ) : null}
                    <a
                      className="button button--subtle"
                      href={activeModelDetails.downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download latest
                    </a>
                  </div>
                </div>
                <form
                  className="admin-model-card__form admin__form admin-model-mainframe__form"
                  onSubmit={(event) => handleUpdateModel(event, activeModel)}
                  aria-label={`Settings for ${activeModel.title}`}
                >
                  <div className="admin-model-card__form-fields">
                    <label className="admin-model-card__form-item admin-model-card__form-item--full">
                      <span>Title</span>
                      <input name="title" defaultValue={activeModel.title} disabled={isBusy} />
                    </label>
                    <label className="admin-model-card__form-item">
                      <span>Owner</span>
                      <select name="ownerId" defaultValue={activeModel.owner.id} disabled={isBusy}>
                        {userOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="admin-model-card__form-item">
                      <span>Primary version</span>
                      <input name="version" defaultValue={activeModel.version} disabled={isBusy} />
                    </label>
                    <label className="admin-model-card__form-item">
                      <span>Trigger / Activator</span>
                      <input
                        name="trigger"
                        defaultValue={activeModel.trigger ?? ''}
                        placeholder="Primary activation phrase"
                        disabled={isBusy}
                        required
                      />
                    </label>
                    <label className="admin-model-card__form-item">
                      <span>Tags</span>
                      <input
                        name="tags"
                        defaultValue={activeModel.tags.map((tag) => tag.label).join(', ')}
                        placeholder="Comma separated"
                        disabled={isBusy}
                      />
                    </label>
                    <label className="admin-model-card__form-item admin-model-card__form-item--full">
                      <span>Description</span>
                      <textarea
                        name="description"
                        rows={3}
                        defaultValue={activeModel.description ?? ''}
                        disabled={isBusy}
                      />
                    </label>
                  </div>
                  <div className="admin-model-card__form-footer">
                    <button type="submit" className="button button--primary" disabled={isBusy}>
                      Save changes
                    </button>
                  </div>
                </form>
              </div>
              <div className="admin-model-mainframe__versions">
                <div className="admin-model-card__versions">
                  <div className="admin-model-card__versions-header">
                    <h5>Version history</h5>
                    <span className="admin-badge admin-badge--muted">Belongs to {activeModel.title}</span>
                  </div>
                  <ul className="admin-model-card__version-list">
                    {activeModel.versions.map((version) => {
                      const versionDownloadUrl =
                        resolveStorageUrl(
                          version.storagePath,
                          version.storageBucket,
                          version.storageObject,
                        ) ?? version.storagePath;
                      const versionPreviewUrl =
                        resolveStorageUrl(
                          version.previewImage,
                          version.previewImageBucket,
                          version.previewImageObject,
                        ) ?? version.previewImage ?? null;
                      const versionUpdatedLabel = new Date(version.updatedAt).toLocaleDateString('en-US');
                      const versionFileSizeLabel = formatFileSize(version.fileSize);

                      return (
                        <li key={version.id} className="admin-model-card__version">
                          <div className="admin-model-card__version-main">
                            <strong>{version.version}</strong>
                            <div className="admin-model-card__version-badges">
                              {version.id === activeModel.primaryVersionId ? (
                                <span className="admin-badge">Primary</span>
                              ) : null}
                              {version.id === activeModel.latestVersionId ? (
                                <span className="admin-badge admin-badge--muted">Latest</span>
                              ) : null}
                            </div>
                          </div>
                          <div className="admin-model-card__version-meta">
                            <span>{versionUpdatedLabel}</span>
                            {versionFileSizeLabel ? <span>{versionFileSizeLabel}</span> : null}
                          </div>
                          <div className="admin-model-card__version-actions">
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
                            {version.id !== activeModel.primaryVersionId ? (
                              <>
                                <button
                                  type="button"
                                  className="button button--subtle"
                                  onClick={() => handlePromoteModelVersion(activeModel, version)}
                                  disabled={isBusy}
                                >
                                  Make primary
                                </button>
                                <button
                                  type="button"
                                  className="button button--subtle"
                                  onClick={() => handleRenameModelVersion(activeModel, version)}
                                  disabled={isBusy}
                                >
                                  Rename
                                </button>
                                <button
                                  type="button"
                                  className="button button--danger"
                                  onClick={() => handleDeleteModelVersion(activeModel, version)}
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
            </section>
          ) : null}
        </div>
      ) : null}

      {activeTab === 'images' ? (
        <div className="admin__panel">
          <section className="admin__section">
            <div className="admin__section-header">
              <h3>Manage images</h3>
              <div className="admin__filters">
                <label>
                  <span>Search</span>
                  <input
                    type="search"
                    value={imageFilter.query}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setImageFilter((previous) => ({ ...previous, query: value }));
                    }}
                    placeholder="Title, prompt, or tags"
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
              </div>
            </div>

            {renderSelectionToolbar(
              filteredImages.length,
              selectedImages.size,
              (checked) => toggleSelectAll(setSelectedImages, filteredImages.map((image) => image.id), checked),
              () => setSelectedImages(new Set()),
              handleBulkDeleteImages,
            )}

            {filteredImages.length === 0 ? (
              <p className="admin__empty">No images available.</p>
            ) : (
              <div className="admin-image-grid" role="list">
                {filteredImages.map((image) => {
                  const previewUrl =
                    resolveStorageUrl(image.storagePath, image.storageBucket, image.storageObject) ?? image.storagePath;
                  const metadataEntries = [
                    image.metadata?.seed ? { label: 'Seed', value: image.metadata.seed } : null,
                    image.metadata?.model ? { label: 'Model', value: image.metadata.model } : null,
                    image.metadata?.sampler ? { label: 'Sampler', value: image.metadata.sampler } : null,
                    image.metadata?.cfgScale !== undefined && image.metadata?.cfgScale !== null
                      ? { label: 'CFG', value: image.metadata.cfgScale.toString() }
                      : null,
                    image.metadata?.steps !== undefined && image.metadata?.steps !== null
                      ? { label: 'Steps', value: image.metadata.steps.toString() }
                      : null,
                  ].filter((entry): entry is { label: string; value: string } => {
                    if (!entry) {
                      return false;
                    }
                    return entry.value.trim().length > 0;
                  });
                  const visibleTags = image.tags.slice(0, 5);
                  const remainingTagCount = image.tags.length - visibleTags.length;
                  const isExpanded = expandedImageId === image.id;
                  const dimensionsLabel = image.dimensions
                    ? `${image.dimensions.width}×${image.dimensions.height}`
                    : null;
                  const fileSizeLabel = formatFileSize(image.fileSize);
                  const updatedLabel = new Date(image.updatedAt).toLocaleDateString('en-US');

                  return (
                    <form
                      key={image.id}
                      className={`admin-image-card${isExpanded ? ' admin-image-card--expanded' : ''}`}
                      onSubmit={(event) => handleUpdateImage(event, image)}
                      aria-label={`Settings for ${image.title}`}
                      role="listitem"
                    >
                      <div className="admin-image-card__body">
                        <div className="admin-image-card__media">
                          {previewUrl ? (
                            <img src={previewUrl} alt={image.title} loading="lazy" />
                          ) : (
                            <div className="admin-image-card__placeholder">No preview</div>
                          )}
                        </div>
                        <div className="admin-image-card__summary">
                          <div className="admin-image-card__summary-header">
                            <label className="admin-image-card__checkbox">
                              <input
                                type="checkbox"
                                checked={selectedImages.has(image.id)}
                                onChange={(event) =>
                                  toggleSelection(setSelectedImages, image.id, event.currentTarget.checked)
                                }
                                disabled={isBusy}
                                aria-label={`Select ${image.title}`}
                              />
                            </label>
                            <div className="admin-image-card__titles">
                              <h4>{image.title}</h4>
                              <span className="admin-image-card__subtitle">
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
                            <div className="admin-image-card__meta">
                              <span className="admin-badge admin-badge--muted">{updatedLabel}</span>
                              {dimensionsLabel ? (
                                <span className="admin-badge admin-badge--muted">{dimensionsLabel}</span>
                              ) : null}
                              {fileSizeLabel ? (
                                <span className="admin-badge admin-badge--muted">{fileSizeLabel}</span>
                              ) : null}
                            </div>
                          </div>
                          <div className="admin-image-card__tags">
                            {visibleTags.map((tag) => (
                              <span key={tag.id} className="admin-badge">
                                {tag.label}
                              </span>
                            ))}
                            {remainingTagCount > 0 ? (
                              <span className="admin-badge admin-badge--muted">+{remainingTagCount} more</span>
                            ) : null}
                          </div>
                          {metadataEntries.length > 0 ? (
                            <ul className="admin-image-card__metadata">
                              {metadataEntries.map((entry) => (
                                <li key={entry.label}>
                                  <span>{entry.label}</span>
                                  <strong>{entry.value}</strong>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          <div className="admin-image-card__prompts">
                            {image.prompt ? (
                              <p>
                                <strong>Prompt:</strong> {truncateText(image.prompt)}
                              </p>
                            ) : null}
                            {image.negativePrompt ? (
                              <p>
                                <strong>Negative:</strong> {truncateText(image.negativePrompt)}
                              </p>
                            ) : null}
                          </div>
                          <div className="admin-image-card__quick-actions">
                            {previewUrl ? (
                              <a className="button button--subtle" href={previewUrl} target="_blank" rel="noreferrer">
                                Open
                              </a>
                            ) : null}
                            <button
                              type="button"
                              className="button button--subtle"
                              onClick={() =>
                                setExpandedImageId((previous) => (previous === image.id ? null : image.id))
                              }
                            >
                              {isExpanded ? 'Collapse' : 'Edit'}
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
                      </div>
                      {isExpanded ? (
                        <div className="admin-image-card__form admin__form">
                          <div className="admin-image-card__form-fields">
                            <label className="admin-image-card__form-item admin-image-card__form-item--full">
                              <span>Title</span>
                              <input name="title" defaultValue={image.title} disabled={isBusy} />
                            </label>
                            <label className="admin-image-card__form-item">
                              <span>Owner</span>
                              <select name="ownerId" defaultValue={image.owner.id} disabled={isBusy}>
                                {userOptions.map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="admin-image-card__form-item">
                              <span>Tags</span>
                              <input
                                name="tags"
                                defaultValue={image.tags.map((tag) => tag.label).join(', ')}
                                placeholder="Comma separated"
                                disabled={isBusy}
                              />
                            </label>
                            <label className="admin-image-card__form-item admin-image-card__form-item--full">
                              <span>Description</span>
                              <textarea name="description" rows={3} defaultValue={image.description ?? ''} disabled={isBusy} />
                            </label>
                            <label className="admin-image-card__form-item admin-image-card__form-item--full">
                              <span>Prompt</span>
                              <textarea name="prompt" rows={3} defaultValue={image.prompt ?? ''} disabled={isBusy} />
                            </label>
                            <label className="admin-image-card__form-item admin-image-card__form-item--full">
                              <span>Negative prompt</span>
                              <textarea
                                name="negativePrompt"
                                rows={3}
                                defaultValue={image.negativePrompt ?? ''}
                                disabled={isBusy}
                              />
                            </label>
                          </div>
                          <div className="admin__form-grid admin-image-card__form-grid">
                            <label>
                              <span>Seed</span>
                              <input name="seed" defaultValue={image.metadata?.seed ?? ''} disabled={isBusy} />
                            </label>
                            <label>
                              <span>Model</span>
                              <input name="model" defaultValue={image.metadata?.model ?? ''} disabled={isBusy} />
                            </label>
                            <label>
                              <span>Sampler</span>
                              <input name="sampler" defaultValue={image.metadata?.sampler ?? ''} disabled={isBusy} />
                            </label>
                            <label>
                              <span>CFG</span>
                              <input
                                name="cfgScale"
                                defaultValue={image.metadata?.cfgScale?.toString() ?? ''}
                                disabled={isBusy}
                              />
                            </label>
                            <label>
                              <span>Steps</span>
                              <input
                                name="steps"
                                defaultValue={image.metadata?.steps?.toString() ?? ''}
                                disabled={isBusy}
                              />
                            </label>
                          </div>
                          <div className="admin-image-card__form-footer">
                            <button type="submit" className="button button--primary" disabled={isBusy}>
                              Save changes
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </form>
                  );
                })}
              </div>
            )}
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
    </section>
  );
};
