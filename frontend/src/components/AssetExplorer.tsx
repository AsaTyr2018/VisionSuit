import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import type { Gallery, ModelAsset } from '../types/api';

import { resolveStorageUrl } from '../lib/storage';
import { FilterChip } from './FilterChip';

interface AssetExplorerProps {
  assets: ModelAsset[];
  galleries: Gallery[];
  isLoading: boolean;
  onStartUpload?: () => void;
  onNavigateToGallery?: (galleryId: string) => void;
  initialAssetId?: string | null;
  onCloseDetail?: () => void;
}

type FileSizeFilter = 'all' | 'small' | 'medium' | 'large' | 'unknown';
type SortOption = 'recent' | 'alpha' | 'size-desc' | 'size-asc';

type OwnerOption = { id: string; label: string };
type TagOption = { id: string; label: string; count: number };

type TypeOption = { id: string; label: string; count: number };

const ASSET_BATCH_SIZE = 25;

const fileSizeLabels: Record<Exclude<FileSizeFilter, 'all'>, string> = {
  small: '≤ 50 MB',
  medium: '50 – 200 MB',
  large: '≥ 200 MB',
  unknown: 'Unbekannt',
};

const categorizeFileSize = (value?: number | null): FileSizeFilter => {
  if (value == null) return 'unknown';
  const megabytes = value / 1_000_000;
  if (megabytes < 50) return 'small';
  if (megabytes < 200) return 'medium';
  return 'large';
};

const normalize = (value?: string | null) => value?.toLowerCase().normalize('NFKD') ?? '';

const collectMetadataStrings = (metadata?: Record<string, unknown> | null) => {
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

const matchesSearch = (asset: ModelAsset, query: string) => {
  if (!query) return true;
  const metadataValues = collectMetadataStrings(asset.metadata);
  const haystack = [
    asset.title,
    asset.slug,
    asset.description ?? '',
    asset.owner.displayName,
    asset.version,
    asset.storageObject ?? asset.storagePath,
    ...asset.tags.map((tag) => tag.label),
    ...metadataValues,
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
  new Date(value).toLocaleDateString('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export const AssetExplorer = ({
  assets,
  galleries,
  isLoading,
  onStartUpload,
  onNavigateToGallery,
  initialAssetId,
  onCloseDetail,
}: AssetExplorerProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedOwner, setSelectedOwner] = useState<string>('all');
  const [fileSizeFilter, setFileSizeFilter] = useState<FileSizeFilter>('all');
  const [sortOption, setSortOption] = useState<SortOption>('recent');
  const [visibleLimit, setVisibleLimit] = useState(ASSET_BATCH_SIZE);
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const deferredSearch = useDeferredValue(searchTerm);
  const normalizedQuery = normalize(deferredSearch.trim());

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
      ownerOptions: Array.from(ownersMap.values()).sort((a, b) => a.label.localeCompare(b.label, 'de')),
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
      alpha: (a, b) => a.title.localeCompare(b.title, 'de'),
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
    }
  }, [initialAssetId]);

  const closeDetail = useCallback(() => {
    setActiveAssetId(null);
    onCloseDetail?.();
  }, [onCloseDetail]);

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

  const activeAsset = useMemo(
    () => (activeAssetId ? assets.find((asset) => asset.id === activeAssetId) ?? null : null),
    [activeAssetId, assets],
  );

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
        event.preventDefault();
        closeDetail();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeAssetId, closeDetail]);

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

  const metadataEntries = useMemo(() => {
    if (!activeAsset?.metadata) {
      return [] as { key: string; value: string }[];
    }

    const rows: { key: string; value: string }[] = [];
    Object.entries(activeAsset.metadata).forEach(([key, value]) => {
      if (value == null) return;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        rows.push({ key, value: String(value) });
      } else if (Array.isArray(value)) {
        const filtered = value.filter((entry) => entry != null).map((entry) => String(entry));
        if (filtered.length > 0) {
          rows.push({ key, value: filtered.join(', ') });
        }
      } else if (typeof value === 'object') {
        rows.push({ key, value: JSON.stringify(value, null, 2) });
      }
    });
    return rows;
  }, [activeAsset?.metadata]);

  const activeFilters = useMemo(() => {
    const filters: { id: string; label: string; onClear: () => void }[] = [];

    if (normalizedQuery) {
      filters.push({ id: 'search', label: `Suche: “${deferredSearch.trim()}”`, onClear: () => setSearchTerm('') });
    }

    if (selectedOwner !== 'all') {
      const owner = ownerOptions.find((option) => option.id === selectedOwner);
      if (owner) {
        filters.push({ id: `owner-${owner.id}`, label: `Kurator:in · ${owner.label}`, onClear: () => setSelectedOwner('all') });
      }
    }

    if (selectedType !== 'all') {
      const type = typeOptions.find((option) => option.id === selectedType);
      if (type) {
        filters.push({ id: `type-${type.id}`, label: `Typ · ${type.label}`, onClear: () => setSelectedType('all') });
      }
    }

    if (fileSizeFilter !== 'all') {
      filters.push({
        id: `size-${fileSizeFilter}`,
        label: `Größe · ${fileSizeLabels[fileSizeFilter]}`,
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
          <h2 className="panel__title">LoRA-Datenbank</h2>
          <p className="panel__subtitle">
            Produktionsreife LoRA-Bibliothek mit Volltext, Tagging und Kurator:innen-Filtern. Alle Einträge spiegeln den
            aktuellen Analyse-Status und lassen sich ohne Performanceeinbruch über große Bestände hinweg sortieren.
          </p>
        </div>
        <button type="button" className="panel__action panel__action--primary" onClick={() => onStartUpload?.()}>
          LoRA-Upload öffnen
        </button>
      </header>

      <div className="filter-toolbar" aria-label="Filter für LoRA-Datenbank">
        <div className="filter-toolbar__row">
          <label className="filter-toolbar__search">
            <span className="sr-only">Suche in LoRA-Assets</span>
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Titel, Tags oder Personen durchsuchen"
              disabled={isLoading && assets.length === 0}
            />
          </label>

          <label className="filter-toolbar__control">
            <span>Sortierung</span>
            <select
              value={sortOption}
              onChange={(event) => setSortOption(event.target.value as SortOption)}
              className="filter-select"
            >
              <option value="recent">Aktualisiert · Neueste zuerst</option>
              <option value="alpha">Titel · A → Z</option>
              <option value="size-desc">Dateigröße · Groß → Klein</option>
              <option value="size-asc">Dateigröße · Klein → Groß</option>
            </select>
          </label>

          <label className="filter-toolbar__control">
            <span>Kurator:in</span>
            <select
              value={selectedOwner}
              onChange={(event) => setSelectedOwner(event.target.value)}
              className="filter-select"
            >
              <option value="all">Alle Personen</option>
              {ownerOptions.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.label}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-toolbar__control">
            <span>Model-Typ</span>
            <select
              value={selectedType}
              onChange={(event) => setSelectedType(event.target.value)}
              className="filter-select"
            >
              <option value="all">Alle Typen</option>
              {typeOptions.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>

          <div className="filter-toolbar__chips" role="group" aria-label="Dateigröße filtern">
            <FilterChip
              label="Alle Größen"
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
          <div className="filter-toolbar__tag-row" role="group" aria-label="Tags filtern">
            <span className="filter-toolbar__tag-label">Beliebte Tags</span>
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
            <span className="filter-toolbar__active-label">Aktive Filter:</span>
            <div className="filter-toolbar__active-chips">
              {activeFilters.map((filter) => (
                <button key={filter.id} type="button" className="active-filter" onClick={filter.onClear}>
                  <span>{filter.label}</span>
                  <span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
            <button type="button" className="filter-toolbar__reset" onClick={resetFilters}>
              Alle Filter zurücksetzen
            </button>
          </div>
        ) : null}
      </div>

      <div className="result-info" role="status">
        {isLoading && assets.length === 0 ? 'Lade LoRA-Assets …' : `Zeigt ${visibleAssets.length} von ${filteredAssets.length} Assets`}
      </div>

      <div className="asset-explorer__grid" role="list" aria-label="LoRA-Assets">
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
                  onClick={() => setActiveAssetId(asset.id)}
                >
                  <div className={`asset-tile__preview${previewUrl ? '' : ' asset-tile__preview--empty'}`}>
                    {previewUrl ? (
                      <img src={previewUrl} alt={`Preview von ${asset.title}`} loading="lazy" />
                    ) : (
                      <span>Kein Preview</span>
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
                  <span className="asset-detail__version">Version {activeAsset.version}</span>
                  <h3 id="asset-detail-title">{activeAsset.title}</h3>
                  <p>Kuratiert von {activeAsset.owner.displayName}</p>
                </div>
                <button type="button" className="asset-detail__close" onClick={closeDetail}>
                  Zurück zur Modellliste
                </button>
              </header>

              {activeAsset.description ? (
                <p className="asset-detail__description">{activeAsset.description}</p>
              ) : (
                <p className="asset-detail__description asset-detail__description--muted">
                  Noch keine Beschreibung hinterlegt.
                </p>
              )}

              {activeAsset.previewImage ? (
                <div className="asset-detail__preview">
                  <img
                    src={
                      resolveStorageUrl(
                        activeAsset.previewImage,
                        activeAsset.previewImageBucket,
                        activeAsset.previewImageObject,
                      ) ?? activeAsset.previewImage
                    }
                    alt={`Preview von ${activeAsset.title}`}
                  />
                </div>
              ) : null}

              <section className="asset-detail__section">
                <h4>Speicher &amp; Größe</h4>
                <dl>
                  <div>
                    <dt>Storage Objekt</dt>
                    <dd>
                      <a
                        href={
                          resolveStorageUrl(activeAsset.storagePath, activeAsset.storageBucket, activeAsset.storageObject) ??
                          activeAsset.storagePath
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {activeAsset.storageObject ?? activeAsset.storagePath}
                      </a>
                    </dd>
                  </div>
                  {activeAsset.storageBucket ? (
                    <div>
                      <dt>Bucket</dt>
                      <dd>{activeAsset.storageBucket}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Dateigröße</dt>
                    <dd>{formatFileSize(activeAsset.fileSize)}</dd>
                  </div>
                  <div>
                    <dt>Checksumme</dt>
                    <dd>{activeAsset.checksum ?? '–'}</dd>
                  </div>
                  <div>
                    <dt>Aktualisiert</dt>
                    <dd>{formatDate(activeAsset.updatedAt)}</dd>
                  </div>
                </dl>
              </section>

              <section className="asset-detail__section">
                <h4>Tags</h4>
                {activeAsset.tags.length > 0 ? (
                  <div className="asset-detail__tags">
                    {activeAsset.tags.map((tag) => (
                      <span key={tag.id}>{tag.label}</span>
                    ))}
                  </div>
                ) : (
                  <p className="asset-detail__description asset-detail__description--muted">Keine Tags hinterlegt.</p>
                )}
              </section>

              <section className="asset-detail__section">
                <h4>Metadaten</h4>
                {metadataEntries.length > 0 ? (
                  <dl className="asset-detail__metadata">
                    {metadataEntries.map((row) => (
                      <div key={row.key}>
                        <dt>{row.key}</dt>
                        <dd>{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="asset-detail__description asset-detail__description--muted">Keine Metadaten verfügbar.</p>
                )}
              </section>

              <section className="asset-detail__section">
                <h4>Verknüpfte Bild-Sammlungen</h4>
                {relatedGalleries.length > 0 ? (
                  <ul className="asset-detail__gallery-links">
                    {relatedGalleries.map((gallery) => (
                      <li key={gallery.id}>
                        {onNavigateToGallery ? (
                          <button
                            type="button"
                            onClick={() => handleNavigateFromDetail(gallery.id)}
                            className="asset-detail__gallery-button"
                          >
                            {gallery.title}
                          </button>
                        ) : (
                          <span>{gallery.title}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="asset-detail__description asset-detail__description--muted">
                    Dieses LoRA ist noch keiner Bildsammlung zugeordnet.
                  </p>
                )}
              </section>
            </div>
          </div>
        </div>
      ) : null}

      {!isLoading && filteredAssets.length === 0 ? (
        <p className="panel__empty">Keine Assets entsprechen den aktuellen Filtern.</p>
      ) : null}

      <div ref={sentinelRef} className="asset-explorer__sentinel" aria-hidden="true" />
    </section>
  );
};
