import { FormEvent, useMemo, useState } from 'react';

import { api } from '../lib/api';
import type { ImageAsset, ModelAsset, User } from '../types/api';

interface AdminPanelProps {
  users: User[];
  models: ModelAsset[];
  images: ImageAsset[];
  token: string;
  onRefresh: () => Promise<void>;
}

type AdminTab = 'users' | 'models' | 'images';

const parseCommaList = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const AdminPanel = ({ users, models, images, token, onRefresh }: AdminPanelProps) => {
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isBusy, setIsBusy] = useState(false);

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
  };

  return (
    <section className="admin">
      <header className="admin__header">
        <nav className="admin__tabs" aria-label="Administration Tabs">
          {(
            [
              { id: 'users', label: 'User' },
              { id: 'models', label: 'Modelle' },
              { id: 'images', label: 'Bilder' },
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
            <h3>Bestehende Accounts</h3>
            <div className="admin__list">
              {users.length === 0 ? <p className="admin__empty">Keine Benutzer:innen vorhanden.</p> : null}
              {users.map((user) => (
                <form key={user.id} className="admin-card" onSubmit={(event) => handleUpdateUser(event, user.id)}>
                  <header className="admin-card__header">
                    <div>
                      <h4>{user.displayName}</h4>
                      <span className="admin-card__subtitle">{user.email}</span>
                    </div>
                    <span className={`admin-card__badge admin-card__badge--${user.role.toLowerCase()}`}>{user.role}</span>
                  </header>
                  <div className="admin-card__body">
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
                    <label className="admin-card__checkbox">
                      <input type="checkbox" name="isActive" defaultChecked={user.isActive !== false} disabled={isBusy} />
                      Konto aktiv
                    </label>
                  </div>
                  <footer className="admin-card__actions">
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
                  </footer>
                </form>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === 'models' ? (
        <div className="admin__panel">
          <h3>Modelle verwalten</h3>
          <div className="admin__list">
            {models.length === 0 ? <p className="admin__empty">Keine Modelle vorhanden.</p> : null}
            {models.map((model) => (
              <form key={model.id} className="admin-card" onSubmit={(event) => handleUpdateModel(event, model)}>
                <header className="admin-card__header">
                  <div>
                    <h4>{model.title}</h4>
                    <span className="admin-card__subtitle">von {model.owner.displayName}</span>
                  </div>
                  <span className="admin-card__badge">{model.version}</span>
                </header>
                <div className="admin-card__body">
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
                <footer className="admin-card__actions">
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
                </footer>
              </form>
            ))}
          </div>
        </div>
      ) : null}

      {activeTab === 'images' ? (
        <div className="admin__panel">
          <h3>Bilder verwalten</h3>
          <div className="admin__list">
            {images.length === 0 ? <p className="admin__empty">Keine Bilder vorhanden.</p> : null}
            {images.map((image) => (
              <form key={image.id} className="admin-card" onSubmit={(event) => handleUpdateImage(event, image)}>
                <header className="admin-card__header">
                  <div>
                    <h4>{image.title}</h4>
                    <span className="admin-card__subtitle">von {image.owner.displayName}</span>
                  </div>
                  <span className="admin-card__badge">{new Date(image.updatedAt).toLocaleDateString('de-DE')}</span>
                </header>
                <div className="admin-card__body">
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
                <footer className="admin-card__actions">
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
                </footer>
              </form>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
};
