import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';

import { api, ApiError } from '../lib/api';
import type { Gallery } from '../types/api';

interface GalleryEditDialogProps {
  isOpen: boolean;
  onClose: () => void;
  gallery: Gallery;
  token: string | null | undefined;
  onSuccess?: (updated: Gallery) => void;
}

export const GalleryEditDialog = ({
  isOpen,
  onClose,
  gallery,
  token,
  onSuccess,
}: GalleryEditDialogProps) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [coverImage, setCoverImage] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setDescription('');
      setCoverImage('');
      setVisibility('public');
      setError(null);
      setDetails([]);
      setIsSubmitting(false);
      return;
    }

    setTitle(gallery.title);
    setDescription(gallery.description ?? '');
    setCoverImage(gallery.coverImage ?? '');
    setVisibility(gallery.isPublic ? 'public' : 'private');
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
  }, [gallery, isOpen, isSubmitting, onClose]);

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
      setError('Please sign in to edit this gallery.');
      setDetails([]);
      return;
    }

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedCoverImage = coverImage.trim();

    if (!trimmedTitle) {
      setError('Please provide a gallery title.');
      setDetails([]);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setDetails([]);

    try {
      const updated = await api.updateGallery(token, gallery.id, {
        title: trimmedTitle,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        isPublic: visibility === 'public',
        coverImage: trimmedCoverImage.length > 0 ? trimmedCoverImage : null,
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
        setError('Unknown error while updating the gallery.');
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
    <div className="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="gallery-edit-title" onClick={handleBackdropClick}>
      <div className="edit-dialog__content">
        <header className="edit-dialog__header">
          <h3 id="gallery-edit-title">Edit collection</h3>
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
            <span>Cover image URL</span>
            <input
              type="text"
              value={coverImage}
              onChange={(event) => setCoverImage(event.target.value)}
              disabled={isSubmitting}
              placeholder="Optional direct image URL"
            />
          </label>
          <label className="edit-dialog__field">
            <span>Visibility</span>
            <select value={visibility} onChange={(event) => setVisibility(event.target.value as 'public' | 'private')} disabled={isSubmitting}>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
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
