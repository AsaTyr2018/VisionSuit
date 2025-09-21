import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, MouseEvent } from 'react';

import { api, ApiError } from '../lib/api';
import { resolveCachedStorageUrl } from '../lib/storage';
import type { Gallery } from '../types/api';

type CoverStatus = { type: 'success' | 'error'; message: string };
type GalleryImage = NonNullable<Gallery['entries'][number]['imageAsset']>;

const buildStorageUri = (bucket?: string | null, object?: string | null) =>
  bucket && object ? `s3://${bucket}/${object}` : null;

const buildGalleryCoverValue = (gallery: Gallery) =>
  buildStorageUri(gallery.coverImageBucket, gallery.coverImageObject) ?? gallery.coverImage ?? '';

const buildGalleryCoverPreview = (gallery: Gallery) =>
  resolveCachedStorageUrl(
    gallery.coverImage,
    gallery.coverImageBucket,
    gallery.coverImageObject,
    { updatedAt: gallery.updatedAt, cacheKey: gallery.id },
  ) ?? (gallery.coverImage ?? null);

const buildImageCoverValue = (image: GalleryImage) =>
  buildStorageUri(image.storageBucket, image.storageObject) ?? image.storagePath;

const buildImagePreviewUrl = (image: GalleryImage) =>
  resolveCachedStorageUrl(image.storagePath, image.storageBucket, image.storageObject, {
    updatedAt: image.updatedAt,
    cacheKey: image.id,
  }) ?? image.storagePath;

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
  const {
    coverImage: galleryCoverImage,
    coverImageBucket: galleryCoverImageBucket,
    coverImageObject: galleryCoverImageObject,
  } = gallery;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [coverImage, setCoverImage] = useState('');
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverStatus, setCoverStatus] = useState<CoverStatus | null>(null);
  const [isCoverPickerOpen, setCoverPickerOpen] = useState(false);
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isProcessingCover, setIsProcessingCover] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  const applyCoverFromGallery = useCallback((target: Gallery) => {
    setCoverImage(buildGalleryCoverValue(target));
    setCoverPreview(buildGalleryCoverPreview(target));
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setDescription('');
      setCoverImage('');
      setCoverPreview(null);
      setCoverStatus(null);
      setCoverPickerOpen(false);
      setVisibility('public');
      setError(null);
      setDetails([]);
      setIsSubmitting(false);
      setIsProcessingCover(false);
      if (coverInputRef.current) {
        coverInputRef.current.value = '';
      }
      return;
    }

    setTitle(gallery.title);
    setDescription(gallery.description ?? '');
    setVisibility(gallery.isPublic ? 'public' : 'private');
    setError(null);
    setDetails([]);
    setIsSubmitting(false);
    setCoverStatus(null);
    setCoverPickerOpen(false);
    setIsProcessingCover(false);
  }, [gallery.description, gallery.id, gallery.isPublic, gallery.title, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setCoverImage(buildStorageUri(galleryCoverImageBucket, galleryCoverImageObject) ?? galleryCoverImage ?? '');
    setCoverPreview(
      resolveCachedStorageUrl(
        galleryCoverImage,
        galleryCoverImageBucket,
        galleryCoverImageObject,
        { updatedAt: gallery.updatedAt, cacheKey: gallery.id },
      ) ?? (galleryCoverImage ?? null),
    );
  }, [galleryCoverImage, galleryCoverImageBucket, galleryCoverImageObject, gallery.id, gallery.updatedAt, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!isSubmitting && !isProcessingCover) {
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
  }, [isOpen, isProcessingCover, isSubmitting, onClose]);

  const handleBackdropClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !isSubmitting && !isProcessingCover) {
        onClose();
      }
    },
    [isProcessingCover, isSubmitting, onClose],
  );

  const galleryImages = useMemo(
    () =>
      gallery.entries
        .map((entry) => entry.imageAsset)
        .filter((image): image is GalleryImage => Boolean(image)),
    [gallery.entries],
  );

  const updateCoverFromResponse = useCallback(
    (updated: Gallery, status: CoverStatus) => {
      applyCoverFromGallery(updated);
      setCoverStatus(status);
      onSuccess?.(updated);
    },
    [applyCoverFromGallery, onSuccess],
  );

  const handleCoverUploadClick = () => {
    if (!token) {
      setCoverStatus({ type: 'error', message: 'Please sign in to update the cover.' });
      return;
    }

    coverInputRef.current?.click();
  };

  const handleCoverFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!token) {
      setCoverStatus({ type: 'error', message: 'Please sign in to update the cover.' });
      event.target.value = '';
      return;
    }

    setIsProcessingCover(true);
    setCoverStatus(null);

    try {
      const updated = await api.uploadGalleryCover(token, gallery.id, file);
      updateCoverFromResponse(updated, { type: 'success', message: 'Cover image uploaded.' });
      setCoverPickerOpen(false);
    } catch (uploadError) {
      if (uploadError instanceof ApiError) {
        setCoverStatus({ type: 'error', message: uploadError.message });
      } else if (uploadError instanceof Error) {
        setCoverStatus({ type: 'error', message: uploadError.message });
      } else {
        setCoverStatus({ type: 'error', message: 'Unknown error while uploading the cover image.' });
      }
    } finally {
      setIsProcessingCover(false);
      event.target.value = '';
    }
  };

  const handleSelectCover = async (image: GalleryImage) => {
    if (!token) {
      setCoverStatus({ type: 'error', message: 'Please sign in to update the cover.' });
      return;
    }

    if (isProcessingCover) {
      return;
    }

    setIsProcessingCover(true);
    setCoverStatus(null);

    try {
      const candidate = buildImageCoverValue(image);
      const updated = await api.updateGallery(token, gallery.id, { coverImage: candidate });
      updateCoverFromResponse(updated, { type: 'success', message: 'Cover image updated.' });
      setCoverPickerOpen(false);
    } catch (selectError) {
      if (selectError instanceof ApiError) {
        setCoverStatus({ type: 'error', message: selectError.message });
      } else if (selectError instanceof Error) {
        setCoverStatus({ type: 'error', message: selectError.message });
      } else {
        setCoverStatus({ type: 'error', message: 'Unknown error while selecting the cover image.' });
      }
    } finally {
      setIsProcessingCover(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting || isProcessingCover) {
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
          <button
            type="button"
            className="edit-dialog__close"
            onClick={onClose}
            disabled={isSubmitting || isProcessingCover}
          >
            Close
          </button>
        </header>
        <form className="edit-dialog__form" onSubmit={handleSubmit}>
          <label className="edit-dialog__field">
            <span>Title</span>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={isSubmitting || isProcessingCover}
              required
            />
          </label>
          <label className="edit-dialog__field">
            <span>Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={isSubmitting || isProcessingCover}
              rows={4}
            />
          </label>
          <div className="edit-dialog__field">
            <span>Cover image</span>
            <div className="edit-dialog__cover-preview">
              {coverPreview ? (
                <img src={coverPreview} alt="Gallery cover preview" />
              ) : (
                <span className="edit-dialog__cover-placeholder">No cover selected</span>
              )}
            </div>
            <div className="edit-dialog__cover-actions">
              <button
                type="button"
                className="button button--subtle"
                onClick={handleCoverUploadClick}
                disabled={isSubmitting || isProcessingCover}
              >
                Upload cover
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setCoverPickerOpen((previous) => !previous)}
                disabled={isSubmitting || isProcessingCover}
              >
                {isCoverPickerOpen ? 'Hide selector' : 'Select cover'}
              </button>
            </div>
            <input
              ref={coverInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleCoverFileChange}
              style={{ display: 'none' }}
            />
            {isProcessingCover ? (
              <p className="edit-dialog__cover-status" role="status">
                Updating cover…
              </p>
            ) : coverStatus ? (
              <p
                className={`edit-dialog__cover-status edit-dialog__cover-status--${coverStatus.type}`}
                role={coverStatus.type === 'error' ? 'alert' : 'status'}
              >
                {coverStatus.message}
              </p>
            ) : null}
            {isCoverPickerOpen ? (
              galleryImages.length > 0 ? (
                <div className="edit-dialog__cover-selector">
                  {galleryImages.map((image) => {
                    const candidate = buildImageCoverValue(image);
                    const previewUrl = buildImagePreviewUrl(image);
                    return (
                      <button
                        type="button"
                        key={image.id}
                        className={`edit-dialog__cover-option${candidate === coverImage ? ' edit-dialog__cover-option--active' : ''}`}
                        onClick={() => handleSelectCover(image)}
                        disabled={isSubmitting || isProcessingCover}
                        aria-label={`Use ${image.title || 'gallery image'} as cover`}
                      >
                        <img src={previewUrl} alt={image.title || 'Gallery image'} />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="edit-dialog__cover-empty">Add images to this collection to select a cover.</p>
              )
            ) : null}
          </div>
          <label className="edit-dialog__field">
            <span>Visibility</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as 'public' | 'private')}
              disabled={isSubmitting || isProcessingCover}
            >
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
            <button
              type="button"
              onClick={onClose}
              className="edit-dialog__secondary"
              disabled={isSubmitting || isProcessingCover}
            >
              Cancel
            </button>
            <button type="submit" className="edit-dialog__primary" disabled={isSubmitting || isProcessingCover}>
              {isSubmitting ? 'Saving…' : 'Save changes'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
