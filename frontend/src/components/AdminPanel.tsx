import type { Dispatch, SetStateAction } from 'react';
import { FormEvent, useMemo, useState } from 'react';

import { api } from '../lib/api';
import { resolveStorageUrl } from '../lib/storage';
import type { Gallery, ImageAsset, ModelAsset, User } from '../types/api';
import { UserCreationDialog, type AsyncActionResult } from './UserCreationDialog';

const roleSummaries: Record<
  User['role'],
  { title: string; headline: string; bullets: string[] }
> = {
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

  const summary = roleSummaries[role];

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
}

type AdminTab = 'users' | 'models' | 'images' | 'galleries';

type FilterValue<T extends string> = T | 'all';

type UserStatusFilter = 'active' | 'inactive';

type VisibilityFilter = 'public' | 'private';

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

export const AdminPanel = ({ users, models, images, galleries, token, onRefresh }: AdminPanelProps) => {
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
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);

  const userOptions = useMemo(() => users.map((user) => ({ id: user.id, label: user.displayName })), [users]);

  const resetStatus = () => setStatus(null);

  const withStatus = async (
    action: () => Promise<void>,
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
      const message = error instanceof Error ? error.message : 'Action failed.';
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
    setExpandedModelId(null);
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

  return (
    <section className="admin">
      <header className="admin__header">
        <nav className="admin__tabs" aria-label="Administration Tabs">
          {(
            [
              { id: 'users', label: 'User' },
              { id: 'models', label: 'Models' },
              { id: 'images', label: 'Images' },
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
                  const downloadUrl =
                    resolveStorageUrl(model.storagePath, model.storageBucket, model.storageObject) ?? model.storagePath;
                  const updatedLabel = new Date(model.updatedAt).toLocaleDateString('en-US');
                  const fileSizeLabel = formatFileSize(model.fileSize);
                  const versionCount = model.versions.length;
                  const visibleTags = model.tags.slice(0, 5);
                  const remainingTagCount = model.tags.length - visibleTags.length;
                  const isExpanded = expandedModelId === model.id;
                  const metadataEntries = [
                    { label: 'Slug', value: model.slug },
                    model.storageBucket
                      ? { label: 'Bucket', value: model.storageBucket }
                      : null,
                    {
                      label: 'Storage object',
                      value: model.storageObject ?? model.storagePath,
                      href: downloadUrl,
                    },
                    {
                      label: 'Checksum',
                      value: model.checksum ?? '—',
                    },
                  ].filter((entry): entry is { label: string; value: string; href?: string } => Boolean(entry));
                  const formId = `model-form-${model.id}`;

                  return (
                    <form
                      key={model.id}
                      id={formId}
                      className={`admin-model-card${isExpanded ? ' admin-model-card--expanded' : ''}`}
                      onSubmit={(event) => handleUpdateModel(event, model)}
                      aria-label={`Settings for ${model.title}`}
                      role="listitem"
                    >
                      <div className="admin-model-card__body">
                        <div className="admin-model-card__media">
                          {previewUrl ? (
                            <img src={previewUrl} alt={model.title} loading="lazy" />
                          ) : (
                            <div className="admin-model-card__placeholder">No preview</div>
                          )}
                        </div>
                        <div className="admin-model-card__summary">
                          <div className="admin-model-card__summary-header">
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
                            </label>
                            <div className="admin-model-card__titles">
                              <h4>{model.title}</h4>
                              <span className="admin-model-card__subtitle">by {model.owner.displayName}</span>
                            </div>
                            <div className="admin-model-card__meta">
                              <span className="admin-badge">{model.version}</span>
                              <span className="admin-badge admin-badge--muted">{updatedLabel}</span>
                              {fileSizeLabel ? (
                                <span className="admin-badge admin-badge--muted">{fileSizeLabel}</span>
                              ) : null}
                              <span className="admin-badge admin-badge--muted">{versionCount} versions</span>
                            </div>
                          </div>
                          <div className="admin-model-card__tags">
                            {visibleTags.map((tag) => (
                              <span key={tag.id} className="admin-badge">
                                {tag.label}
                              </span>
                            ))}
                            {remainingTagCount > 0 ? (
                              <span className="admin-badge admin-badge--muted">+{remainingTagCount} more</span>
                            ) : null}
                          </div>
                          {model.description ? (
                            <p className="admin-model-card__description">{truncateText(model.description)}</p>
                          ) : null}
                          {model.trigger ? (
                            <p className="admin-model-card__trigger">
                              <strong>Trigger:</strong> {model.trigger}
                            </p>
                          ) : null}
                          <ul className="admin-model-card__metadata">
                            {metadataEntries.map((entry) => (
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
                            {previewUrl ? (
                              <a className="button button--subtle" href={previewUrl} target="_blank" rel="noreferrer">
                                Preview
                              </a>
                            ) : null}
                            <a className="button button--subtle" href={downloadUrl} target="_blank" rel="noreferrer">
                              Download latest
                            </a>
                            <button
                              type="button"
                              className="button button--subtle"
                              onClick={() =>
                                setExpandedModelId((previous) => (previous === model.id ? null : model.id))
                              }
                              aria-expanded={isExpanded}
                              aria-controls={`${formId}-details`}
                            >
                              {isExpanded ? 'Collapse' : 'Manage'}
                            </button>
                          </div>
                          <div className="admin-model-card__versions">
                            <div className="admin-model-card__versions-header">
                              <h5>Version history</h5>
                              <span className="admin-badge admin-badge--muted">Belongs to {model.title}</span>
                            </div>
                            <ul className="admin-model-card__version-list">
                              {model.versions.map((version) => {
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
                                        {version.id === model.primaryVersionId ? (
                                          <span className="admin-badge">Primary</span>
                                        ) : null}
                                        {version.id === model.latestVersionId ? (
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
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        </div>
                      </div>
                      {isExpanded ? (
                        <div id={`${formId}-details`} className="admin-model-card__form admin__form">
                          <div className="admin-model-card__form-fields">
                            <label className="admin-model-card__form-item admin-model-card__form-item--full">
                              <span>Title</span>
                              <input name="title" defaultValue={model.title} disabled={isBusy} />
                            </label>
                            <label className="admin-model-card__form-item">
                              <span>Owner</span>
                              <select name="ownerId" defaultValue={model.owner.id} disabled={isBusy}>
                                {userOptions.map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="admin-model-card__form-item">
                              <span>Primary version</span>
                              <input name="version" defaultValue={model.version} disabled={isBusy} />
                            </label>
                            <label className="admin-model-card__form-item">
                              <span>Trigger / Activator</span>
                              <input
                                name="trigger"
                                defaultValue={model.trigger ?? ''}
                                placeholder="Primary activation phrase"
                                disabled={isBusy}
                                required
                              />
                            </label>
                            <label className="admin-model-card__form-item">
                              <span>Tags</span>
                              <input
                                name="tags"
                                defaultValue={model.tags.map((tag) => tag.label).join(', ')}
                                placeholder="Comma separated"
                                disabled={isBusy}
                              />
                            </label>
                            <label className="admin-model-card__form-item admin-model-card__form-item--full">
                              <span>Description</span>
                              <textarea name="description" rows={3} defaultValue={model.description ?? ''} disabled={isBusy} />
                            </label>
                          </div>
                          <div className="admin-model-card__form-footer">
                            <button type="submit" className="button button--primary" disabled={isBusy}>
                              Save changes
                            </button>
                            <button
                              type="button"
                              className="button button--danger"
                              onClick={() => handleDeleteModel(model)}
                              disabled={isBusy}
                            >
                              Delete model
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
                              <span className="admin-image-card__subtitle">by {image.owner.displayName}</span>
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
