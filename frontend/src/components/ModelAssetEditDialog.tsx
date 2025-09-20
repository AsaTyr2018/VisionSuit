import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';

import { api, ApiError } from '../lib/api';
import type { ModelAsset } from '../types/api';

interface ModelAssetEditDialogProps {
  isOpen: boolean;
  onClose: () => void;
  model: ModelAsset;
  token: string | null | undefined;
  onSuccess?: (updated: ModelAsset) => void;
}

const parseTags = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const ModelAssetEditDialog = ({
  isOpen,
  onClose,
  model,
  token,
  onSuccess,
}: ModelAssetEditDialogProps) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('');
  const [trigger, setTrigger] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

    if (!trimmedTitle) {
      setError('Please provide a title for the model.');
      setDetails([]);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setDetails([]);

    try {
      const updated = await api.updateModelAsset(token, model.id, {
        title: trimmedTitle,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        version: trimmedVersion.length > 0 ? trimmedVersion : undefined,
        trigger: trimmedTrigger.length > 0 ? trimmedTrigger : null,
        tags: parsedTags,
      });
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

  return (
    <div className="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="model-edit-title" onClick={handleBackdropClick}>
      <div className="edit-dialog__content">
        <header className="edit-dialog__header">
          <h3 id="model-edit-title">Edit model details</h3>
          <button type="button" className="edit-dialog__close" onClick={onClose} disabled={isSubmitting}>
            Close
          </button>
        </header>
        <form className="edit-dialog__form" onSubmit={handleSubmit}>
          <label className="edit-dialog__field">
            <span>Title</span>
            <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} disabled={isSubmitting} required />
          </label>
          <label className="edit-dialog__field">
            <span>Description</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} disabled={isSubmitting} rows={4} />
          </label>
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
      </div>
    </div>
  );
};
