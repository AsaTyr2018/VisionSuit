import { useDeferredValue, useEffect, useMemo, useState } from 'react';

import type { Gallery } from '../types/api';

import { FilterChip } from './FilterChip';
import { GalleryCard } from './GalleryCard';

interface GalleryExplorerProps {
  galleries: Gallery[];
  isLoading: boolean;
}

type VisibilityFilter = 'all' | 'public' | 'private';
type EntryFilter = 'all' | 'with-image' | 'with-model' | 'empty';
type SortOption = 'recent' | 'alpha' | 'entries-desc' | 'entries-asc';

const GALLERY_BATCH_SIZE = 12;

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

export const GalleryExplorer = ({ galleries, isLoading }: GalleryExplorerProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [visibility, setVisibility] = useState<VisibilityFilter>('all');
  const [entryFilter, setEntryFilter] = useState<EntryFilter>('all');
  const [ownerId, setOwnerId] = useState<string>('all');
  const [sortOption, setSortOption] = useState<SortOption>('recent');
  const [visibleLimit, setVisibleLimit] = useState(GALLERY_BATCH_SIZE);

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

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h2 className="panel__title">Galerie-Explorer</h2>
          <p className="panel__subtitle">
            Finde kuratierte Sets anhand von Sichtbarkeit, Inhaltstyp oder Kurator:innen und blättere performant durch umfangreiche
            Sammlungen.
          </p>
        </div>
        <button type="button" className="panel__action">Galerie-Entwurf starten</button>
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
          : `Zeigt ${visibleGalleries.length} von ${filteredGalleries.length} Galerien`}
      </div>

      <div className="panel__grid panel__grid--columns">
        {isLoading && galleries.length === 0
          ? Array.from({ length: 4 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
          : visibleGalleries.map((gallery) => <GalleryCard key={gallery.id} gallery={gallery} />)}
      </div>

      {!isLoading && filteredGalleries.length === 0 ? (
        <p className="panel__empty">Keine Galerien entsprechen den aktiven Filtern.</p>
      ) : null}

      {!isLoading && visibleGalleries.length < filteredGalleries.length ? (
        <div className="panel__footer">
          <button type="button" className="panel__action panel__action--ghost" onClick={loadMore}>
            Weitere {Math.min(GALLERY_BATCH_SIZE, filteredGalleries.length - visibleGalleries.length)} Galerien laden
          </button>
        </div>
      ) : null}
    </section>
  );
};
