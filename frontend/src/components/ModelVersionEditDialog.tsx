import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';

import { api, ApiError } from '../lib/api';
import type { ModelAsset, ModelVersion } from '../types/api';

interface ModelVersionEditDialogProps {
  isOpen: boolean;
  onClose: () => void;
  model: ModelAsset;
  version: ModelVersion | null;
  token: string | null | undefined;
  onSuccess?: (updated: ModelAsset, refreshedVersion: ModelVersion | null) => void;
}

export const ModelVersionEditDialog = ({
  isOpen,
  onClose,
  model,
  version,
  token,
  onSuccess,
}: ModelVersionEditDialogProps) => {
  const [versionLabel, setVersionLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const normalizedOriginal = useMemo(() => version?.version.trim() ?? '', [version?.version]);

  useEffect(() => {
    if (!isOpen || !version) {
      setVersionLabel('');
      setError(null);
      setDetails([]);
      setIsSubmitting(false);
      return;
    }

    setVersionLabel(version.version);
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
  }, [isOpen, isSubmitting, onClose, version]);

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
    if (!version) {
      return;
    }

    if (isSubmitting) {
      return;
    }

    const trimmed = versionLabel.trim();

    if (!token) {
      setError('Please sign in to edit this version.');
      setDetails([]);
      return;
    }

    if (!trimmed) {
      setError('Please provide a version label.');
      setDetails([]);
      return;
    }

    if (trimmed === normalizedOriginal) {
      setError('Please change the version label before saving.');
      setDetails([]);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setDetails([]);

    try {
      const updatedAsset = await api.updateModelVersion(token, model.id, version.id, { version: trimmed });
      const refreshedVersion =
        updatedAsset.versions.find((entry) => entry.id === version.id) ??
        (version.isPrimary ? updatedAsset.versions.find((entry) => entry.isPrimary) ?? null : null);
      onSuccess?.(updatedAsset, refreshedVersion ?? null);
      onClose();
    } catch (updateError) {
      if (updateError instanceof ApiError) {
        setError(updateError.message);
        setDetails(updateError.details ?? []);
      } else if (updateError instanceof Error) {
        setError(updateError.message);
        setDetails([]);
      } else {
        setError('Unknown error while updating the model version.');
        setDetails([]);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen || !version) {
    return null;
  }

  const headingSuffix = version.isPrimary ? 'Primary version' : `Version ${normalizedOriginal || version.version}`;

  return (
    <div
      className="model-version-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="model-version-edit-title"
      onClick={handleBackdropClick}
    >
      <div className="model-version-dialog__content">
        <header className="model-version-dialog__header">
          <h3 id="model-version-edit-title">Edit {headingSuffix} for {model.title}</h3>
          <button
            type="button"
            className="model-version-dialog__close"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Close
          </button>
        </header>
        <form className="model-version-dialog__form" onSubmit={handleSubmit}>
          <label className="model-version-dialog__field">
            <span>Version label</span>
            <input
              type="text"
              value={versionLabel}
              onChange={(event) => setVersionLabel(event.target.value)}
              placeholder="e.g. 1.3.0"
              disabled={isSubmitting}
              required
            />
          </label>

          {error ? (
            <div className="model-version-dialog__error" role="alert">
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

          <footer className="model-version-dialog__actions">
            <button type="button" onClick={onClose} className="model-version-dialog__secondary" disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" className="model-version-dialog__primary" disabled={isSubmitting || !token}>
              {isSubmitting ? 'Saving…' : 'Save changes'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
