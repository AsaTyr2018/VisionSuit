import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';

import type { AssetComment, Gallery, ImageAsset, ModelAsset, User } from '../types/api';

import { api, ApiError } from '../lib/api';
import { resolveCachedStorageUrl } from '../lib/storage';
import { isAuditPlaceholderForViewer } from '../lib/moderation';

import { FilterChip } from './FilterChip';
import { GalleryEditDialog } from './GalleryEditDialog';
import { ImageAssetEditDialog } from './ImageAssetEditDialog';
import { CommentSection } from './CommentSection';

interface GalleryExplorerProps {
  galleries: Gallery[];
  isLoading: boolean;
  onStartGalleryDraft: () => void;
  onNavigateToModel?: (modelId: string) => void;
  initialGalleryId?: string | null;
  onCloseDetail?: () => void;
  externalSearchQuery?: string | null;
  onExternalSearchApplied?: () => void;
  authToken?: string | null;
  currentUser?: User | null;
  onGalleryUpdated?: (gallery: Gallery) => void;
  onImageUpdated?: (image: ImageAsset) => void;
  onOpenProfile?: (userId: string) => void;
  onGalleryDeleted?: (galleryId: string) => void;
  onImageDeleted?: (imageId: string) => void;
}

type VisibilityFilter = 'all' | 'public' | 'private';
type EntryFilter = 'all' | 'with-image' | 'with-model' | 'empty';
type SortOption = 'recent' | 'alpha' | 'entries-desc' | 'entries-asc';

type GalleryImageEntry = {
  entryId: string;
  image: ImageAsset;
  note: string | null;
};

const GALLERY_BATCH_SIZE = 15;

const normalize = (value?: string | null) => value?.toLowerCase().normalize('NFKD') ?? '';

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

const formatApiErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof ApiError) {
    const details = (error.details ?? []).filter((entry) => entry && entry.length > 0).join(' ');
    const message = [error.message, details].filter(Boolean).join(' ').trim();
    return message.length > 0 ? message : fallback;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
};

const getGalleryEntries = (gallery: Gallery) => {
  const entries = (gallery as Gallery & { entries?: Gallery['entries'] | null }).entries;
  return Array.isArray(entries) ? entries : [];
};

const getGalleryOwner = (gallery: Gallery) => {
  const owner = (gallery as Gallery & { owner?: Gallery['owner'] | null }).owner;
  return owner ?? null;
};

const matchesSearch = (gallery: Gallery, query: string) => {
  if (!query) return true;
  const entries = getGalleryEntries(gallery);
  const owner = getGalleryOwner(gallery);
  const haystack = [
    gallery.title,
    gallery.slug,
    gallery.description ?? '',
    owner?.displayName ?? '',
    ...entries.flatMap((entry) => {
      const texts: string[] = [];
      if (entry.modelAsset?.title) texts.push(entry.modelAsset.title);
      if (entry.imageAsset?.title) texts.push(entry.imageAsset.title);
      if (entry.note) texts.push(entry.note);
      if (entry.imageAsset?.prompt) texts.push(entry.imageAsset.prompt);
      if (entry.imageAsset?.negativePrompt) texts.push(entry.imageAsset.negativePrompt);
      entry.imageAsset?.tags.forEach((tag) => texts.push(tag.label));
      collectImageMetadataStrings(entry.imageAsset?.metadata).forEach((value) => texts.push(value));
      if (entry.modelAsset?.metadata) {
        collectModelMetadataStrings(entry.modelAsset.metadata as Record<string, unknown> | null).forEach((value) =>
          texts.push(value),
        );
      }
      entry.modelAsset?.tags.forEach((tag) => texts.push(tag.label));
      return texts;
    }),
  ]
    .map((entry) => normalize(entry))
    .join(' ');
  return haystack.includes(query);
};

const galleryHasImage = (gallery: Gallery) => getGalleryEntries(gallery).some((entry) => Boolean(entry.imageAsset));
const galleryHasModel = (gallery: Gallery) => getGalleryEntries(gallery).some((entry) => Boolean(entry.modelAsset));

const getImageEntries = (gallery: Gallery): GalleryImageEntry[] =>
  getGalleryEntries(gallery)
    .filter((entry): entry is typeof entry & { imageAsset: ImageAsset } => Boolean(entry.imageAsset))
    .map((entry) => ({ entryId: entry.id, image: entry.imageAsset, note: entry.note ?? null }));

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const formatDimensions = (image: ImageAsset) =>
  image.dimensions ? `${image.dimensions.width} × ${image.dimensions.height}px` : 'Unknown';

const formatFileSize = (size?: number | null) => {
  if (!size || Number.isNaN(size)) {
    return 'Unknown';
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
};

const buildSeededIndex = (seed: string, length: number) => {
  if (length === 0) return 0;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 2147483647;
  }
  return Math.abs(hash) % length;
};

const selectPreviewImage = (gallery: Gallery, viewer?: User | null) => {
  const imageEntries = getImageEntries(gallery).filter(
    (entry) => !isAuditPlaceholderForViewer(entry.image.moderationStatus, entry.image.owner.id, viewer),
  );
  if (imageEntries.length === 0) {
    return null;
  }
  const seededIndex = buildSeededIndex(`${gallery.id}-${gallery.updatedAt}`, imageEntries.length);
  return imageEntries[seededIndex]?.image ?? null;
};

const buildMetadataRows = (image: ImageAsset) => {
  const exif = image.metadata ?? {};
  return [
    { label: 'Prompt', value: image.prompt ?? 'No prompt provided.' },
    { label: 'Negative prompt', value: image.negativePrompt ?? '–' },
    { label: 'Model', value: exif.model ?? 'Unknown' },
    { label: 'Sampler', value: exif.sampler ?? 'Unknown' },
    { label: 'Seed', value: exif.seed ?? '–' },
    { label: 'CFG Scale', value: exif.cfgScale != null ? exif.cfgScale.toString() : '–' },
    { label: 'Steps', value: exif.steps != null ? exif.steps.toString() : '–' },
    { label: 'Dimensions', value: formatDimensions(image) },
    { label: 'File size', value: formatFileSize(image.fileSize) },
  ];
};

export const GalleryExplorer = ({
  galleries,
  isLoading,
  onStartGalleryDraft,
  onNavigateToModel,
  initialGalleryId,
  onCloseDetail,
  externalSearchQuery,
  onExternalSearchApplied,
  authToken,
  currentUser,
  onGalleryUpdated,
  onImageUpdated,
  onOpenProfile,
  onGalleryDeleted,
  onImageDeleted,
}: GalleryExplorerProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [visibility, setVisibility] = useState<VisibilityFilter>('all');
  const [entryFilter, setEntryFilter] = useState<EntryFilter>('all');
  const [ownerId, setOwnerId] = useState<string>('all');
  const [sortOption, setSortOption] = useState<SortOption>('recent');
  const [visibleLimit, setVisibleLimit] = useState(GALLERY_BATCH_SIZE);
  const [activeGalleryId, setActiveGalleryId] = useState<string | null>(null);
  const [activeImage, setActiveImage] = useState<GalleryImageEntry | null>(null);
  const [galleryToEdit, setGalleryToEdit] = useState<Gallery | null>(null);
  const [imageToEdit, setImageToEdit] = useState<ImageAsset | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isDeletingGallery, setIsDeletingGallery] = useState(false);
  const [imageModalError, setImageModalError] = useState<string | null>(null);
  const [imageDeletionId, setImageDeletionId] = useState<string | null>(null);
  const [likeMutationId, setLikeMutationId] = useState<string | null>(null);
  const [imageComments, setImageComments] = useState<AssetComment[]>([]);
  const [isImageCommentsLoading, setIsImageCommentsLoading] = useState(false);
  const [imageCommentError, setImageCommentError] = useState<string | null>(null);
  const [isImageCommentSubmitting, setIsImageCommentSubmitting] = useState(false);
  const [imageCommentLikeMutationId, setImageCommentLikeMutationId] = useState<string | null>(null);
  const [isImageCommentPanelOpen, setIsImageCommentPanelOpen] = useState(false);
  const [isFlaggingImage, setIsFlaggingImage] = useState(false);
  const [imageFlagFeedback, setImageFlagFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const deferredSearch = useDeferredValue(searchTerm);
  const normalizedQuery = normalize(deferredSearch.trim());

  useEffect(() => {
    if (!externalSearchQuery) {
      return;
    }

    setSearchTerm(externalSearchQuery);
    onExternalSearchApplied?.();
  }, [externalSearchQuery, onExternalSearchApplied]);

  const ownerOptions = useMemo(() => {
    const ownersMap = new Map<string, { id: string; label: string }>();
    galleries.forEach((gallery) => {
      const owner = getGalleryOwner(gallery);
      if (owner?.id && owner.displayName && !ownersMap.has(owner.id)) {
        ownersMap.set(owner.id, { id: owner.id, label: owner.displayName });
      }
    });
    return Array.from(ownersMap.values()).sort((a, b) => a.label.localeCompare(b.label, 'en'));
  }, [galleries]);

  const filteredGalleries = useMemo(() => {
    const filtered = galleries.filter((gallery) => {
      const entries = getGalleryEntries(gallery);
      if (!matchesSearch(gallery, normalizedQuery)) return false;

      if (visibility !== 'all' && gallery.isPublic !== (visibility === 'public')) return false;

      const owner = getGalleryOwner(gallery);
      if (ownerId !== 'all' && owner?.id !== ownerId) return false;

      if (entryFilter === 'with-image' && !galleryHasImage(gallery)) return false;
      if (entryFilter === 'with-model' && !galleryHasModel(gallery)) return false;
      if (entryFilter === 'empty' && entries.length !== 0) return false;

      return true;
    });

    const sorters: Record<SortOption, (a: Gallery, b: Gallery) => number> = {
      recent: (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      alpha: (a, b) => a.title.localeCompare(b.title, 'en'),
      'entries-desc': (a, b) => getGalleryEntries(b).length - getGalleryEntries(a).length,
      'entries-asc': (a, b) => getGalleryEntries(a).length - getGalleryEntries(b).length,
    };

    return filtered.sort(sorters[sortOption]);
  }, [entryFilter, galleries, normalizedQuery, ownerId, sortOption, visibility]);

  useEffect(() => {
    setVisibleLimit(GALLERY_BATCH_SIZE);
  }, [normalizedQuery, visibility, entryFilter, ownerId, sortOption]);

  useEffect(() => {
    if (initialGalleryId) {
      setActiveGalleryId(initialGalleryId);
    }
  }, [initialGalleryId]);

  const closeDetail = useCallback(() => {
    setActiveGalleryId(null);
    setActiveImage(null);
    onCloseDetail?.();
  }, [onCloseDetail]);

  const activeGallery = useMemo(
    () => (activeGalleryId ? galleries.find((gallery) => gallery.id === activeGalleryId) ?? null : null),
    [activeGalleryId, galleries],
  );

  const activeGalleryImages = useMemo(() => (activeGallery ? getImageEntries(activeGallery) : []), [activeGallery]);

  const activeGalleryModels = useMemo(() => {
    if (!activeGallery) {
      return [] as ModelAsset[];
    }

    const map = new Map<string, ModelAsset>();
    getGalleryEntries(activeGallery).forEach((entry) => {
      if (entry.modelAsset) {
        map.set(entry.modelAsset.id, entry.modelAsset);
      }
    });
    return Array.from(map.values());
  }, [activeGallery]);

  const activeGalleryOwner = useMemo(() => (activeGallery ? getGalleryOwner(activeGallery) : null), [activeGallery]);
  const canLikeImages = useMemo(() => Boolean(authToken && currentUser), [authToken, currentUser]);
  const activeImageIdValue = activeImage?.image.id ?? null;
  const activeImageModerationStatus = activeImage?.image.moderationStatus ?? null;
  const imageCommentsAnchorId = useMemo(
    () => (activeImageIdValue ? `image-comments-${activeImageIdValue}` : 'image-comments'),
    [activeImageIdValue],
  );

  const activeImagePreviewUrl = activeImage
    ?
        resolveCachedStorageUrl(
          activeImage.image.storagePath,
          activeImage.image.storageBucket,
          activeImage.image.storageObject,
          { updatedAt: activeImage.image.updatedAt, cacheKey: activeImage.image.id },
        ) ?? activeImage.image.storagePath
    : null;

  const activeImageOverlayClasses = [
    'gallery-image-modal__media',
    activeImage?.image.moderationStatus === 'FLAGGED' ? 'moderation-overlay' : '',
    activeImage?.image.moderationStatus === 'FLAGGED' && currentUser?.role !== 'ADMIN'
      ? 'moderation-overlay--blurred'
      : activeImage?.image.moderationStatus === 'FLAGGED'
        ? 'moderation-overlay--visible'
        : '',
  ]
    .filter(Boolean)
    .join(' ');
  const imageCommentToggleLabel = useMemo(() => {
    const countSuffix = isImageCommentsLoading ? '' : ` (${imageComments.length})`;
    return `${isImageCommentPanelOpen ? 'Hide comments' : 'Show comments'}${countSuffix}`;
  }, [imageComments.length, isImageCommentPanelOpen, isImageCommentsLoading]);

  useEffect(() => {
    setIsImageCommentPanelOpen(false);
  }, [activeImageIdValue]);

  useEffect(() => {
    if (imageCommentError || isImageCommentSubmitting) {
      setIsImageCommentPanelOpen(true);
    }
  }, [imageCommentError, isImageCommentSubmitting]);

  useEffect(() => {
    if (!isImageCommentPanelOpen) {
      return;
    }

    const element = document.getElementById(imageCommentsAnchorId);
    element?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [imageCommentsAnchorId, isImageCommentPanelOpen]);

  useEffect(() => {
    if (activeGalleryId && !galleries.some((gallery) => gallery.id === activeGalleryId)) {
      closeDetail();
    }
  }, [activeGalleryId, galleries, closeDetail]);

  useEffect(() => {
    setActiveImage(null);
  }, [activeGalleryId]);

  useEffect(() => {
    if (!activeGalleryId || activeImage) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDetail();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeGalleryId, activeImage, closeDetail]);

  useEffect(() => {
    if (!activeGallery) {
      setGalleryToEdit(null);
      setDetailError(null);
      setIsDeletingGallery(false);
    }
  }, [activeGallery]);

  useEffect(() => {
    if (!activeImage) {
      return;
    }

    if (isAuditPlaceholderForViewer(activeImage.image.moderationStatus, activeImage.image.owner.id, currentUser)) {
      setActiveImage(null);
    }
  }, [activeImage, currentUser]);

  useEffect(() => {
    if (!activeImage) {
      setImageToEdit(null);
      setImageModalError(null);
      setImageDeletionId(null);
      setLikeMutationId(null);
      setImageComments([]);
      setImageCommentError(null);
      setIsImageCommentsLoading(false);
      setIsImageCommentSubmitting(false);
      setImageCommentLikeMutationId(null);
      setImageFlagFeedback(null);
      setIsFlaggingImage(false);
    }
  }, [activeImage]);

  useEffect(() => {
    const imageId = activeImage?.image.id ?? null;

    if (!imageId) {
      return;
    }

    let isActive = true;

    const loadComments = async () => {
      setImageComments([]);
      setIsImageCommentsLoading(true);
      setImageCommentError(null);
      setIsImageCommentSubmitting(false);
      setImageCommentLikeMutationId(null);

      try {
        const response = await api.getImageComments(imageId, authToken ?? null);
        if (isActive) {
          setImageComments(response);
        }
      } catch (error) {
        if (isActive) {
          setImageCommentError(formatApiErrorMessage(error, 'Kommentare konnten nicht geladen werden.'));
          setImageComments([]);
        }
      } finally {
        if (isActive) {
          setIsImageCommentsLoading(false);
        }
      }
    };

    void loadComments();

    return () => {
      isActive = false;
    };
  }, [activeImage?.image.id, authToken]);

  useEffect(() => {
    if (!activeImageIdValue) {
      return;
    }

    setImageFlagFeedback(null);
    setIsFlaggingImage(false);
  }, [activeImageIdValue, activeImageModerationStatus]);

  const reloadImageComments = useCallback(async () => {
    if (!activeImageIdValue) {
      return;
    }

    setIsImageCommentsLoading(true);
    setImageCommentError(null);

    try {
      const response = await api.getImageComments(activeImageIdValue, authToken ?? null);
      setImageComments(response);
    } catch (error) {
      setImageCommentError(formatApiErrorMessage(error, 'Kommentare konnten nicht geladen werden.'));
      setImageComments([]);
    } finally {
      setIsImageCommentsLoading(false);
    }
  }, [activeImageIdValue, authToken]);

  const handleSubmitImageComment = useCallback(
    async (content: string) => {
      if (!activeImageIdValue || !authToken || !canLikeImages) {
        throw new Error('Anmeldung erforderlich, um zu kommentieren.');
      }

      setIsImageCommentSubmitting(true);
      setImageCommentError(null);

      try {
        const created = await api.createImageComment(activeImageIdValue, content, authToken);
        setImageComments((current) => [...current, created]);
      } catch (error) {
        setImageCommentError(formatApiErrorMessage(error, 'Kommentar konnte nicht gespeichert werden.'));
        throw error;
      } finally {
        setIsImageCommentSubmitting(false);
      }
    },
    [activeImageIdValue, authToken, canLikeImages],
  );

  const handleToggleImageCommentLike = useCallback(
    async (comment: AssetComment) => {
      if (!activeImageIdValue || !authToken) {
        return;
      }

      setImageCommentLikeMutationId(comment.id);
      setImageCommentError(null);

      try {
        const updated = comment.viewerHasLiked
          ? await api.unlikeImageComment(activeImageIdValue, comment.id, authToken)
          : await api.likeImageComment(activeImageIdValue, comment.id, authToken);

        setImageComments((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      } catch (error) {
        setImageCommentError(formatApiErrorMessage(error, 'Kommentarlikes konnten nicht aktualisiert werden.'));
      } finally {
        setImageCommentLikeMutationId(null);
      }
    },
    [activeImageIdValue, authToken],
  );

  const handleFlagImage = useCallback(
    async (image: ImageAsset) => {
      if (!authToken) {
        setImageFlagFeedback({ type: 'error', message: 'Sign in to flag images for moderation.' });
        return;
      }

      const note = window.prompt('Optional note for the moderation team:', '');
      const reason = note && note.trim().length > 0 ? { reason: note.trim() } : undefined;

      setIsFlaggingImage(true);
      setImageFlagFeedback(null);

      try {
        const response = await api.flagImageAsset(authToken, image.id, reason);
        onImageUpdated?.(response.image);
        setImageFlagFeedback({ type: 'success', message: 'Image submitted for moderation review.' });
      } catch (error) {
        setImageFlagFeedback({
          type: 'error',
          message: formatApiErrorMessage(error, 'Moderationsanfrage konnte nicht gesendet werden.'),
        });
      } finally {
        setIsFlaggingImage(false);
      }
    },
    [authToken, onImageUpdated],
  );

  const visibleGalleries = useMemo(() => filteredGalleries.slice(0, visibleLimit), [filteredGalleries, visibleLimit]);

  const activeFilters = useMemo(() => {
    const filters: { id: string; label: string; onClear: () => void }[] = [];

    if (normalizedQuery) {
      filters.push({ id: 'search', label: `Search: “${deferredSearch.trim()}”`, onClear: () => setSearchTerm('') });
    }

    if (visibility !== 'all') {
      filters.push({
        id: `visibility-${visibility}`,
        label: visibility === 'public' ? 'Status · Public' : 'Status · Private',
        onClear: () => setVisibility('all'),
      });
    }

    if (entryFilter !== 'all') {
      const labels: Record<EntryFilter, string> = {
        all: '',
        'with-image': 'Content · With images',
        'with-model': 'Content · With LoRAs',
        empty: 'Content · No entries',
      };
      filters.push({
        id: `entries-${entryFilter}`,
        label: labels[entryFilter],
        onClear: () => setEntryFilter('all'),
      });
    }

    if (ownerId !== 'all') {
      const owner = ownerOptions.find((option) => option.id === ownerId);
      if (owner) {
        filters.push({ id: `owner-${owner.id}`, label: `Curator · ${owner.label}`, onClear: () => setOwnerId('all') });
      }
    }

    return filters;
  }, [deferredSearch, entryFilter, normalizedQuery, ownerId, ownerOptions, visibility]);

  const resetFilters = () => {
    setVisibility('all');
    setEntryFilter('all');
    setOwnerId('all');
    setSortOption('recent');
    setSearchTerm('');
  };

  const loadMore = () => {
    setVisibleLimit((current) => Math.min(filteredGalleries.length, current + GALLERY_BATCH_SIZE));
  };

  const canManageActiveGallery = useMemo(
    () =>
      Boolean(
        authToken &&
          activeGallery &&
          currentUser &&
          activeGalleryOwner &&
          (currentUser.role === 'ADMIN' || currentUser.id === activeGalleryOwner.id),
      ),
    [activeGallery, activeGalleryOwner, authToken, currentUser],
  );

  const canManageActiveImage = useMemo(
    () =>
      Boolean(
        authToken &&
          activeImage &&
          currentUser &&
          (currentUser.role === 'ADMIN' || currentUser.id === activeImage.image.owner.id),
      ),
    [activeImage, authToken, currentUser],
  );

  const handleDeleteGallery = useCallback(async () => {
    if (!activeGallery) {
      return;
    }

    if (!authToken || !canManageActiveGallery) {
      setDetailError('Please sign in to manage this collection.');
      return;
    }

    const confirmation = `Delete “${activeGallery.title}”? This cannot be undone.\nNicht umkehrbar ist wenn gelöscht wird. weg ist weg.`;
    if (!window.confirm(confirmation)) {
      return;
    }

    try {
      setIsDeletingGallery(true);
      setDetailError(null);
      await api.deleteGallery(authToken, activeGallery.id);
      onGalleryDeleted?.(activeGallery.id);
      closeDetail();
    } catch (error) {
      if (error instanceof ApiError) {
        setDetailError(error.message);
      } else if (error instanceof Error) {
        setDetailError(error.message);
      } else {
        setDetailError('Unknown error while deleting the collection.');
      }
    } finally {
      setIsDeletingGallery(false);
    }
  }, [activeGallery, authToken, canManageActiveGallery, closeDetail, onGalleryDeleted]);

  const handleDeleteImage = useCallback(
    async (entry: GalleryImageEntry) => {
      if (!authToken || !canManageActiveImage) {
        setImageModalError('Please sign in to manage this image.');
        return;
      }

      const confirmation = `Delete image “${entry.image.title}”? This cannot be undone.\nNicht umkehrbar ist wenn gelöscht wird. weg ist weg.`;
      if (!window.confirm(confirmation)) {
        return;
      }

      try {
        setImageDeletionId(entry.image.id);
        setImageModalError(null);
        await api.deleteImageAsset(authToken, entry.image.id);
        onImageDeleted?.(entry.image.id);
        setActiveImage(null);
      } catch (error) {
        if (error instanceof ApiError) {
          setImageModalError(error.message);
        } else if (error instanceof Error) {
          setImageModalError(error.message);
        } else {
          setImageModalError('Unknown error while deleting the image.');
        }
      } finally {
        setImageDeletionId((current) => (current === entry.image.id ? null : current));
      }
    },
    [authToken, canManageActiveImage, onImageDeleted],
  );

  const handleToggleLike = useCallback(
    async (image: ImageAsset) => {
      if (!authToken || !currentUser) {
        const message = 'Sign in to like images. Create an account to join the community.';
        setDetailError(message);
        setImageModalError(message);
        return;
      }

      setLikeMutationId(image.id);
      setImageModalError(null);
      setDetailError(null);

      try {
        const response = image.viewerHasLiked
          ? await api.unlikeImageAsset(authToken, image.id)
          : await api.likeImageAsset(authToken, image.id);
        const updated = response.image;
        onImageUpdated?.(updated);
        setActiveImage((previous) =>
          previous && previous.image.id === updated.id ? { ...previous, image: updated } : previous,
        );
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to update the like status.';
        setImageModalError(message);
        if (!activeImage || activeImage.image.id !== image.id) {
          setDetailError(message);
        }
      } finally {
        setLikeMutationId((current) => (current === image.id ? null : current));
      }
    },
    [activeImage, authToken, currentUser, onImageUpdated],
  );

  useEffect(() => {
    if (!activeImage) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveImage(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeImage]);

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h2 className="panel__title">Gallery explorer</h2>
          <p className="panel__subtitle">
            Curated collections with random preview tiles, fixed column widths, and detailed image views including EXIF data.
          </p>
        </div>
        <button type="button" className="panel__action" onClick={onStartGalleryDraft}>
          Open gallery upload
        </button>
      </header>

      <div className="filter-toolbar" aria-label="Filters for galleries">
        <div className="filter-toolbar__row">
          <label className="filter-toolbar__search">
            <span className="sr-only">Search in galleries</span>
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search title, curator, or slug"
              disabled={isLoading && galleries.length === 0}
            />
          </label>

          <label className="filter-toolbar__control">
            <span>Sort order</span>
            <select value={sortOption} onChange={(event) => setSortOption(event.target.value as SortOption)} className="filter-select">
              <option value="recent">Updated · Newest first</option>
              <option value="alpha">Title · A → Z</option>
              <option value="entries-desc">Entries · Many → Few</option>
              <option value="entries-asc">Entries · Few → Many</option>
            </select>
          </label>

          <div className="filter-toolbar__chips" role="group" aria-label="Filter visibility">
            <FilterChip label="All" isActive={visibility === 'all'} onClick={() => setVisibility('all')} />
            <FilterChip label="Public" isActive={visibility === 'public'} onClick={() => setVisibility('public')} />
            <FilterChip label="Private" isActive={visibility === 'private'} onClick={() => setVisibility('private')} />
          </div>

          <label className="filter-toolbar__control">
            <span>Curator</span>
            <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)} className="filter-select">
              <option value="all">All people</option>
              {ownerOptions.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="filter-toolbar__chips" role="group" aria-label="Filter content type">
          <FilterChip label="All content" isActive={entryFilter === 'all'} onClick={() => setEntryFilter('all')} />
          <FilterChip label="With images" isActive={entryFilter === 'with-image'} onClick={() => setEntryFilter('with-image')} />
          <FilterChip label="With LoRAs" isActive={entryFilter === 'with-model'} onClick={() => setEntryFilter('with-model')} />
          <FilterChip label="No entries" isActive={entryFilter === 'empty'} onClick={() => setEntryFilter('empty')} />
        </div>

        {activeFilters.length > 0 ? (
          <div className="filter-toolbar__active">
            <span className="filter-toolbar__active-label">Active filters:</span>
            <div className="filter-toolbar__active-chips">
              {activeFilters.map((filter) => (
                <button key={filter.id} type="button" className="active-filter" onClick={filter.onClear}>
                  <span>{filter.label}</span>
                  <span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
            <button type="button" className="filter-toolbar__reset" onClick={resetFilters}>
              Reset all filters
            </button>
          </div>
        ) : null}
      </div>

      <div className="result-info" role="status">
        {isLoading && galleries.length === 0
          ? 'Loading galleries…'
          : `Showing ${visibleGalleries.length} of ${filteredGalleries.length} collections`}
      </div>

      <div className="gallery-explorer__grid" role="list" aria-label="Galerien">
        {isLoading && galleries.length === 0
          ? Array.from({ length: 10 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
          : visibleGalleries.map((gallery) => {
              const entries = getGalleryEntries(gallery);
              const previewImage = selectPreviewImage(gallery, currentUser);
              const totalImages = entries.filter((entry) => Boolean(entry.imageAsset)).length;
              const totalModels = entries.filter((entry) => Boolean(entry.modelAsset)).length;
              const owner = getGalleryOwner(gallery);
              const ownerName = owner?.displayName ?? 'Unknown curator';
              return (
                <article
                  key={gallery.id}
                  role="listitem"
                  tabIndex={0}
                  className={`gallery-card${activeGalleryId === gallery.id ? ' gallery-card--active' : ''}`}
                  onClick={() => setActiveGalleryId(gallery.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setActiveGalleryId(gallery.id);
                    }
                  }}
                >
                  <div className="gallery-card__preview" aria-hidden={previewImage ? 'false' : 'true'}>
                    {previewImage ? (
                      <img
                        src={
                          resolveCachedStorageUrl(
                            previewImage.storagePath,
                            previewImage.storageBucket,
                            previewImage.storageObject,
                            { updatedAt: previewImage.updatedAt, cacheKey: previewImage.id },
                          ) ?? previewImage.storagePath
                        }
                        alt={previewImage.title}
                        loading="lazy"
                      />
                    ) : (
                      <span>No preview available</span>
                    )}
                  </div>
                  <div className="gallery-card__body">
                    <h3 className="gallery-card__title">{gallery.title}</h3>
                    <p className="gallery-card__meta">
                      Curated by{' '}
                      {onOpenProfile && owner?.id ? (
                        <button
                          type="button"
                          className="curator-link"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenProfile(owner.id);
                          }}
                        >
                          {ownerName}
                        </button>
                      ) : (
                        ownerName
                      )}
                    </p>
                    <dl className="gallery-card__stats">
                      <div>
                        <dt>Entries</dt>
                        <dd>{entries.length}</dd>
                      </div>
                      <div>
                        <dt>Images</dt>
                        <dd>{totalImages}</dd>
                      </div>
                      <div>
                        <dt>LoRAs</dt>
                        <dd>{totalModels}</dd>
                      </div>
                    </dl>
                    <p className="gallery-card__timestamp">Last updated on {formatDate(gallery.updatedAt)}</p>
                  </div>
                </article>
              );
            })}
      </div>

      {!isLoading && visibleGalleries.length < filteredGalleries.length ? (
        <div className="panel__footer">
          <button type="button" className="panel__action panel__action--ghost" onClick={loadMore}>
            Load {Math.min(GALLERY_BATCH_SIZE, filteredGalleries.length - visibleGalleries.length)} more galleries
          </button>
        </div>
      ) : null}

      {activeGallery ? (
        <div className="gallery-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="gallery-detail-title">
          <div className="gallery-detail-dialog__backdrop" onClick={closeDetail} aria-hidden="true" />
          <div className="gallery-detail-dialog__container">
            <div className="gallery-detail" role="document">
              <header className="gallery-detail__header">
                <div>
                  <span className={`gallery-detail__badge${activeGallery.isPublic ? ' gallery-detail__badge--public' : ''}`}>
                    {activeGallery.isPublic ? 'Public collection' : 'Private collection'}
                  </span>
                  <h3 id="gallery-detail-title">{activeGallery.title}</h3>
                  <p>
                    Curated by{' '}
                    {onOpenProfile && activeGalleryOwner?.id ? (
                      <button
                        type="button"
                        className="curator-link"
                        onClick={() => onOpenProfile(activeGalleryOwner.id)}
                      >
                        {activeGalleryOwner.displayName}
                      </button>
                    ) : (
                      activeGalleryOwner?.displayName ?? 'Unknown curator'
                    )}{' '}
                    · Updated on {formatDate(activeGallery.updatedAt)}
                  </p>
                </div>
                <div className="gallery-detail__actions">
                  {canManageActiveGallery ? (
                    <>
                      <button
                        type="button"
                        className="gallery-detail__edit"
                        onClick={() => setGalleryToEdit(activeGallery)}
                      >
                        Edit collection
                      </button>
                      <button
                        type="button"
                        className="gallery-detail__delete"
                        onClick={handleDeleteGallery}
                        disabled={isDeletingGallery}
                      >
                        {isDeletingGallery ? 'Deleting…' : 'Delete collection'}
                      </button>
                    </>
                  ) : null}
                  <button type="button" className="gallery-detail__close" onClick={closeDetail}>
                    Back to galleries
                  </button>
                </div>
                {detailError ? (
                  <p className="gallery-detail__error" role="alert">
                    {detailError}
                  </p>
                ) : null}
              </header>

              {activeGallery.description ? (
                <p className="gallery-detail__description">{activeGallery.description}</p>
              ) : (
                <p className="gallery-detail__description gallery-detail__description--muted">
                  No gallery description provided yet.
                </p>
              )}

              {activeGalleryModels.length > 0 ? (
                <section className="gallery-detail__models">
                  <h4>Linked LoRAs</h4>
                  <ul>
                    {activeGalleryModels.map((model) => {
                      const isAuditPlaceholder = isAuditPlaceholderForViewer(
                        model.moderationStatus,
                        model.owner.id,
                        currentUser,
                      );

                      if (isAuditPlaceholder) {
                        return (
                          <li key={model.id} className="gallery-detail__model gallery-detail__model--audit">
                            <span>In Audit – {model.title}</span>
                          </li>
                        );
                      }

                      return (
                        <li key={model.id}>
                          {onNavigateToModel ? (
                            <button
                              type="button"
                              className="gallery-detail__model-button"
                              onClick={() => onNavigateToModel(model.id)}
                            >
                              {model.title} · v{model.version}
                            </button>
                          ) : (
                            <span>{model.title} · v{model.version}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              <div className="gallery-detail__grid" role="list">
                {activeGalleryImages.length > 0 ? (
                  activeGalleryImages.map((entry) => {
                    const isAuditPlaceholder = isAuditPlaceholderForViewer(
                      entry.image.moderationStatus,
                      entry.image.owner.id,
                      currentUser,
                    );

                    if (isAuditPlaceholder) {
                      return (
                        <div
                          key={entry.entryId}
                          role="listitem"
                          className="gallery-detail__thumb gallery-detail__thumb--audit"
                        >
                          <div className="gallery-detail__thumb-trigger">
                            <span>In Audit – {entry.image.title}</span>
                          </div>
                        </div>
                      );
                    }

                    const imageUrl =
                      resolveCachedStorageUrl(
                        entry.image.storagePath,
                        entry.image.storageBucket,
                        entry.image.storageObject,
                        { updatedAt: entry.image.updatedAt, cacheKey: entry.image.id },
                      ) ?? entry.image.storagePath;
                    const isFlagged = entry.image.moderationStatus === 'FLAGGED';
                    const shouldObscure = isFlagged && currentUser?.role !== 'ADMIN';
                    const thumbClasses = [
                      'gallery-detail__thumb-trigger',
                      isFlagged ? 'moderation-overlay' : '',
                      isFlagged && !shouldObscure ? 'moderation-overlay--visible' : '',
                      shouldObscure ? 'moderation-overlay--blurred' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <div key={entry.entryId} role="listitem" className="gallery-detail__thumb">
                        <button
                          type="button"
                          className={thumbClasses}
                          onClick={() => setActiveImage(entry)}
                          aria-label={`View ${entry.image.title}`}
                        >
                          <img src={imageUrl} alt={entry.image.title} loading="lazy" />
                          {isFlagged ? <span className="moderation-overlay__label">In audit</span> : null}
                        </button>
                        <div className="gallery-detail__thumb-footer">
                          <button
                            type="button"
                            className={`gallery-like-button gallery-like-button--inline${
                              entry.image.viewerHasLiked ? ' gallery-like-button--active' : ''
                            }`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleToggleLike(entry.image);
                            }}
                            disabled={!canLikeImages || likeMutationId === entry.image.id}
                            aria-pressed={entry.image.viewerHasLiked}
                            aria-label={
                              entry.image.viewerHasLiked
                                ? `Remove like from ${entry.image.title}`
                                : `Like ${entry.image.title}`
                            }
                            title={canLikeImages ? 'Toggle like' : 'Sign in to like images'}
                          >
                            <span aria-hidden="true">♥</span>
                            <span>{entry.image.likeCount}</span>
                          </button>
                          {entry.note ? <span className="gallery-detail__note">{entry.note}</span> : null}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="gallery-detail__empty">This collection does not contain any images yet.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {activeImage ? (
        <div className="gallery-image-modal" role="dialog" aria-modal="true" aria-label={`Enlarge ${activeImage.image.title}`}>
          <div className="gallery-image-modal__backdrop" onClick={() => setActiveImage(null)} aria-hidden="true" />
          <div className="gallery-image-modal__content">
            <header className="gallery-image-modal__header">
              <div>
                <h3>{activeImage.image.title}</h3>
                <p>
                  Curated by{' '}
                  {onOpenProfile && activeGalleryOwner?.id ? (
                    <button
                      type="button"
                      className="curator-link"
                      onClick={() => onOpenProfile(activeGalleryOwner.id)}
                    >
                      {activeGalleryOwner.displayName}
                    </button>
                  ) : (
                    activeGalleryOwner?.displayName ?? 'Unknown curator'
                  )}
                </p>
              </div>
              <div className="gallery-image-modal__actions">
                <button
                  type="button"
                  className={`gallery-like-button${
                    activeImage.image.viewerHasLiked ? ' gallery-like-button--active' : ''
                  }`}
                  onClick={() => {
                    void handleToggleLike(activeImage.image);
                  }}
                  disabled={!canLikeImages || likeMutationId === activeImage.image.id}
                  aria-pressed={activeImage.image.viewerHasLiked}
                  aria-label={
                    activeImage.image.viewerHasLiked
                      ? `Remove like from ${activeImage.image.title}`
                      : `Like ${activeImage.image.title}`
                  }
                  title={canLikeImages ? 'Toggle like' : 'Sign in to like images'}
                >
                  <span aria-hidden="true">♥</span>
                  <span>{activeImage.image.likeCount}</span>
                </button>
                <button
                  type="button"
                  className="gallery-image-modal__comments-link"
                  onClick={() => {
                    setIsImageCommentPanelOpen((previous) => !previous);
                  }}
                  aria-expanded={isImageCommentPanelOpen}
                  aria-controls={imageCommentsAnchorId}
                >
                  <span aria-hidden="true" className="gallery-image-modal__comments-toggle-icon">
                    {isImageCommentPanelOpen ? '▾' : '▸'}
                  </span>
                  <span>{imageCommentToggleLabel}</span>
                </button>
                {canManageActiveImage ? (
                  <>
                    <button
                      type="button"
                      className="gallery-image-modal__edit"
                      onClick={() => setImageToEdit(activeImage.image)}
                    >
                      Edit image
                    </button>
                    <button
                      type="button"
                      className="gallery-image-modal__delete"
                      onClick={() => handleDeleteImage(activeImage)}
                      disabled={imageDeletionId === activeImage.image.id}
                    >
                      {imageDeletionId === activeImage.image.id ? 'Deleting…' : 'Delete image'}
                    </button>
                  </>
                ) : null}
                {authToken && activeImage.image.moderationStatus !== 'FLAGGED' ? (
                  <button
                    type="button"
                    className="gallery-image-modal__flag"
                    onClick={() => {
                      void handleFlagImage(activeImage.image);
                    }}
                    disabled={isFlaggingImage}
                  >
                    {isFlaggingImage ? 'Sending…' : 'Flag image'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="gallery-image-modal__close"
                  onClick={() => setActiveImage(null)}
                  aria-label="Close image view"
                >
                  ×
                </button>
              </div>
              {imageFlagFeedback ? (
                <p
                  className={`gallery-image-modal__flag-feedback gallery-image-modal__flag-feedback--${imageFlagFeedback.type}`}
                  role="status"
                >
                  {imageFlagFeedback.message}
                </p>
              ) : null}
              {imageModalError ? (
                <p className="gallery-image-modal__error" role="alert">
                  {imageModalError}
                </p>
              ) : null}
            </header>
            <div className="gallery-image-modal__body">
              {activeImage.image.moderationStatus === 'FLAGGED' ? (
                <p className="gallery-image-modal__moderation-note" role="status">
                  Flagged for moderation
                  {activeImage.image.flaggedBy ? ` by ${activeImage.image.flaggedBy.displayName}` : ''}. Administrators are
                  reviewing this image.
                </p>
              ) : null}
              <div className={activeImageOverlayClasses}>
                <img src={activeImagePreviewUrl ?? activeImage.image.storagePath} alt={activeImage.image.title} />
                {activeImage.image.moderationStatus === 'FLAGGED' ? (
                  <span className="moderation-overlay__label">In audit</span>
                ) : null}
              </div>
              <div className="gallery-image-modal__meta">
                <div className="gallery-image-modal__meta-scroll">
                  {activeImage.note ? <p className="gallery-image-modal__note">Note: {activeImage.note}</p> : null}
                  <dl>
                    {buildMetadataRows(activeImage.image).map((row) => (
                      <div key={row.label}>
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div
                    className={`gallery-image-modal__comments${
                      isImageCommentPanelOpen ? ' gallery-image-modal__comments--open' : ''
                    }`}
                    aria-hidden={!isImageCommentPanelOpen}
                  >
                    <CommentSection
                      anchorId={imageCommentsAnchorId}
                      title="Comments"
                      comments={imageComments}
                      isLoading={isImageCommentsLoading}
                      isSubmitting={isImageCommentSubmitting}
                      error={imageCommentError}
                      onRetry={activeImageIdValue ? reloadImageComments : undefined}
                      onSubmit={canLikeImages ? handleSubmitImageComment : undefined}
                      onToggleLike={handleToggleImageCommentLike}
                      likeMutationId={imageCommentLikeMutationId}
                      canComment={canLikeImages}
                      canLike={canLikeImages}
                      emptyLabel="No comments yet. Start the discussion."
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {galleryToEdit ? (
        <GalleryEditDialog
          isOpen={Boolean(galleryToEdit)}
          onClose={() => setGalleryToEdit(null)}
          gallery={galleryToEdit}
          token={authToken ?? null}
          onSuccess={(updated) => {
            onGalleryUpdated?.(updated);
            setGalleryToEdit(updated);
          }}
        />
      ) : null}

      {imageToEdit ? (
        <ImageAssetEditDialog
          isOpen={Boolean(imageToEdit)}
          onClose={() => setImageToEdit(null)}
          image={imageToEdit}
          token={authToken ?? null}
          onSuccess={(updated) => {
            onImageUpdated?.(updated);
            setImageToEdit(null);
            setActiveImage((previous) =>
              previous && previous.image.id === updated.id ? { ...previous, image: updated } : previous,
            );
          }}
        />
      ) : null}
    </section>
  );
};
