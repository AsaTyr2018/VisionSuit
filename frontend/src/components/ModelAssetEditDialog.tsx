import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react';

import { api, ApiError } from '../lib/api';
import type { ModelAsset } from '../types/api';

interface ModelAssetEditDialogProps {
  isOpen: boolean;
  onClose: () => void;
  model: ModelAsset;
  token: string | null | undefined;
  onSuccess?: (updated: ModelAsset) => void;
  owners?: { id: string; label: string }[];
}

const parseTags = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

type ModelEditTab = 'overview' | 'prompting' | 'ownership';

const modelEditTabs: { id: ModelEditTab; label: string; description: string }[] = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'Adjust the public-facing title, description, and discoverability tags.',
  },
  {
    id: 'prompting',
    label: 'Prompting',
    description: 'Curate trigger keywords and the primary version label members see.',
  },
  {
    id: 'ownership',
    label: 'Ownership',
    description: 'Reassign the curator responsible for this LoRA asset.',
  },
];

const formatDateTime = (value: string) => new Date(value).toLocaleString('en-US');

const formatFileSize = (bytes?: number | null) => {
  if (!bytes || Number.isNaN(bytes)) {
    return null;
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let remaining = bytes;
  let unitIndex = 0;

  while (remaining >= 1024 && unitIndex < units.length - 1) {
    remaining /= 1024;
    unitIndex += 1;
  }

  return `${remaining.toFixed(remaining >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

export const ModelAssetEditDialog = ({
  isOpen,
  onClose,
  model,
  token,
  onSuccess,
  owners = [],
}: ModelAssetEditDialogProps) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('');
  const [trigger, setTrigger] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ownerId, setOwnerId] = useState('');
  const [activeTab, setActiveTab] = useState<ModelEditTab>('overview');

  const tabIndexById = useMemo(() => {
    const entries = new Map<ModelEditTab, number>();
    modelEditTabs.forEach((tab, index) => entries.set(tab.id, index));
    return entries;
  }, []);

  const handleTabKeyNavigation = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, current: ModelEditTab) => {
      const currentIndex = tabIndexById.get(current) ?? 0;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        const nextIndex = (currentIndex + 1) % modelEditTabs.length;
        setActiveTab(modelEditTabs[nextIndex].id);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        const previousIndex = (currentIndex - 1 + modelEditTabs.length) % modelEditTabs.length;
        setActiveTab(modelEditTabs[previousIndex].id);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setActiveTab(modelEditTabs[0].id);
      } else if (event.key === 'End') {
        event.preventDefault();
        setActiveTab(modelEditTabs[modelEditTabs.length - 1].id);
      }
    },
    [tabIndexById],
  );

  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setDescription('');
      setVersion('');
      setTrigger('');
      setTags('');
      setError(null);
      setDetails([]);
      setIsSubmitting(false);
      setOwnerId('');
      setActiveTab('overview');
      return;
    }

    setTitle(model.title);
    setDescription(model.description ?? '');
    setVersion(model.version);
    setTrigger(model.trigger ?? '');
    setTags(model.tags.map((tag) => tag.label).join(', '));
    setError(null);
    setDetails([]);
    setIsSubmitting(false);
    setOwnerId(model.owner.id);
    setActiveTab('overview');

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!isSubmitting) {
          onClose();
        }
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, isSubmitting, model, onClose]);

  const handleBackdropClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !isSubmitting) {
        onClose();
      }
    },
    [isSubmitting, onClose],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    if (!token) {
      setError('Please sign in to edit this model.');
      setDetails([]);
      return;
    }

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedVersion = version.trim();
    const trimmedTrigger = trigger.trim();
    const parsedTags = parseTags(tags);
    const normalizedOwner = ownerId.trim();

    if (!trimmedTitle) {
      setError('Please provide a title for the model.');
      setDetails([]);
      return;
    }

    if (!trimmedTrigger) {
      setError('Please provide a trigger keyword for the model.');
      setDetails([]);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setDetails([]);

    try {
      const payload: Parameters<typeof api.updateModelAsset>[2] = {
        title: trimmedTitle,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        version: trimmedVersion.length > 0 ? trimmedVersion : undefined,
        trigger: trimmedTrigger,
        tags: parsedTags,
      };

      if (normalizedOwner && normalizedOwner !== model.owner.id) {
        payload.ownerId = normalizedOwner;
      }

      const updated = await api.updateModelAsset(token, model.id, payload);
      onSuccess?.(updated);
      onClose();
    } catch (updateError) {
      if (updateError instanceof ApiError) {
        setError(updateError.message);
        setDetails(updateError.details ?? []);
      } else if (updateError instanceof Error) {
        setError(updateError.message);
        setDetails([]);
      } else {
        setError('Unknown error while updating the model.');
        setDetails([]);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  const ownerOptions = owners.some((owner) => owner.id === ownerId)
    ? owners
    : ownerId
    ? [{ id: ownerId, label: model.owner.displayName }, ...owners]
    : owners;

  return (
    <div className="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="model-edit-title" onClick={handleBackdropClick}>
      <div className="edit-dialog__content edit-dialog__content--xl">
        <header className="edit-dialog__header">
          <h3 id="model-edit-title">Edit model details</h3>
          <button type="button" className="edit-dialog__close" onClick={onClose} disabled={isSubmitting}>
            Close
          </button>
        </header>
        <div className="edit-dialog__layout edit-dialog__layout--split">
          <form className="edit-dialog__form" onSubmit={handleSubmit}>
            <div className="edit-dialog__tabs" role="tablist" aria-label="Model settings">
              {modelEditTabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    id={`model-edit-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`model-edit-panel-${tab.id}`}
                    className={`edit-dialog__tab${isActive ? ' edit-dialog__tab--active' : ''}`}
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={(event) => handleTabKeyNavigation(event, tab.id)}
                    disabled={isSubmitting}
                  >
                    <span className="edit-dialog__tab-label">{tab.label}</span>
                    <span className="edit-dialog__tab-description">{tab.description}</span>
                  </button>
                );
              })}
            </div>

            <div className="edit-dialog__panels">
              {modelEditTabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <section
                    key={tab.id}
                    id={`model-edit-panel-${tab.id}`}
                    role="tabpanel"
                    aria-labelledby={`model-edit-tab-${tab.id}`}
                    className={`edit-dialog__panel${isActive ? ' edit-dialog__panel--active' : ''}`}
                    hidden={!isActive}
                  >
                    {tab.id === 'overview' ? (
                      <div className="edit-dialog__panel-grid">
                        <label className="edit-dialog__field edit-dialog__field--wide">
                          <span>Title</span>
                          <input
                            type="text"
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            disabled={isSubmitting}
                            required
                          />
                        </label>
                        <label className="edit-dialog__field edit-dialog__field--wide">
                          <span>Description</span>
                          <textarea
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            disabled={isSubmitting}
                            rows={4}
                          />
                        </label>
                        <label className="edit-dialog__field">
                          <span>Tags</span>
                          <input
                            type="text"
                            value={tags}
                            onChange={(event) => setTags(event.target.value)}
                            disabled={isSubmitting}
                            placeholder="Comma-separated tags"
                          />
                        </label>
                      </div>
                    ) : null}
                    {tab.id === 'prompting' ? (
                      <div className="edit-dialog__panel-grid">
                        <label className="edit-dialog__field">
                          <span>Primary version label</span>
                          <input
                            type="text"
                            value={version}
                            onChange={(event) => setVersion(event.target.value)}
                            disabled={isSubmitting}
                            placeholder="e.g. 1.2.0"
                          />
                        </label>
                        <label className="edit-dialog__field">
                          <span>Trigger / Activator</span>
                          <input
                            type="text"
                            value={trigger}
                            onChange={(event) => setTrigger(event.target.value)}
                            disabled={isSubmitting}
                            placeholder="Optional keyword"
                          />
                        </label>
                        <p className="edit-dialog__hint">
                          Version labels appear in the admin console and download prompts. Triggers surface in the upload wizard
                          and curator explorers to guide prompting.
                        </p>
                      </div>
                    ) : null}
                    {tab.id === 'ownership' ? (
                      <div className="edit-dialog__panel-grid">
                        <label className="edit-dialog__field">
                          <span>Asset owner</span>
                          <select
                            value={ownerId}
                            onChange={(event) => setOwnerId(event.target.value)}
                            disabled={isSubmitting}
                          >
                            {ownerOptions.map((owner) => (
                              <option key={owner.id} value={owner.id}>
                                {owner.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <p className="edit-dialog__hint">
                          Ownership controls who sees the model inside their curator dashboard. Administrators retain full
                          visibility regardless of assignment.
                        </p>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>

            {error ? (
              <div className="edit-dialog__error" role="alert">
                <p>{error}</p>
                {details.length > 0 ? (
                  <ul>
                    {details.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <footer className="edit-dialog__actions">
              <button type="button" onClick={onClose} className="edit-dialog__secondary" disabled={isSubmitting}>
                Cancel
              </button>
              <button type="submit" className="edit-dialog__primary" disabled={isSubmitting}>
                {isSubmitting ? 'Saving…' : 'Save changes'}
              </button>
            </footer>
          </form>
          <aside className="edit-dialog__sidebar" aria-label="Model summary">
            <h4 className="edit-dialog__summary-title">Quick facts</h4>
            <dl className="edit-dialog__summary-list">
              <div>
                <dt>Owner</dt>
                <dd>{model.owner.displayName}</dd>
              </div>
              <div>
                <dt>Visibility</dt>
                <dd>{model.isPublic ? 'Public' : 'Private'}</dd>
              </div>
              <div>
                <dt>Versions</dt>
                <dd>{model.versions.length}</dd>
              </div>
              {model.fileSize ? (
                <div>
                  <dt>Latest file size</dt>
                  <dd>{formatFileSize(model.fileSize)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Primary version</dt>
                <dd>{model.version || '—'}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatDateTime(model.updatedAt)}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(model.createdAt)}</dd>
              </div>
            </dl>
            {model.tags.length > 0 ? (
              <div className="edit-dialog__summary-tags" aria-label="Existing tags">
                {model.tags.map((tag) => (
                  <span key={tag.id} className="admin-badge">
                    {tag.label}
                  </span>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
};
