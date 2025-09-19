import type { Dispatch, SetStateAction } from 'react';
import { FormEvent, useMemo, useState } from 'react';

import { api } from '../lib/api';
import type { Gallery, ImageAsset, ModelAsset, User } from '../types/api';

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

export const AdminPanel = ({ users, models, images, galleries, token, onRefresh }: AdminPanelProps) => {
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isBusy, setIsBusy] = useState(false);

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
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());

  const userOptions = useMemo(() => users.map((user) => ({ id: user.id, label: user.displayName })), [users]);

  const resetStatus = () => setStatus(null);

  const withStatus = async (action: () => Promise<void>, successMessage: string) => {
    resetStatus();
    setIsBusy(true);
    try {
      await action();
      setStatus({ type: 'success', message: successMessage });
      await onRefresh();
    } catch (error) {
      setStatus({ type: 'error', message: error instanceof Error ? error.message : 'Aktion fehlgeschlagen.' });
    } finally {
      setIsBusy(false);
    }
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

  const handleCreateUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = (formData.get('email') as string | null)?.trim();
    const displayName = (formData.get('displayName') as string | null)?.trim();
    const password = formData.get('password') as string | null;
    const role = (formData.get('role') as string | null) ?? 'CURATOR';
    const bio = (formData.get('bio') as string | null)?.trim();

    if (!email || !displayName || !password) {
      setStatus({ type: 'error', message: 'Alle Pflichtfelder müssen ausgefüllt sein.' });
      return;
    }

    await withStatus(
      () =>
        api
          .createUser(token, {
            email,
            displayName,
            password,
            role,
            bio: bio && bio.length > 0 ? bio : undefined,
          })
          .then(() => {
            event.currentTarget.reset();
          }),
      'Benutzer:in wurde angelegt.',
    );
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
      'Benutzerdaten wurden aktualisiert.',
    );
  };

  const handleDeleteUser = async (userId: string) => {
    if (!window.confirm('Soll dieser Account wirklich gelöscht werden?')) {
      return;
    }

    await withStatus(() => api.deleteUser(token, userId), 'Benutzer:in wurde gelöscht.');
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
    if (!window.confirm(`${ids.length} Accounts wirklich löschen?`)) {
      return;
    }

    await withStatus(
      () =>
        api.bulkDeleteUsers(token, ids).then(() => {
          setSelectedUsers(new Set());
        }),
      `${ids.length} Accounts entfernt.`,
    );
  };

  const handleUpdateModel = async (event: FormEvent<HTMLFormElement>, model: ModelAsset) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const title = (formData.get('title') as string | null)?.trim();
    const version = (formData.get('version') as string | null)?.trim();
    const description = (formData.get('description') as string | null)?.trim();
    const tagsValue = (formData.get('tags') as string | null) ?? '';
    const ownerId = (formData.get('ownerId') as string | null) ?? model.owner.id;

    const payload = {
      title: title ?? undefined,
      version: version ?? undefined,
      description: description && description.length > 0 ? description : null,
      tags: parseCommaList(tagsValue),
      ownerId,
    };

    await withStatus(() => api.updateModelAsset(token, model.id, payload), 'Modell wurde aktualisiert.');
  };

  const handleDeleteModel = async (model: ModelAsset) => {
    if (!window.confirm(`Modell "${model.title}" wirklich löschen?`)) {
      return;
    }

    await withStatus(() => api.deleteModelAsset(token, model.id), 'Modell wurde gelöscht.');
    setSelectedModels((previous) => {
      const next = new Set(previous);
      next.delete(model.id);
      return next;
    });
  };

  const handleBulkDeleteModels = async () => {
    const ids = Array.from(selectedModels);
    if (ids.length === 0) {
      return;
    }

    if (!window.confirm(`${ids.length} Modelle wirklich löschen?`)) {
      return;
    }

    await withStatus(
      () =>
        api.bulkDeleteModelAssets(token, ids).then(() => {
          setSelectedModels(new Set());
        }),
      `${ids.length} Modelle entfernt.`,
    );
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

    await withStatus(() => api.updateImageAsset(token, image.id, payload), 'Bild wurde aktualisiert.');
  };

  const handleDeleteImage = async (image: ImageAsset) => {
    if (!window.confirm(`Bild "${image.title}" wirklich löschen?`)) {
      return;
    }

    await withStatus(() => api.deleteImageAsset(token, image.id), 'Bild wurde gelöscht.');
    setSelectedImages((previous) => {
      const next = new Set(previous);
      next.delete(image.id);
      return next;
    });
  };

  const handleBulkDeleteImages = async () => {
    const ids = Array.from(selectedImages);
    if (ids.length === 0) {
      return;
    }

    if (!window.confirm(`${ids.length} Bilder wirklich löschen?`)) {
      return;
    }

    await withStatus(
      () =>
        api.bulkDeleteImageAssets(token, ids).then(() => {
          setSelectedImages(new Set());
        }),
      `${ids.length} Bilder entfernt.`,
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

    await withStatus(() => api.updateGallery(token, gallery.id, payload), 'Galerie wurde aktualisiert.');
  };

  const handleDeleteGallery = async (gallery: Gallery) => {
    if (!window.confirm(`Galerie "${gallery.title}" wirklich löschen?`)) {
      return;
    }

    await withStatus(() => api.deleteGallery(token, gallery.id), 'Galerie wurde gelöscht.');
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
        <label className="admin__checkbox" aria-label="Alles auswählen">
          <input
            type="checkbox"
            checked={selected > 0 && selected === total && total > 0}
            onChange={(event) => onSelectAll(event.currentTarget.checked)}
            disabled={total === 0 || isBusy}
          />
          <span>Alles</span>
        </label>
        <span className="admin__selection-count">{selected} ausgewählt</span>
        <button type="button" className="button" onClick={onClear} disabled={selected === 0 || isBusy}>
          Auswahl leeren
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={onBulkDelete}
          disabled={selected === 0 || isBusy}
        >
          Ausgewählte löschen
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
              { id: 'models', label: 'Modelle' },
              { id: 'images', label: 'Bilder' },
              { id: 'galleries', label: 'Galerien' },
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
          <section className="admin__section">
            <h3>Neuen Account anlegen</h3>
            <form className="admin__form" onSubmit={handleCreateUser}>
              <div className="admin__form-grid">
                <label>
                  <span>E-Mail</span>
                  <input name="email" type="email" required disabled={isBusy} />
                </label>
                <label>
                  <span>Anzeigename</span>
                  <input name="displayName" required disabled={isBusy} />
                </label>
                <label>
                  <span>Passwort</span>
                  <input name="password" type="password" required disabled={isBusy} />
                </label>
                <label>
                  <span>Rolle</span>
                  <select name="role" defaultValue="CURATOR" disabled={isBusy}>
                    <option value="CURATOR">Kurator:in</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                </label>
              </div>
              <label>
                <span>Bio</span>
                <textarea name="bio" rows={2} disabled={isBusy} />
              </label>
              <button type="submit" className="button button--primary" disabled={isBusy}>
                Account erstellen
              </button>
            </form>
          </section>

          <section className="admin__section">
            <div className="admin__section-header">
              <h3>Benutzer:innen verwalten</h3>
              <div className="admin__filters">
                <label>
                  <span>Suche</span>
                  <input
                    type="search"
                    value={userFilter.query}
                    onChange={(event) => setUserFilter((previous) => ({ ...previous, query: event.currentTarget.value }))}
                    placeholder="Name, Mail oder Bio"
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Rolle</span>
                  <select
                    value={userFilter.role}
                    onChange={(event) =>
                      setUserFilter((previous) => ({ ...previous, role: event.currentTarget.value as FilterValue<User['role']> }))
                    }
                    disabled={isBusy}
                  >
                    <option value="all">Alle</option>
                    <option value="CURATOR">Kurator:innen</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                </label>
                <label>
                  <span>Status</span>
                  <select
                    value={userFilter.status}
                    onChange={(event) =>
                      setUserFilter((previous) => ({
                        ...previous,
                        status: event.currentTarget.value as FilterValue<UserStatusFilter>,
                      }))
                    }
                    disabled={isBusy}
                  >
                    <option value="all">Alle</option>
                    <option value="active">Aktive</option>
                    <option value="inactive">Inaktive</option>
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
                <span className="admin__table-cell admin__table-cell--checkbox" role="columnheader" aria-label="Auswahl" />
                <span className="admin__table-cell" role="columnheader">
                  Account
                </span>
                <span className="admin__table-cell" role="columnheader">
                  Profil &amp; Berechtigungen
                </span>
                <span className="admin__table-cell admin__table-cell--actions" role="columnheader">
                  Aktionen
                </span>
              </div>
              <div className="admin__table-body">
                {filteredUsers.length === 0 ? (
                  <p className="admin__empty">Keine Benutzer:innen vorhanden.</p>
                ) : (
                  filteredUsers.map((user) => (
                    <form
                      key={user.id}
                      className="admin-row"
                      onSubmit={(event) => handleUpdateUser(event, user.id)}
                      aria-label={`Einstellungen für ${user.displayName}`}
                    >
                      <div className="admin-row__cell admin-row__cell--checkbox">
                        <input
                          type="checkbox"
                          checked={selectedUsers.has(user.id)}
                          onChange={(event) => toggleSelection(setSelectedUsers, user.id, event.currentTarget.checked)}
                          disabled={isBusy}
                          aria-label={`${user.displayName} auswählen`}
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
                            {user.isActive === false ? 'inaktiv' : 'aktiv'}
                          </span>
                        </div>
                      </div>
                      <div className="admin-row__cell admin-row__cell--form">
                        <label>
                          <span>Anzeigename</span>
                          <input name="displayName" defaultValue={user.displayName} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Rolle</span>
                          <select name="role" defaultValue={user.role} disabled={isBusy}>
                            <option value="CURATOR">Kurator:in</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                        </label>
                        <label>
                          <span>Bio</span>
                          <textarea name="bio" rows={2} defaultValue={user.bio ?? ''} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Neues Passwort</span>
                          <input name="password" type="password" placeholder="Optional" disabled={isBusy} />
                        </label>
                        <label className="admin__checkbox">
                          <input type="checkbox" name="isActive" defaultChecked={user.isActive !== false} disabled={isBusy} />
                          <span>Konto aktiv</span>
                        </label>
                      </div>
                      <div className="admin-row__cell admin-row__cell--actions">
                        <button type="submit" className="button" disabled={isBusy}>
                          Speichern
                        </button>
                        <button
                          type="button"
                          className="button button--danger"
                          onClick={() => handleDeleteUser(user.id)}
                          disabled={isBusy}
                        >
                          Löschen
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
              <h3>Modelle verwalten</h3>
              <div className="admin__filters">
                <label>
                  <span>Suche</span>
                  <input
                    type="search"
                    value={modelFilter.query}
                    onChange={(event) => setModelFilter((previous) => ({ ...previous, query: event.currentTarget.value }))}
                    placeholder="Titel, Beschreibung oder Besitzer"
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Besitzer:in</span>
                  <select
                    value={modelFilter.owner}
                    onChange={(event) =>
                      setModelFilter((previous) => ({ ...previous, owner: event.currentTarget.value as FilterValue<string> }))
                    }
                    disabled={isBusy}
                  >
                    <option value="all">Alle</option>
                    {userOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Tag-Suche</span>
                  <input
                    type="search"
                    value={modelFilter.tag}
                    onChange={(event) => setModelFilter((previous) => ({ ...previous, tag: event.currentTarget.value }))}
                    placeholder="Tag-Filter"
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

            <div className="admin__table" role="grid">
              <div className="admin__table-header" role="row">
                <span className="admin__table-cell admin__table-cell--checkbox" role="columnheader" aria-label="Auswahl" />
                <span className="admin__table-cell" role="columnheader">
                  Modell
                </span>
                <span className="admin__table-cell" role="columnheader">
                  Details
                </span>
                <span className="admin__table-cell admin__table-cell--actions" role="columnheader">
                  Aktionen
                </span>
              </div>
              <div className="admin__table-body">
                {filteredModels.length === 0 ? (
                  <p className="admin__empty">Keine Modelle vorhanden.</p>
                ) : (
                  filteredModels.map((model) => (
                    <form
                      key={model.id}
                      className="admin-row"
                      onSubmit={(event) => handleUpdateModel(event, model)}
                      aria-label={`Einstellungen für ${model.title}`}
                    >
                      <div className="admin-row__cell admin-row__cell--checkbox">
                        <input
                          type="checkbox"
                          checked={selectedModels.has(model.id)}
                          onChange={(event) => toggleSelection(setSelectedModels, model.id, event.currentTarget.checked)}
                          disabled={isBusy}
                          aria-label={`${model.title} auswählen`}
                        />
                      </div>
                      <div className="admin-row__cell admin-row__cell--meta">
                        <h4>{model.title}</h4>
                        <span className="admin-row__subtitle">von {model.owner.displayName}</span>
                        <div className="admin-row__badges">
                          <span className="admin-badge">{model.version}</span>
                          <span className="admin-badge admin-badge--muted">
                            {new Date(model.updatedAt).toLocaleDateString('de-DE')}
                          </span>
                        </div>
                      </div>
                      <div className="admin-row__cell admin-row__cell--form">
                        <label>
                          <span>Titel</span>
                          <input name="title" defaultValue={model.title} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Version</span>
                          <input name="version" defaultValue={model.version} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Beschreibung</span>
                          <textarea name="description" rows={3} defaultValue={model.description ?? ''} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Tags</span>
                          <input
                            name="tags"
                            defaultValue={model.tags.map((tag) => tag.label).join(', ')}
                            placeholder="Kommagetrennt"
                            disabled={isBusy}
                          />
                        </label>
                        <label>
                          <span>Besitzer:in</span>
                          <select name="ownerId" defaultValue={model.owner.id} disabled={isBusy}>
                            {userOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="admin-row__cell admin-row__cell--actions">
                        <button type="submit" className="button" disabled={isBusy}>
                          Speichern
                        </button>
                        <button
                          type="button"
                          className="button button--danger"
                          onClick={() => handleDeleteModel(model)}
                          disabled={isBusy}
                        >
                          Löschen
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

      {activeTab === 'images' ? (
        <div className="admin__panel">
          <section className="admin__section">
            <div className="admin__section-header">
              <h3>Bilder verwalten</h3>
              <div className="admin__filters">
                <label>
                  <span>Suche</span>
                  <input
                    type="search"
                    value={imageFilter.query}
                    onChange={(event) => setImageFilter((previous) => ({ ...previous, query: event.currentTarget.value }))}
                    placeholder="Titel, Prompt oder Tags"
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Besitzer:in</span>
                  <select
                    value={imageFilter.owner}
                    onChange={(event) =>
                      setImageFilter((previous) => ({ ...previous, owner: event.currentTarget.value as FilterValue<string> }))
                    }
                    disabled={isBusy}
                  >
                    <option value="all">Alle</option>
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

            <div className="admin__table" role="grid">
              <div className="admin__table-header" role="row">
                <span className="admin__table-cell admin__table-cell--checkbox" role="columnheader" aria-label="Auswahl" />
                <span className="admin__table-cell" role="columnheader">
                  Bild
                </span>
                <span className="admin__table-cell" role="columnheader">
                  Metadaten
                </span>
                <span className="admin__table-cell admin__table-cell--actions" role="columnheader">
                  Aktionen
                </span>
              </div>
              <div className="admin__table-body">
                {filteredImages.length === 0 ? (
                  <p className="admin__empty">Keine Bilder vorhanden.</p>
                ) : (
                  filteredImages.map((image) => (
                    <form
                      key={image.id}
                      className="admin-row"
                      onSubmit={(event) => handleUpdateImage(event, image)}
                      aria-label={`Einstellungen für ${image.title}`}
                    >
                      <div className="admin-row__cell admin-row__cell--checkbox">
                        <input
                          type="checkbox"
                          checked={selectedImages.has(image.id)}
                          onChange={(event) => toggleSelection(setSelectedImages, image.id, event.currentTarget.checked)}
                          disabled={isBusy}
                          aria-label={`${image.title} auswählen`}
                        />
                      </div>
                      <div className="admin-row__cell admin-row__cell--meta">
                        <h4>{image.title}</h4>
                        <span className="admin-row__subtitle">von {image.owner.displayName}</span>
                        <div className="admin-row__badges">
                          <span className="admin-badge admin-badge--muted">
                            {new Date(image.updatedAt).toLocaleDateString('de-DE')}
                          </span>
                          <span className="admin-badge">{image.tags.map((tag) => tag.label).slice(0, 3).join(', ')}</span>
                        </div>
                      </div>
                      <div className="admin-row__cell admin-row__cell--form">
                        <label>
                          <span>Titel</span>
                          <input name="title" defaultValue={image.title} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Beschreibung</span>
                          <textarea name="description" rows={2} defaultValue={image.description ?? ''} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Prompt</span>
                          <textarea name="prompt" rows={2} defaultValue={image.prompt ?? ''} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Negativer Prompt</span>
                          <textarea name="negativePrompt" rows={2} defaultValue={image.negativePrompt ?? ''} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Tags</span>
                          <input
                            name="tags"
                            defaultValue={image.tags.map((tag) => tag.label).join(', ')}
                            placeholder="Kommagetrennt"
                            disabled={isBusy}
                          />
                        </label>
                        <label>
                          <span>Besitzer:in</span>
                          <select name="ownerId" defaultValue={image.owner.id} disabled={isBusy}>
                            {userOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="admin__form-grid">
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
                            <input name="cfgScale" defaultValue={image.metadata?.cfgScale?.toString() ?? ''} disabled={isBusy} />
                          </label>
                          <label>
                            <span>Steps</span>
                            <input name="steps" defaultValue={image.metadata?.steps?.toString() ?? ''} disabled={isBusy} />
                          </label>
                        </div>
                      </div>
                      <div className="admin-row__cell admin-row__cell--actions">
                        <button type="submit" className="button" disabled={isBusy}>
                          Speichern
                        </button>
                        <button
                          type="button"
                          className="button button--danger"
                          onClick={() => handleDeleteImage(image)}
                          disabled={isBusy}
                        >
                          Löschen
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

      {activeTab === 'galleries' ? (
        <div className="admin__panel">
          <section className="admin__section">
            <div className="admin__section-header">
              <h3>Galerien &amp; Alben</h3>
              <div className="admin__filters">
                <label>
                  <span>Suche</span>
                  <input
                    type="search"
                    value={galleryFilter.query}
                    onChange={(event) => setGalleryFilter((previous) => ({ ...previous, query: event.currentTarget.value }))}
                    placeholder="Titel oder Slug"
                    disabled={isBusy}
                  />
                </label>
                <label>
                  <span>Besitzer:in</span>
                  <select
                    value={galleryFilter.owner}
                    onChange={(event) =>
                      setGalleryFilter((previous) => ({ ...previous, owner: event.currentTarget.value as FilterValue<string> }))
                    }
                    disabled={isBusy}
                  >
                    <option value="all">Alle</option>
                    {userOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Sichtbarkeit</span>
                  <select
                    value={galleryFilter.visibility}
                    onChange={(event) =>
                      setGalleryFilter((previous) => ({
                        ...previous,
                        visibility: event.currentTarget.value as FilterValue<VisibilityFilter>,
                      }))
                    }
                    disabled={isBusy}
                  >
                    <option value="all">Alle</option>
                    <option value="public">Öffentlich</option>
                    <option value="private">Privat</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="admin__table" role="grid">
              <div className="admin__table-header" role="row">
                <span className="admin__table-cell" role="columnheader">
                  Galerie
                </span>
                <span className="admin__table-cell" role="columnheader">
                  Metadaten &amp; Einträge
                </span>
                <span className="admin__table-cell admin__table-cell--actions" role="columnheader">
                  Aktionen
                </span>
              </div>
              <div className="admin__table-body">
                {filteredGalleries.length === 0 ? (
                  <p className="admin__empty">Keine Galerien vorhanden.</p>
                ) : (
                  filteredGalleries.map((gallery) => (
                    <form
                      key={gallery.id}
                      className="admin-row admin-row--wide"
                      onSubmit={(event) => handleUpdateGallery(event, gallery)}
                      aria-label={`Einstellungen für ${gallery.title}`}
                    >
                      <div className="admin-row__cell admin-row__cell--meta">
                        <h4>{gallery.title}</h4>
                        <span className="admin-row__subtitle">Slug: {gallery.slug}</span>
                        <div className="admin-row__badges">
                          <span className="admin-badge">{gallery.isPublic ? 'öffentlich' : 'privat'}</span>
                          <span className="admin-badge admin-badge--muted">
                            {new Date(gallery.updatedAt).toLocaleDateString('de-DE')}
                          </span>
                          <span className="admin-badge">{gallery.entries.length} Einträge</span>
                        </div>
                      </div>
                      <div className="admin-row__cell admin-row__cell--form">
                        <label>
                          <span>Titel</span>
                          <input name="title" defaultValue={gallery.title} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Beschreibung</span>
                          <textarea name="description" rows={2} defaultValue={gallery.description ?? ''} disabled={isBusy} />
                        </label>
                        <label>
                          <span>Sichtbarkeit</span>
                          <select name="visibility" defaultValue={gallery.isPublic ? 'public' : 'private'} disabled={isBusy}>
                            <option value="public">Öffentlich</option>
                            <option value="private">Privat</option>
                          </select>
                        </label>
                        <label>
                          <span>Besitzer:in</span>
                          <select name="ownerId" defaultValue={gallery.owner.id} disabled={isBusy}>
                            {userOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Cover-Storage-Pfad</span>
                          <input
                            name="coverImage"
                            defaultValue={gallery.coverImage ?? ''}
                            placeholder="leer lassen, um zu entfernen"
                            disabled={isBusy}
                          />
                        </label>
                        <div className="admin-gallery-entries">
                          <h5>Einträge</h5>
                          {gallery.entries.length === 0 ? (
                            <p className="admin__empty admin__empty--sub">Noch keine Inhalte verknüpft.</p>
                          ) : (
                            gallery.entries.map((entry) => (
                              <fieldset key={entry.id} className="admin-gallery-entry">
                                <legend>
                                  {entry.position + 1}.{' '}
                                  {entry.modelAsset ? `Model: ${entry.modelAsset.title}` : entry.imageAsset ? `Bild: ${entry.imageAsset.title}` : 'Unverknüpft'}
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
                                    <span>Entfernen</span>
                                  </label>
                                </div>
                                <label>
                                  <span>Notiz</span>
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
                          Speichern
                        </button>
                        <button
                          type="button"
                          className="button button--danger"
                          onClick={() => handleDeleteGallery(gallery)}
                          disabled={isBusy}
                        >
                          Löschen
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
