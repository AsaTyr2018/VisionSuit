import { useDeferredValue, useEffect, useMemo, useState } from 'react';

import type { Gallery, ImageAsset } from '../types/api';

import { resolveStorageUrl } from '../lib/storage';

import { FilterChip } from './FilterChip';

interface GalleryExplorerProps {
  galleries: Gallery[];
  isLoading: boolean;
  onStartGalleryDraft: () => void;
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

const matchesSearch = (gallery: Gallery, query: string) => {
  if (!query) return true;
  const haystack = [
    gallery.title,
    gallery.slug,
    gallery.description ?? '',
    gallery.owner.displayName,
    ...gallery.entries
      .map((entry) => entry.modelAsset?.title ?? entry.imageAsset?.title ?? entry.note ?? '')
      .filter(Boolean),
  ]
    .map((entry) => normalize(entry))
    .join(' ');
  return haystack.includes(query);
};

const galleryHasImage = (gallery: Gallery) => gallery.entries.some((entry) => Boolean(entry.imageAsset));
const galleryHasModel = (gallery: Gallery) => gallery.entries.some((entry) => Boolean(entry.modelAsset));

const getImageEntries = (gallery: Gallery): GalleryImageEntry[] =>
  gallery.entries
    .filter((entry): entry is typeof entry & { imageAsset: ImageAsset } => Boolean(entry.imageAsset))
    .map((entry) => ({ entryId: entry.id, image: entry.imageAsset, note: entry.note ?? null }));

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const formatDimensions = (image: ImageAsset) =>
  image.dimensions ? `${image.dimensions.width} × ${image.dimensions.height}px` : 'Unbekannt';

const formatFileSize = (size?: number | null) => {
  if (!size || Number.isNaN(size)) {
    return 'Unbekannt';
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

const selectPreviewImage = (gallery: Gallery) => {
  const imageEntries = getImageEntries(gallery);
  if (imageEntries.length === 0) {
    return null;
  }
  const seededIndex = buildSeededIndex(`${gallery.id}-${gallery.updatedAt}`, imageEntries.length);
  return imageEntries[seededIndex]?.image ?? null;
};

const buildMetadataRows = (image: ImageAsset) => {
  const exif = image.metadata ?? {};
  return [
    { label: 'Prompt', value: image.prompt ?? 'Kein Prompt hinterlegt.' },
    { label: 'Negativer Prompt', value: image.negativePrompt ?? '–' },
    { label: 'Model', value: exif.model ?? 'Unbekannt' },
    { label: 'Sampler', value: exif.sampler ?? 'Unbekannt' },
    { label: 'Seed', value: exif.seed ?? '–' },
    { label: 'CFG Scale', value: exif.cfgScale != null ? exif.cfgScale.toString() : '–' },
    { label: 'Steps', value: exif.steps != null ? exif.steps.toString() : '–' },
    { label: 'Dimensionen', value: formatDimensions(image) },
    { label: 'Dateigröße', value: formatFileSize(image.fileSize) },
  ];
};

export const GalleryExplorer = ({ galleries, isLoading, onStartGalleryDraft }: GalleryExplorerProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [visibility, setVisibility] = useState<VisibilityFilter>('all');
  const [entryFilter, setEntryFilter] = useState<EntryFilter>('all');
  const [ownerId, setOwnerId] = useState<string>('all');
  const [sortOption, setSortOption] = useState<SortOption>('recent');
  const [visibleLimit, setVisibleLimit] = useState(GALLERY_BATCH_SIZE);
  const [activeGalleryId, setActiveGalleryId] = useState<string | null>(null);
  const [activeImage, setActiveImage] = useState<GalleryImageEntry | null>(null);

  const deferredSearch = useDeferredValue(searchTerm);
  const normalizedQuery = normalize(deferredSearch.trim());

  const ownerOptions = useMemo(() => {
    const ownersMap = new Map<string, { id: string; label: string }>();
    galleries.forEach((gallery) => {
      if (!ownersMap.has(gallery.owner.id)) {
        ownersMap.set(gallery.owner.id, { id: gallery.owner.id, label: gallery.owner.displayName });
      }
    });
    return Array.from(ownersMap.values()).sort((a, b) => a.label.localeCompare(b.label, 'de'));
  }, [galleries]);

  const filteredGalleries = useMemo(() => {
    const filtered = galleries.filter((gallery) => {
      if (!matchesSearch(gallery, normalizedQuery)) return false;

      if (visibility !== 'all' && gallery.isPublic !== (visibility === 'public')) return false;

      if (ownerId !== 'all' && gallery.owner.id !== ownerId) return false;

      if (entryFilter === 'with-image' && !galleryHasImage(gallery)) return false;
      if (entryFilter === 'with-model' && !galleryHasModel(gallery)) return false;
      if (entryFilter === 'empty' && gallery.entries.length !== 0) return false;

      return true;
    });

    const sorters: Record<SortOption, (a: Gallery, b: Gallery) => number> = {
      recent: (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      alpha: (a, b) => a.title.localeCompare(b.title, 'de'),
      'entries-desc': (a, b) => b.entries.length - a.entries.length,
      'entries-asc': (a, b) => a.entries.length - b.entries.length,
    };

    return filtered.sort(sorters[sortOption]);
  }, [entryFilter, galleries, normalizedQuery, ownerId, sortOption, visibility]);

  useEffect(() => {
    setVisibleLimit(GALLERY_BATCH_SIZE);
  }, [normalizedQuery, visibility, entryFilter, ownerId, sortOption]);

  useEffect(() => {
    if (activeGalleryId && !galleries.some((gallery) => gallery.id === activeGalleryId)) {
      setActiveGalleryId(null);
    }
  }, [activeGalleryId, galleries]);

  useEffect(() => {
    setActiveImage(null);
  }, [activeGalleryId]);

  const visibleGalleries = useMemo(() => filteredGalleries.slice(0, visibleLimit), [filteredGalleries, visibleLimit]);

  const activeFilters = useMemo(() => {
    const filters: { id: string; label: string; onClear: () => void }[] = [];

    if (normalizedQuery) {
      filters.push({ id: 'search', label: `Suche: “${deferredSearch.trim()}”`, onClear: () => setSearchTerm('') });
    }

    if (visibility !== 'all') {
      filters.push({
        id: `visibility-${visibility}`,
        label: visibility === 'public' ? 'Status · Öffentlich' : 'Status · Privat',
        onClear: () => setVisibility('all'),
      });
    }

    if (entryFilter !== 'all') {
      const labels: Record<EntryFilter, string> = {
        all: '',
        'with-image': 'Inhalte · Mit Bildern',
        'with-model': 'Inhalte · Mit LoRAs',
        empty: 'Inhalte · Ohne Einträge',
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
        filters.push({ id: `owner-${owner.id}`, label: `Kurator:in · ${owner.label}`, onClear: () => setOwnerId('all') });
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

  const activeGallery = useMemo(
    () => (activeGalleryId ? galleries.find((gallery) => gallery.id === activeGalleryId) ?? null : null),
    [activeGalleryId, galleries],
  );

  const activeGalleryImages = useMemo(() => (activeGallery ? getImageEntries(activeGallery) : []), [activeGallery]);

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
          <h2 className="panel__title">Galerie-Explorer</h2>
          <p className="panel__subtitle">
            Kuratierte Sammlungen mit zufälligen Vorschaubildern, festen Kachelbreiten und detailreichen Bildansichten inklusive
            EXIF-Daten.
          </p>
        </div>
        <button type="button" className="panel__action" onClick={onStartGalleryDraft}>
          Galerie-Upload öffnen
        </button>
      </header>

      <div className="filter-toolbar" aria-label="Filter für Galerien">
        <div className="filter-toolbar__row">
          <label className="filter-toolbar__search">
            <span className="sr-only">Suche in Galerien</span>
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Titel, Kurator:in oder Slug durchsuchen"
              disabled={isLoading && galleries.length === 0}
            />
          </label>

          <label className="filter-toolbar__control">
            <span>Sortierung</span>
            <select value={sortOption} onChange={(event) => setSortOption(event.target.value as SortOption)} className="filter-select">
              <option value="recent">Aktualisiert · Neueste zuerst</option>
              <option value="alpha">Titel · A → Z</option>
              <option value="entries-desc">Einträge · Viele → Wenige</option>
              <option value="entries-asc">Einträge · Wenige → Viele</option>
            </select>
          </label>

          <div className="filter-toolbar__chips" role="group" aria-label="Sichtbarkeit filtern">
            <FilterChip label="Alle" isActive={visibility === 'all'} onClick={() => setVisibility('all')} />
            <FilterChip label="Öffentlich" isActive={visibility === 'public'} onClick={() => setVisibility('public')} />
            <FilterChip label="Privat" isActive={visibility === 'private'} onClick={() => setVisibility('private')} />
          </div>

          <label className="filter-toolbar__control">
            <span>Kurator:in</span>
            <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)} className="filter-select">
              <option value="all">Alle Personen</option>
              {ownerOptions.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="filter-toolbar__chips" role="group" aria-label="Inhaltstyp filtern">
          <FilterChip label="Alle Inhalte" isActive={entryFilter === 'all'} onClick={() => setEntryFilter('all')} />
          <FilterChip label="Mit Bildern" isActive={entryFilter === 'with-image'} onClick={() => setEntryFilter('with-image')} />
          <FilterChip label="Mit LoRAs" isActive={entryFilter === 'with-model'} onClick={() => setEntryFilter('with-model')} />
          <FilterChip label="Ohne Einträge" isActive={entryFilter === 'empty'} onClick={() => setEntryFilter('empty')} />
        </div>

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
        {isLoading && galleries.length === 0
          ? 'Lade Galerien …'
          : `Zeigt ${visibleGalleries.length} von ${filteredGalleries.length} Sammlungen`}
      </div>

      <div className="gallery-explorer__layout">
        <div className="gallery-explorer__grid" role="list">
          {isLoading && galleries.length === 0
            ? Array.from({ length: 10 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
            : visibleGalleries.map((gallery) => {
                const previewImage = selectPreviewImage(gallery);
                const totalImages = gallery.entries.filter((entry) => Boolean(entry.imageAsset)).length;
                const totalModels = gallery.entries.filter((entry) => Boolean(entry.modelAsset)).length;
                return (
                  <button
                    key={gallery.id}
                    type="button"
                    role="listitem"
                    className={`gallery-card${activeGalleryId === gallery.id ? ' gallery-card--active' : ''}`}
                    onClick={() => setActiveGalleryId(gallery.id)}
                  >
                    <div className="gallery-card__preview" aria-hidden={previewImage ? 'false' : 'true'}>
                      {previewImage ? (
                        <img src={resolveStorageUrl(previewImage.storagePath, previewImage.storageBucket, previewImage.storageObject) ?? previewImage.storagePath} alt={previewImage.title} loading="lazy" />
                      ) : (
                        <span>Kein Vorschaubild</span>
                      )}
                    </div>
                    <div className="gallery-card__body">
                      <h3 className="gallery-card__title">{gallery.title}</h3>
                      <p className="gallery-card__meta">Kuratiert von {gallery.owner.displayName}</p>
                      <dl className="gallery-card__stats">
                        <div>
                          <dt>Einträge</dt>
                          <dd>{gallery.entries.length}</dd>
                        </div>
                        <div>
                          <dt>Bilder</dt>
                          <dd>{totalImages}</dd>
                        </div>
                        <div>
                          <dt>LoRAs</dt>
                          <dd>{totalModels}</dd>
                        </div>
                      </dl>
                      <p className="gallery-card__timestamp">Zuletzt aktualisiert am {formatDate(gallery.updatedAt)}</p>
                    </div>
                  </button>
                );
              })}
        </div>

        <aside className="gallery-explorer__detail">
          {activeGallery ? (
            <div className="gallery-detail">
              <header className="gallery-detail__header">
                <div>
                  <span className={`gallery-detail__badge${activeGallery.isPublic ? ' gallery-detail__badge--public' : ''}`}>
                    {activeGallery.isPublic ? 'Öffentliche Sammlung' : 'Private Sammlung'}
                  </span>
                  <h3>{activeGallery.title}</h3>
                  <p>
                    Kuratiert von {activeGallery.owner.displayName} · Aktualisiert am {formatDate(activeGallery.updatedAt)}
                  </p>
                </div>
                <button type="button" className="gallery-detail__close" onClick={() => setActiveGalleryId(null)}>
                  Auswahl zurücksetzen
                </button>
              </header>

              {activeGallery.description ? (
                <p className="gallery-detail__description">{activeGallery.description}</p>
              ) : (
                <p className="gallery-detail__description gallery-detail__description--muted">
                  Noch keine Galerie-Beschreibung hinterlegt.
                </p>
              )}

              <div className="gallery-detail__grid" role="list">
                {activeGalleryImages.length > 0 ? (
                  activeGalleryImages.map((entry) => {
                    const imageUrl =
                      resolveStorageUrl(entry.image.storagePath, entry.image.storageBucket, entry.image.storageObject) ??
                      entry.image.storagePath;
                    return (
                      <button
                        key={entry.entryId}
                        type="button"
                        role="listitem"
                        className="gallery-detail__thumb"
                        onClick={() => setActiveImage(entry)}
                      >
                        <img src={imageUrl} alt={entry.image.title} loading="lazy" />
                        {entry.note ? <span className="gallery-detail__note">{entry.note}</span> : null}
                      </button>
                    );
                  })
                ) : (
                  <div className="gallery-detail__empty">Diese Sammlung enthält noch keine Bilder.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="gallery-detail gallery-detail--empty">
              <p>Wähle eine Sammlung, um alle Bilder zu sehen und EXIF-Daten einzublenden.</p>
            </div>
          )}
        </aside>
      </div>

      {!isLoading && visibleGalleries.length < filteredGalleries.length ? (
        <div className="panel__footer">
          <button type="button" className="panel__action panel__action--ghost" onClick={loadMore}>
            Weitere {Math.min(GALLERY_BATCH_SIZE, filteredGalleries.length - visibleGalleries.length)} Galerien laden
          </button>
        </div>
      ) : null}

      {activeImage ? (
        <div className="gallery-image-modal" role="dialog" aria-modal="true" aria-label={`${activeImage.image.title} vergrößern`}>
          <div className="gallery-image-modal__backdrop" onClick={() => setActiveImage(null)} aria-hidden="true" />
          <div className="gallery-image-modal__content">
            <header className="gallery-image-modal__header">
              <div>
                <h3>{activeImage.image.title}</h3>
                <p>Kuratiert von {activeGallery?.owner.displayName ?? 'Unbekannt'}</p>
              </div>
              <button type="button" className="gallery-image-modal__close" onClick={() => setActiveImage(null)} aria-label="Bildansicht schließen">
                ×
              </button>
            </header>
            <div className="gallery-image-modal__body">
              <div className="gallery-image-modal__media">
                <img
                  src={
                    resolveStorageUrl(
                      activeImage.image.storagePath,
                      activeImage.image.storageBucket,
                      activeImage.image.storageObject,
                    ) ?? activeImage.image.storagePath
                  }
                  alt={activeImage.image.title}
                />
              </div>
              <div className="gallery-image-modal__meta">
                {activeImage.note ? <p className="gallery-image-modal__note">Notiz: {activeImage.note}</p> : null}
                <dl>
                  {buildMetadataRows(activeImage.image).map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
};
