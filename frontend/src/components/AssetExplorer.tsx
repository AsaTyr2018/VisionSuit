import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import type { Gallery, ModelAsset, ModelVersion, User } from '../types/api';

import { resolveStorageUrl } from '../lib/storage';
import { FilterChip } from './FilterChip';
import { ModelVersionDialog } from './ModelVersionDialog';
import { ModelVersionEditDialog } from './ModelVersionEditDialog';
import { ModelAssetEditDialog } from './ModelAssetEditDialog';

interface AssetExplorerProps {
  assets: ModelAsset[];
  galleries: Gallery[];
  isLoading: boolean;
  onStartUpload?: () => void;
  onNavigateToGallery?: (galleryId: string) => void;
  initialAssetId?: string | null;
  onCloseDetail?: () => void;
  externalSearchQuery?: string | null;
  onExternalSearchApplied?: () => void;
  onAssetUpdated?: (asset: ModelAsset) => void;
  authToken?: string | null;
  currentUser?: User | null;
}

type FileSizeFilter = 'all' | 'small' | 'medium' | 'large' | 'unknown';
type SortOption = 'recent' | 'alpha' | 'size-desc' | 'size-asc';

type OwnerOption = { id: string; label: string };
type TagOption = { id: string; label: string; count: number };

type TypeOption = { id: string; label: string; count: number };

type MetadataRow = { key: string; value: string };
type TagFrequencyGroup = { scope: string; tags: { label: string; count: number }[] };

const ASSET_BATCH_SIZE = 25;

const fileSizeLabels: Record<Exclude<FileSizeFilter, 'all'>, string> = {
  small: '≤ 50 MB',
  medium: '50 – 200 MB',
  large: '≥ 200 MB',
  unknown: 'Unknown',
};

const categorizeFileSize = (value?: number | null): FileSizeFilter => {
  if (value == null) return 'unknown';
  const megabytes = value / 1_000_000;
  if (megabytes < 50) return 'small';
  if (megabytes < 200) return 'medium';
  return 'large';
};

const normalize = (value?: string | null) => value?.toLowerCase().normalize('NFKD') ?? '';

const tryParseStructuredValue = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed === 'true' || trimmed === 'True') {
    return true;
  }

  if (trimmed === 'false' || trimmed === 'False') {
    return false;
  }

  if (trimmed === 'null') {
    return null;
  }

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('Failed to parse metadata value:', error);
        }
    }
  }

  return trimmed;
};

const normalizeMetadataValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    const parsed = tryParseStructuredValue(value);
    if (parsed !== value) {
      return normalizeMetadataValue(parsed);
    }
    return parsed;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeMetadataValue(entry));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
      result[key] = normalizeMetadataValue(entry);
    });
    return result;
  }

  return value;
};

const formatPrimitiveMetadataValue = (value: unknown) => {
  if (value == null || value === '') {
    return '–';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return String(value);
};

const flattenMetadataValue = (
  value: unknown,
  key: string,
  rows: MetadataRow[],
  options: { omit?: (candidateKey: string) => boolean } = {},
) => {
  if (options.omit?.(key)) {
    return;
  }

  if (value == null) {
    if (key) {
      rows.push({ key, value: '–' });
    }
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (key) {
        rows.push({ key, value: '[]' });
      }
      return;
    }

    value.forEach((entry, index) => {
      const nextKey = key ? `${key}[${index}]` : `[${index}]`;
      flattenMetadataValue(entry, nextKey, rows, options);
    });
    return;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      if (key) {
        rows.push({ key, value: '{}' });
      }
      return;
    }

    entries.forEach(([childKey, childValue]) => {
      const nextKey = key ? `${key}.${childKey}` : childKey;
      flattenMetadataValue(childValue, nextKey, rows, options);
    });
    return;
  }

  if (key) {
    rows.push({ key, value: formatPrimitiveMetadataValue(value) });
  }
};

const metadataKeyShouldBeOmitted = (key: string) => {
  if (!key) {
    return false;
  }
  const sanitized = key.replace(/\[\d+\]/g, '');
  return sanitized.split('.').pop() === 'ss_tag_frequency';
};

const buildMetadataRows = (metadata?: Record<string, unknown> | null) => {
  if (!metadata) {
    return [] as MetadataRow[];
  }

  const normalized = normalizeMetadataValue(metadata);
  const rows: MetadataRow[] = [];

  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    Object.entries(normalized as Record<string, unknown>).forEach(([key, value]) => {
      if (key === 'extracted' && value && typeof value === 'object' && !Array.isArray(value)) {
        Object.entries(value as Record<string, unknown>).forEach(([childKey, childValue]) => {
          flattenMetadataValue(childValue, childKey, rows, { omit: metadataKeyShouldBeOmitted });
        });
        return;
      }

      flattenMetadataValue(value, key, rows, { omit: metadataKeyShouldBeOmitted });
    });
    return rows;
  }

  if (Array.isArray(normalized)) {
    normalized.forEach((entry, index) => {
      flattenMetadataValue(entry, `[${index}]`, rows, { omit: metadataKeyShouldBeOmitted });
    });
    return rows;
  }

  rows.push({ key: 'Value', value: formatPrimitiveMetadataValue(normalized) });
  return rows;
};

const collectMetadataStrings = (metadata?: Record<string, unknown> | null) => {
  if (!metadata) {
    return [] as string[];
  }

  const normalized = normalizeMetadataValue(metadata);
  const values = new Set<string>();

  const visit = (value: unknown) => {
    if (value == null) {
      return;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).trim();
      if (text.length > 0) {
        values.add(text);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(visit);
    }
  };

  visit(normalized);

  return Array.from(values);
};

const resolveNestedValue = (source: unknown, path: string): unknown => {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  const record = source as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, path)) {
    return record[path];
  }

  const segments = path.split('.');
  let current: unknown = record;

  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
};

const findFirstMatchingValue = (
  value: unknown,
  predicate: (key: string) => boolean,
): unknown => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = findFirstMatchingValue(entry, predicate);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (predicate(key)) {
      return entry;
    }

    const nested = findFirstMatchingValue(entry, predicate);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
};

const toTagFrequencyGroups = (value: unknown): TagFrequencyGroup[] => {
  if (value == null) {
    return [];
  }

  let working = value;
  if (typeof working === 'string') {
    const trimmed = working.trim();
    if (trimmed) {
      try {
        working = JSON.parse(trimmed) as unknown;
      } catch {
        return [];
      }
    }
  }

  if (!working || typeof working !== 'object') {
    return [];
  }

  const groups: TagFrequencyGroup[] = [];

  Object.entries(working as Record<string, unknown>).forEach(([scope, entry]) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }

    const tags: { label: string; count: number }[] = [];
    Object.entries(entry as Record<string, unknown>).forEach(([label, countValue]) => {
      if (countValue == null) {
        return;
      }

      const numeric =
        typeof countValue === 'number'
          ? countValue
          : Number.parseFloat(String(countValue).replace(/,/g, '.'));

      if (Number.isFinite(numeric)) {
        tags.push({ label, count: Math.trunc(numeric) });
      }
    });

    if (tags.length > 0) {
      tags.sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.label.localeCompare(b.label, 'en');
      });
      groups.push({ scope, tags });
    }
  });

  return groups.sort((a, b) => a.scope.localeCompare(b.scope, 'en'));
};

const extractTagFrequency = (metadata?: Record<string, unknown> | null): TagFrequencyGroup[] => {
  if (!metadata) {
    return [];
  }

  const normalized = normalizeMetadataValue(metadata);
  const candidatePaths = [
    'ss_tag_frequency',
    'extracted.ss_tag_frequency',
    'extracted.ss_metadata.ss_tag_frequency',
    'ss_metadata.ss_tag_frequency',
  ];

  for (const path of candidatePaths) {
    const resolved = resolveNestedValue(normalized, path);
    const groups = toTagFrequencyGroups(resolved);
    if (groups.length > 0) {
      return groups;
    }
  }

  const fallback = findFirstMatchingValue(normalized, (key) => key.endsWith('ss_tag_frequency'));
  return toTagFrequencyGroups(fallback);
};

const matchesSearch = (asset: ModelAsset, query: string) => {
  if (!query) return true;
  const versionValues = asset.versions.flatMap((version) => {
    const metadataValues = collectMetadataStrings(version.metadata as Record<string, unknown> | null);
    return [version.version, version.storageObject ?? version.storagePath, ...metadataValues];
  });
  const haystack = [
    asset.title,
    asset.slug,
    asset.description ?? '',
    asset.trigger ?? '',
    asset.owner.displayName,
    ...asset.tags.map((tag) => tag.label),
    ...versionValues,
  ]
    .map((entry) => normalize(entry))
    .join(' ');

  return haystack.includes(query);
};

const findModelType = (asset: ModelAsset) => asset.tags.find((tag) => tag.category === 'model-type');

const formatFileSize = (bytes?: number | null) => {
  if (!bytes || Number.isNaN(bytes)) {
    return '–';
  }
  if (bytes < 1_000_000) {
    return `${Math.round(bytes / 1_000)} KB`;
  }
  if (bytes < 1_000_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
};

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const formatVersionChipLabel = (entry: ModelVersion, index: number) => {
  const trimmed = entry.version?.trim() ?? '';
  const baseLabel = trimmed.length > 0 ? trimmed : `Version ${index + 1}`;
  return entry.isPrimary ? `${baseLabel} · Primary` : baseLabel;
};

const describeVersionChip = (entry: ModelVersion, index: number) => {
  const label = formatVersionChipLabel(entry, index);
  try {
    return `${label} – ${formatDate(entry.createdAt)}`;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to format version date', error);
    }
    return label;
  }
};

export const AssetExplorer = ({
  assets,
  galleries,
  isLoading,
  onStartUpload,
  onNavigateToGallery,
  initialAssetId,
  onCloseDetail,
  externalSearchQuery,
  onExternalSearchApplied,
  onAssetUpdated,
  authToken,
  currentUser,
}: AssetExplorerProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedOwner, setSelectedOwner] = useState<string>('all');
  const [fileSizeFilter, setFileSizeFilter] = useState<FileSizeFilter>('all');
  const [sortOption, setSortOption] = useState<SortOption>('recent');
  const [visibleLimit, setVisibleLimit] = useState(ASSET_BATCH_SIZE);
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [isTagDialogOpen, setTagDialogOpen] = useState(false);
  const [isVersionDialogOpen, setVersionDialogOpen] = useState(false);
  const [isEditDialogOpen, setEditDialogOpen] = useState(false);
  const [versionToEdit, setVersionToEdit] = useState<ModelVersion | null>(null);
  const [versionFeedback, setVersionFeedback] = useState<string | null>(null);
  const [triggerCopyStatus, setTriggerCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const deferredSearch = useDeferredValue(searchTerm);
  const normalizedQuery = normalize(deferredSearch.trim());

  const activeAsset = useMemo(
    () => (activeAssetId ? assets.find((asset) => asset.id === activeAssetId) ?? null : null),
    [activeAssetId, assets],
  );

  const canManageActiveAsset = useMemo(
    () =>
      Boolean(
        authToken &&
          activeAsset &&
          currentUser &&
          (currentUser.role === 'ADMIN' || currentUser.id === activeAsset.owner.id),
      ),
    [activeAsset, authToken, currentUser],
  );

  useEffect(() => {
    if (!externalSearchQuery) {
      return;
    }

    setSearchTerm(externalSearchQuery);
    setSelectedTags([]);
    onExternalSearchApplied?.();
  }, [externalSearchQuery, onExternalSearchApplied]);

  useEffect(() => {
    setTriggerCopyStatus('idle');
  }, [activeAssetId, activeVersionId]);

  useEffect(() => {
    if (!activeAsset) {
      setEditDialogOpen(false);
    }
  }, [activeAsset]);

  useEffect(() => {
    if (triggerCopyStatus === 'idle') {
      return;
    }

    if (typeof window === 'undefined') {
      return;
    }

    const timer = window.setTimeout(() => setTriggerCopyStatus('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [triggerCopyStatus]);

  useEffect(() => {
    if (!activeAsset) {
      setVersionToEdit(null);
      return;
    }

    if (versionToEdit && !activeAsset.versions.some((entry) => entry.id === versionToEdit.id)) {
      setVersionToEdit(null);
    }
  }, [activeAsset, versionToEdit]);

  const handleCopyTrigger = useCallback(async (value: string) => {
    const text = value.trim();
    if (!text) {
      return;
    }

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!successful) {
          throw new Error('Copy command was rejected');
        }
      } else {
        throw new Error('Clipboard API unavailable');
      }

      setTriggerCopyStatus('copied');
    } catch (error) {
      console.warn('Failed to copy trigger value', error);
      setTriggerCopyStatus('error');
    }
  }, []);

  const { ownerOptions, tagOptions, typeOptions } = useMemo(() => {
    const ownersMap = new Map<string, OwnerOption>();
    const tagsMap = new Map<string, TagOption>();
    const typesMap = new Map<string, TypeOption>();

    assets.forEach((asset) => {
      if (!ownersMap.has(asset.owner.id)) {
        ownersMap.set(asset.owner.id, { id: asset.owner.id, label: asset.owner.displayName });
      }

      asset.tags.forEach((tag) => {
        const map = tag.category === 'model-type' ? typesMap : tagsMap;
        const existing = map.get(tag.id);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(tag.id, { id: tag.id, label: tag.label, count: 1 });
        }
      });
    });

    const sortByCount = (first: TagOption, second: TagOption) => second.count - first.count;

    return {
      ownerOptions: Array.from(ownersMap.values()).sort((a, b) => a.label.localeCompare(b.label, 'en')),
      tagOptions: Array.from(tagsMap.values()).sort(sortByCount).slice(0, 18),
      typeOptions: Array.from(typesMap.values()).sort(sortByCount),
    };
  }, [assets]);

  const filteredAssets = useMemo(() => {
    const selectedTagIds = new Set(selectedTags);

    const filtered = assets.filter((asset) => {
      if (!matchesSearch(asset, normalizedQuery)) return false;

      if (selectedType !== 'all') {
        const typeTag = findModelType(asset);
        if (!typeTag || typeTag.id !== selectedType) return false;
      }

      if (selectedOwner !== 'all' && asset.owner.id !== selectedOwner) return false;

      if (fileSizeFilter !== 'all' && categorizeFileSize(asset.fileSize) !== fileSizeFilter) return false;

      if (selectedTagIds.size > 0) {
        const assetTagIds = asset.tags
          .filter((tag) => tag.category !== 'model-type')
          .map((tag) => tag.id);
        for (const tagId of selectedTagIds) {
          if (!assetTagIds.includes(tagId)) return false;
        }
      }

      return true;
    });

    const sorters: Record<SortOption, (a: ModelAsset, b: ModelAsset) => number> = {
      recent: (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      alpha: (a, b) => a.title.localeCompare(b.title, 'en'),
      'size-desc': (a, b) => (b.fileSize ?? 0) - (a.fileSize ?? 0),
      'size-asc': (a, b) => (a.fileSize ?? Infinity) - (b.fileSize ?? Infinity),
    };

    return filtered.sort(sorters[sortOption]);
  }, [assets, normalizedQuery, selectedOwner, selectedType, fileSizeFilter, selectedTags, sortOption]);

  useEffect(() => {
    setVisibleLimit(ASSET_BATCH_SIZE);
  }, [normalizedQuery, selectedOwner, selectedType, fileSizeFilter, selectedTags, sortOption]);

  useEffect(() => {
    if (initialAssetId) {
      setActiveAssetId(initialAssetId);
      const presetAsset = assets.find((asset) => asset.id === initialAssetId);
      if (presetAsset) {
        setActiveVersionId(presetAsset.latestVersionId ?? presetAsset.versions[0]?.id ?? null);
      }
    }
  }, [assets, initialAssetId]);

  const closeTagDialog = useCallback(() => setTagDialogOpen(false), []);
  const openTagDialog = useCallback(() => setTagDialogOpen(true), []);
  const openVersionDialog = useCallback(() => {
    if (!authToken) {
      return;
    }
    setVersionDialogOpen(true);
  }, [authToken]);
  const closeVersionDialog = useCallback(() => setVersionDialogOpen(false), []);
  const closeVersionEditDialog = useCallback(() => setVersionToEdit(null), []);

  const closeDetail = useCallback(() => {
    closeTagDialog();
    setActiveAssetId(null);
    setActiveVersionId(null);
    setVersionDialogOpen(false);
    setVersionToEdit(null);
    setVersionFeedback(null);
    onCloseDetail?.();
  }, [closeTagDialog, onCloseDetail]);

  useEffect(() => {
    if (activeAssetId && !assets.some((asset) => asset.id === activeAssetId)) {
      closeDetail();
    }
  }, [activeAssetId, assets, closeDetail]);

  const visibleAssets = useMemo(() => filteredAssets.slice(0, visibleLimit), [filteredAssets, visibleLimit]);

  const canLoadMore = visibleAssets.length < filteredAssets.length;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !canLoadMore) {
      return undefined;
    }

    let isLoadingMore = false;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !isLoadingMore) {
            isLoadingMore = true;
            setVisibleLimit((current) => Math.min(filteredAssets.length, current + ASSET_BATCH_SIZE));
            window.setTimeout(() => {
              isLoadingMore = false;
            }, 150);
          }
        });
      },
      { rootMargin: '240px 0px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore, filteredAssets.length]);


  useEffect(() => {
    if (!activeAsset) {
      setActiveVersionId(null);
      setVersionDialogOpen(false);
      setVersionFeedback(null);
      return;
    }

    setActiveVersionId((previous) => {
      if (previous && activeAsset.versions.some((version) => version.id === previous)) {
        return previous;
      }
      return activeAsset.latestVersionId ?? activeAsset.versions[0]?.id ?? null;
    });
    setVersionFeedback(null);
  }, [activeAsset]);

  useEffect(() => {
    if (!versionFeedback) {
      return undefined;
    }

    const timer = window.setTimeout(() => setVersionFeedback(null), 4800);
    return () => window.clearTimeout(timer);
  }, [versionFeedback]);

  const activeVersion = useMemo(() => {
    if (!activeAsset) {
      return null;
    }

    const fallbackId = activeAsset.latestVersionId ?? activeAsset.versions[0]?.id ?? null;
    const targetId = activeVersionId ?? fallbackId;
    if (!targetId) {
      return activeAsset.versions[0] ?? null;
    }

    return activeAsset.versions.find((version) => version.id === targetId) ?? activeAsset.versions[0] ?? null;
  }, [activeAsset, activeVersionId]);

  const tagsHeadingId = `asset-detail-tags-${activeAssetId ?? 'unknown'}`;
  const metadataHeadingId = `asset-detail-metadata-${activeAssetId ?? 'unknown'}`;

  const handleNavigateFromDetail = useCallback(
    (galleryId: string) => {
      closeDetail();
      onNavigateToGallery?.(galleryId);
    },
    [closeDetail, onNavigateToGallery],
  );

  useEffect(() => {
    if (!activeAssetId) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isTagDialogOpen) {
          return;
        }
        event.preventDefault();
        closeDetail();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeAssetId, closeDetail, isTagDialogOpen]);

  const relatedGalleries = useMemo(() => {
    if (!activeAsset) {
      return [] as { id: string; title: string; slug: string }[];
    }

    const matches = new Map<string, { id: string; title: string; slug: string }>();
    galleries.forEach((gallery) => {
      const hasModel = gallery.entries.some((entry) => entry.modelAsset?.id === activeAsset.id);
      if (hasModel) {
        matches.set(gallery.id, { id: gallery.id, title: gallery.title, slug: gallery.slug });
      }
    });
    return Array.from(matches.values());
  }, [activeAsset, galleries]);

  const metadataEntries = useMemo(
    () => buildMetadataRows(activeVersion?.metadata as Record<string, unknown> | null),
    [activeVersion?.metadata],
  );

  const tagFrequencyGroups = useMemo(
    () => extractTagFrequency(activeVersion?.metadata as Record<string, unknown> | null),
    [activeVersion?.metadata],
  );

  const modelDownloadUrl = useMemo(() => {
    if (!activeVersion) {
      return null;
    }

    return (
      resolveStorageUrl(activeVersion.storagePath, activeVersion.storageBucket, activeVersion.storageObject) ??
      activeVersion.storagePath
    );
  }, [activeVersion]);

  useEffect(() => {
    if (!isTagDialogOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTagDialog();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeTagDialog, isTagDialogOpen]);

  useEffect(() => {
    if (!activeAsset) {
      closeTagDialog();
    }
  }, [activeAsset, closeTagDialog]);

  useEffect(() => {
    if (tagFrequencyGroups.length === 0) {
      closeTagDialog();
    }
  }, [closeTagDialog, tagFrequencyGroups.length]);

  const activeFilters = useMemo(() => {
    const filters: { id: string; label: string; onClear: () => void }[] = [];

    if (normalizedQuery) {
      filters.push({ id: 'search', label: `Search: “${deferredSearch.trim()}”`, onClear: () => setSearchTerm('') });
    }

    if (selectedOwner !== 'all') {
      const owner = ownerOptions.find((option) => option.id === selectedOwner);
      if (owner) {
        filters.push({ id: `owner-${owner.id}`, label: `Curator · ${owner.label}`, onClear: () => setSelectedOwner('all') });
      }
    }

    if (selectedType !== 'all') {
      const type = typeOptions.find((option) => option.id === selectedType);
      if (type) {
        filters.push({ id: `type-${type.id}`, label: `Type · ${type.label}`, onClear: () => setSelectedType('all') });
      }
    }

    if (fileSizeFilter !== 'all') {
      filters.push({
        id: `size-${fileSizeFilter}`,
        label: `Size · ${fileSizeLabels[fileSizeFilter]}`,
        onClear: () => setFileSizeFilter('all'),
      });
    }

    selectedTags.forEach((tagId) => {
      const tag = tagOptions.find((option) => option.id === tagId);
      if (tag) {
        filters.push({
          id: `tag-${tag.id}`,
          label: `Tag · ${tag.label}`,
          onClear: () => setSelectedTags((prev) => prev.filter((value) => value !== tagId)),
        });
      }
    });

    return filters;
  }, [deferredSearch, fileSizeFilter, normalizedQuery, ownerOptions, selectedOwner, selectedTags, tagOptions, typeOptions, selectedType]);

  const resetFilters = () => {
    setSelectedOwner('all');
    setSelectedType('all');
    setSelectedTags([]);
    setFileSizeFilter('all');
    setSortOption('recent');
    setSearchTerm('');
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h2 className="panel__title">LoRA library</h2>
          <p className="panel__subtitle">
            Production-grade LoRA library with full-text search, tagging, and curator filters. Every entry mirrors the current analysis status and can be sorted across large collections without performance loss.
          </p>
        </div>
        <button type="button" className="panel__action panel__action--primary" onClick={() => onStartUpload?.()}>
          Open LoRA upload
        </button>
      </header>

      <div className="filter-toolbar" aria-label="Filters for the LoRA library">
        <div className="filter-toolbar__row">
          <label className="filter-toolbar__search">
            <span className="sr-only">Search in LoRA assets</span>
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search titles, tags, or people"
              disabled={isLoading && assets.length === 0}
            />
          </label>

          <label className="filter-toolbar__control">
            <span>Sort order</span>
            <select
              value={sortOption}
              onChange={(event) => setSortOption(event.target.value as SortOption)}
              className="filter-select"
            >
              <option value="recent">Updated · Newest first</option>
              <option value="alpha">Title · A → Z</option>
              <option value="size-desc">File size · Large → Small</option>
              <option value="size-asc">File size · Small → Large</option>
            </select>
          </label>

          <label className="filter-toolbar__control">
            <span>Curator</span>
            <select
              value={selectedOwner}
              onChange={(event) => setSelectedOwner(event.target.value)}
              className="filter-select"
            >
              <option value="all">All people</option>
              {ownerOptions.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.label}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-toolbar__control">
            <span>Model type</span>
            <select
              value={selectedType}
              onChange={(event) => setSelectedType(event.target.value)}
              className="filter-select"
            >
              <option value="all">All types</option>
              {typeOptions.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>

          <div className="filter-toolbar__chips" role="group" aria-label="Filter by file size">
            <FilterChip
              label="All sizes"
              isActive={fileSizeFilter === 'all'}
              onClick={() => setFileSizeFilter('all')}
            />
            {(Object.keys(fileSizeLabels) as Exclude<FileSizeFilter, 'all'>[]).map((key) => (
              <FilterChip
                key={key}
                label={fileSizeLabels[key]}
                isActive={fileSizeFilter === key}
                onClick={() => setFileSizeFilter(key)}
              />
            ))}
          </div>
        </div>

        {tagOptions.length > 0 ? (
          <div className="filter-toolbar__tag-row" role="group" aria-label="Filter by tags">
            <span className="filter-toolbar__tag-label">Popular tags</span>
            <div className="filter-toolbar__tag-chips">
              {tagOptions.map((tag) => (
                <FilterChip
                  key={tag.id}
                  label={tag.label}
                  count={tag.count}
                  isActive={selectedTags.includes(tag.id)}
                  onClick={() =>
                    setSelectedTags((previous) =>
                      previous.includes(tag.id)
                        ? previous.filter((value) => value !== tag.id)
                        : [...previous, tag.id],
                    )
                  }
                />
              ))}
            </div>
          </div>
        ) : null}

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
        {isLoading && assets.length === 0 ? 'Loading LoRA assets…' : `Showing ${visibleAssets.length} of ${filteredAssets.length} assets`}
      </div>

      <div className="asset-explorer__grid" role="list" aria-label="LoRA assets">
        {isLoading && assets.length === 0
          ? Array.from({ length: 10 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
          : visibleAssets.map((asset) => {
              const previewUrl =
                resolveStorageUrl(asset.previewImage, asset.previewImageBucket, asset.previewImageObject) ??
                asset.previewImage ?? undefined;
              const modelType = asset.tags.find((tag) => tag.category === 'model-type')?.label ?? 'LoRA';
              const isActive = activeAssetId === asset.id;
              return (
                <button
                  key={asset.id}
                  type="button"
                  role="listitem"
                  className={`asset-tile${isActive ? ' asset-tile--active' : ''}`}
                  onClick={() => {
                    setActiveAssetId(asset.id);
                    setActiveVersionId(asset.latestVersionId ?? asset.versions[0]?.id ?? null);
                  }}
                >
                  <div className={`asset-tile__preview${previewUrl ? '' : ' asset-tile__preview--empty'}`}>
                    {previewUrl ? (
                      <img src={previewUrl} alt={`Preview of ${asset.title}`} loading="lazy" />
                    ) : (
                      <span>No preview</span>
                    )}
                  </div>
                  <div className="asset-tile__body">
                    <div className="asset-tile__headline">
                      <h3>{asset.title}</h3>
                      <span>{modelType}</span>
                    </div>
                    <p>Version {asset.version}</p>
                    <p className="asset-tile__owner">{asset.owner.displayName}</p>
                  </div>
                </button>
              );
            })}
      </div>

      {activeAsset ? (
        <div className="asset-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-detail-title">
          <div className="asset-detail-dialog__backdrop" onClick={closeDetail} aria-hidden="true" />
          <div className="asset-detail-dialog__container">
            <div className="asset-detail" role="document">
              <header className="asset-detail__header">
                <div>
                  <span className="asset-detail__eyebrow">Modelcard</span>
                  <h3 id="asset-detail-title">{activeAsset.title}</h3>
                  {activeAsset.description ? (
                    <p className="asset-detail__subtitle">{activeAsset.description}</p>
                  ) : (
                    <p className="asset-detail__subtitle asset-detail__subtitle--muted">
                      No description provided yet.
                    </p>
                  )}
                  <div className="asset-detail__version-switcher" role="group" aria-label="Model versions">
                    {activeAsset.versions.map((version, index) => {
                      const isCurrent = activeVersion?.id === version.id;
                      const chipLabel = formatVersionChipLabel(version, index);
                      const chipTitle = describeVersionChip(version, index);
                      return (
                        <div key={version.id} className="asset-detail__version-chip-wrapper">
                          <button
                            type="button"
                            className={`asset-detail__version-chip${isCurrent ? ' asset-detail__version-chip--active' : ''}`}
                            onClick={() => setActiveVersionId(version.id)}
                            aria-pressed={isCurrent}
                            title={chipTitle}
                          >
                            {chipLabel}
                          </button>
                          {canManageActiveAsset ? (
                            <button
                              type="button"
                              className="asset-detail__version-edit"
                              onClick={() => {
                                setVersionToEdit(version);
                                setVersionFeedback(null);
                              }}
                              title={`Edit ${chipLabel}`}
                            >
                              Edit
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="asset-detail__version-add"
                      onClick={openVersionDialog}
                      disabled={!canManageActiveAsset}
                      title={
                        !authToken
                          ? 'Only signed-in curators can upload new versions.'
                          : !canManageActiveAsset
                            ? 'Only the model curator or an admin can upload new versions.'
                            : undefined
                      }
                    >
                      Add new version
                    </button>
                  </div>
                  {versionFeedback ? (
                    <p className="asset-detail__version-feedback" role="status">{versionFeedback}</p>
                  ) : null}
                </div>
                <div className="asset-detail__actions">
                  {canManageActiveAsset ? (
                    <button
                      type="button"
                      className="asset-detail__edit"
                      onClick={() => setEditDialogOpen(true)}
                    >
                      Edit model
                    </button>
                  ) : null}
                  <button type="button" className="asset-detail__close" onClick={closeDetail}>
                    Back to model list
                  </button>
                </div>
              </header>


              <div className="asset-detail__layout">
                <div className="asset-detail__main">
                  <div className="asset-detail__summary">
                    <div className="asset-detail__info">
                      <table className="asset-detail__info-table">
                        <tbody>
                          <tr>
                            <th scope="row">Name</th>
                            <td>{activeAsset.title}</td>
                          </tr>
                          <tr>
                            <th scope="row">Version</th>
                            <td>{activeVersion?.version ?? '–'}</td>
                          </tr>
                          <tr>
                            <th scope="row">Trigger / Activator</th>
                            <td>
                              {activeAsset.trigger ? (
                                <div className="asset-detail__copy-field">
                                  <span className="asset-detail__copy-value">{activeAsset.trigger}</span>
                                  <button
                                    type="button"
                                    className={`asset-detail__copy-button${
                                      triggerCopyStatus === 'copied' ? ' asset-detail__copy-button--success' : ''
                                    }${triggerCopyStatus === 'error' ? ' asset-detail__copy-button--error' : ''}`}
                                    onClick={() => handleCopyTrigger(activeAsset.trigger ?? '')}
                                  >
                                    {triggerCopyStatus === 'copied'
                                      ? 'Copied!'
                                      : triggerCopyStatus === 'error'
                                        ? 'Copy failed'
                                        : 'Click to copy'}
                                  </button>
                                </div>
                              ) : (
                                <span className="asset-detail__copy-placeholder">Not provided</span>
                              )}
                            </td>
                          </tr>
                          <tr>
                            <th scope="row">Curator</th>
                            <td>{activeAsset.owner.displayName}</td>
                          </tr>
                          <tr>
                            <th scope="row">Uploaded on</th>
                            <td>{activeVersion ? formatDate(activeVersion.createdAt) : '–'}</td>
                          </tr>
                          <tr>
                            <th scope="row">File size</th>
                            <td>{formatFileSize(activeVersion?.fileSize)}</td>
                          </tr>
                          <tr>
                            <th scope="row">Checksum</th>
                            <td>{activeVersion?.checksum ?? '–'}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <div className="asset-detail__preview-card">
                      {activeVersion?.previewImage ? (
                        <div className="asset-detail__preview">
                          <img
                            src={
                              resolveStorageUrl(
                                activeVersion.previewImage,
                                activeVersion.previewImageBucket,
                                activeVersion.previewImageObject,
                              ) ?? activeVersion.previewImage
                            }
                            alt={`Preview von ${activeAsset.title} – Version ${activeVersion?.version ?? ''}`}
                          />
                        </div>
                      ) : (
                        <div className="asset-detail__preview asset-detail__preview--empty">
                          <span>No preview available.</span>
                        </div>
                      )}
                      <div className="asset-detail__preview-actions">
                        {modelDownloadUrl ? (
                          <a
                            className="asset-detail__download asset-detail__action"
                            href={modelDownloadUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            download
                          >
                            Download model
                          </a>
                        ) : (
                          <span className="asset-detail__download asset-detail__download--disabled asset-detail__action">
                            Download not available
                          </span>
                        )}
                        {relatedGalleries.length > 0 ? (
                          relatedGalleries.map((gallery) => {
                            const label = 'Open Collection';
                            const ariaLabel = `Open collection: ${gallery.title}`;

                            if (onNavigateToGallery) {
                              return (
                                <button
                                  key={gallery.id}
                                  type="button"
                                  onClick={() => handleNavigateFromDetail(gallery.id)}
                                  className="asset-detail__gallery-link asset-detail__action"
                                  aria-label={ariaLabel}
                                >
                                  {label}
                                </button>
                              );
                            }

                            return (
                              <span
                                key={gallery.id}
                                className="asset-detail__gallery-link asset-detail__gallery-link--disabled asset-detail__action"
                                aria-label={ariaLabel}
                              >
                                {label}
                              </span>
                            );
                          })
                        ) : (
                          <span className="asset-detail__gallery-link asset-detail__gallery-link--disabled asset-detail__action">
                            No linked image collections
                          </span>
                        )}
                      </div>
                    </div>

                    <section
                      className="asset-detail__section asset-detail__section--metadata asset-detail__metadata-card"
                      aria-labelledby={metadataHeadingId}
                    >
                      <div className="asset-detail__section-heading">
                        <h4 id={metadataHeadingId}>Metadata</h4>
                        {tagFrequencyGroups.length > 0 ? (
                          <button type="button" className="asset-detail__tag-button" onClick={openTagDialog}>
                            Show dataset tags
                          </button>
                        ) : null}
                      </div>
                      {metadataEntries.length > 0 ? (
                        <div className="asset-detail__metadata">
                          <div className="asset-detail__metadata-scroll">
                            <table className="asset-detail__metadata-table">
                              <thead>
                                <tr>
                                  <th scope="col">Key</th>
                                  <th scope="col">Value</th>
                                </tr>
                              </thead>
                              <tbody>
                                {metadataEntries.map((row) => (
                                  <tr key={row.key}>
                                    <th scope="row">{row.key}</th>
                                    <td>
                                      <span className="asset-detail__metadata-value">{row.value}</span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : (
                        <p className="asset-detail__description asset-detail__description--muted">No metadata available.</p>
                      )}
                    </section>
                  </div>

                  <section className="asset-detail__section asset-detail__section--tags" aria-labelledby={tagsHeadingId}>
                    <h4 id={tagsHeadingId}>Tags</h4>
                    {activeAsset.tags.length > 0 ? (
                      <div className="asset-detail__tags">
                        {activeAsset.tags.map((tag) => (
                          <span key={tag.id}>{tag.label}</span>
                        ))}
                      </div>
                    ) : (
                      <p className="asset-detail__description asset-detail__description--muted">No tags available.</p>
                    )}
                  </section>
                </div>

              </div>

            </div>
            {isTagDialogOpen && tagFrequencyGroups.length > 0 ? (
              <div className="tag-frequency-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-frequency-title">
                <div className="tag-frequency-dialog__backdrop" onClick={closeTagDialog} aria-hidden="true" />
                <div className="tag-frequency-dialog__container" role="presentation">
                  <div className="tag-frequency">
                    <header className="tag-frequency__header">
                      <div>
                        <h4 id="tag-frequency-title">Dataset tags</h4>
                        <p>Frequency of training tags the model saw during fine-tuning.</p>
                      </div>
                      <button type="button" className="tag-frequency__close" onClick={closeTagDialog}>
                        Close
                      </button>
                    </header>
                    <div className="tag-frequency__body">
                      {tagFrequencyGroups.map((group) => {
                        const groupId = `tag-frequency-${
                          group.scope.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'group'
                        }`;
                        return (
                          <section key={group.scope} className="tag-frequency__group" aria-labelledby={groupId}>
                            <header className="tag-frequency__group-header">
                              <h5 id={groupId}>{group.scope}</h5>
                            </header>
                            <div className="tag-frequency__table-wrapper">
                              <table className="tag-frequency__table">
                                <thead>
                                  <tr>
                                    <th scope="col">Tag</th>
                                    <th scope="col">Occurrences</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {group.tags.map((tag) => (
                                    <tr key={tag.label}>
                                      <th scope="row">{tag.label}</th>
                                      <td>{tag.count}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeAsset ? (
        <ModelVersionDialog
          isOpen={isVersionDialogOpen}
          onClose={closeVersionDialog}
          model={activeAsset}
          token={authToken ?? null}
          onSuccess={(updatedAsset, createdVersion) => {
            onAssetUpdated?.(updatedAsset);
            setActiveVersionId(
              createdVersion?.id ?? updatedAsset.latestVersionId ?? updatedAsset.versions[0]?.id ?? null,
            );
            setVersionFeedback(
              createdVersion
                ? `Version ${createdVersion.version} was added.`
                : 'Model updated.',
            );
          }}
        />
      ) : null}

      {activeAsset ? (
        <ModelVersionEditDialog
          isOpen={Boolean(versionToEdit)}
          onClose={closeVersionEditDialog}
          model={activeAsset}
          version={versionToEdit}
          token={authToken ?? null}
          onSuccess={(updatedAsset, refreshedVersion) => {
            onAssetUpdated?.(updatedAsset);
            if (refreshedVersion) {
              setActiveVersionId((current) => current ?? refreshedVersion.id);
              const trimmedLabel = refreshedVersion.version.trim();
              const feedbackLabel = trimmedLabel.length > 0 ? trimmedLabel : 'the selected version';
              setVersionFeedback(
                refreshedVersion.isPrimary
                  ? `Primary version label updated to ${feedbackLabel}.`
                  : `Version label updated to ${feedbackLabel}.`,
              );
            } else {
              setVersionFeedback('Model updated.');
            }
          }}
        />
      ) : null}

      {activeAsset ? (
        <ModelAssetEditDialog
          isOpen={isEditDialogOpen}
          onClose={() => setEditDialogOpen(false)}
          model={activeAsset}
          token={authToken ?? null}
          onSuccess={(updated) => {
            onAssetUpdated?.(updated);
            setVersionFeedback('Model details updated.');
          }}
        />
      ) : null}

      {!isLoading && filteredAssets.length === 0 ? (
        <p className="panel__empty">No assets match the current filters.</p>
      ) : null}

      <div ref={sentinelRef} className="asset-explorer__sentinel" aria-hidden="true" />
    </section>
  );
};
