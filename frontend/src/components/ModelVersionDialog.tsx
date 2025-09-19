import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';

import { api, ApiError } from '../lib/api';
import type { ModelAsset, ModelVersion } from '../types/api';

interface ModelVersionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  model: ModelAsset;
  token: string | null | undefined;
  onSuccess?: (updated: ModelAsset, createdVersion: ModelVersion | null) => void;
}

export const ModelVersionDialog = ({ isOpen, onClose, model, token, onSuccess }: ModelVersionDialogProps) => {
  const [version, setVersion] = useState('');
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const existingVersionIds = useMemo(() => new Set(model.versions.map((entry) => entry.id)), [model.versions]);

  useEffect(() => {
    if (!isOpen) {
      setVersion('');
      setModelFile(null);
      setPreviewFile(null);
      setError(null);
      setDetails([]);
      setIsSubmitting(false);
      return;
    }

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
  }, [isOpen, isSubmitting, onClose]);

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

    const trimmedVersion = version.trim();
    if (!token) {
      setError('Please sign in to upload a new model version.');
      setDetails([]);
      return;
    }

    if (trimmedVersion.length === 0) {
      setError('Please enter a version number.');
      setDetails([]);
      return;
    }

    if (!modelFile) {
      setError('Please select the safetensors file.');
      setDetails([]);
      return;
    }

    if (!modelFile.name.toLowerCase().endsWith('.safetensors')) {
      setError('The model file must use the safetensors format.');
      setDetails([]);
      return;
    }

    if (!previewFile) {
      setError('Please select a preview image.');
      setDetails([]);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setDetails([]);

    try {
      const updatedAsset = await api.createModelVersion(token, model.id, {
        version: trimmedVersion,
        modelFile,
        previewFile,
      });

      const createdVersion =
        updatedAsset.versions.find((entry) => !existingVersionIds.has(entry.id)) ??
        updatedAsset.versions.find((entry) => entry.version === trimmedVersion) ??
        null;

      onSuccess?.(updatedAsset, createdVersion);
      onClose();
    } catch (uploadError) {
      if (uploadError instanceof ApiError) {
        setError(uploadError.message);
        setDetails(uploadError.details ?? []);
      } else if (uploadError instanceof Error) {
        setError(uploadError.message);
        setDetails([]);
      } else {
        setError('Unknown error while uploading the model version.');
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
    <div className="model-version-dialog" role="dialog" aria-modal="true" aria-labelledby="model-version-title" onClick={handleBackdropClick}>
      <div className="model-version-dialog__content">
        <header className="model-version-dialog__header">
          <h3 id="model-version-title">New version for {model.title}</h3>
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
            <span>Version number</span>
            <input
              type="text"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="e.g. 1.2.0"
              disabled={isSubmitting}
              required
            />
          </label>
          <label className="model-version-dialog__field">
            <span>Safetensors file</span>
            <input
              type="file"
              accept=".safetensors"
              onChange={(event) => setModelFile(event.target.files?.[0] ?? null)}
              disabled={isSubmitting}
              required
            />
            {modelFile ? <small className="model-version-dialog__hint">{modelFile.name}</small> : null}
          </label>
          <label className="model-version-dialog__field">
            <span>Preview image</span>
            <input
              type="file"
              accept="image/*"
              onChange={(event) => setPreviewFile(event.target.files?.[0] ?? null)}
              disabled={isSubmitting}
              required
            />
            {previewFile ? <small className="model-version-dialog__hint">{previewFile.name}</small> : null}
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
              {isSubmitting ? 'Uploading…' : 'Upload version'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
