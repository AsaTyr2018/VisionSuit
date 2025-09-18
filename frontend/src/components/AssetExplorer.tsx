import { useDeferredValue, useEffect, useMemo, useState } from 'react';

import type { ModelAsset } from '../types/api';

import { AssetCard } from './AssetCard';
import { FilterChip } from './FilterChip';

interface AssetExplorerProps {
  assets: ModelAsset[];
  isLoading: boolean;
  onStartUpload?: () => void;
}

type FileSizeFilter = 'all' | 'small' | 'medium' | 'large' | 'unknown';
type SortOption = 'recent' | 'alpha' | 'size-desc' | 'size-asc';

type OwnerOption = { id: string; label: string };
type TagOption = { id: string; label: string; count: number };

type TypeOption = { id: string; label: string; count: number };

const ASSET_BATCH_SIZE = 24;

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

const matchesSearch = (asset: ModelAsset, query: string) => {
  if (!query) return true;
  const haystack = [
    asset.title,
    asset.slug,
    asset.description ?? '',
    asset.owner.displayName,
    asset.version,
    asset.storageObject ?? asset.storagePath,
    ...asset.tags.map((tag) => tag.label),
  ]
    .map((entry) => normalize(entry))
    .join(' ');

  return haystack.includes(query);
};

const findModelType = (asset: ModelAsset) => asset.tags.find((tag) => tag.category === 'model-type');

export const AssetExplorer = ({ assets, isLoading, onStartUpload }: AssetExplorerProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedOwner, setSelectedOwner] = useState<string>('all');
  const [fileSizeFilter, setFileSizeFilter] = useState<FileSizeFilter>('all');
  const [sortOption, setSortOption] = useState<SortOption>('recent');
  const [visibleLimit, setVisibleLimit] = useState(ASSET_BATCH_SIZE);

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

  const visibleAssets = useMemo(() => filteredAssets.slice(0, visibleLimit), [filteredAssets, visibleLimit]);

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

  const loadMoreAssets = () => {
    setVisibleLimit((current) => Math.min(filteredAssets.length, current + ASSET_BATCH_SIZE));
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
          Upload-Assistent starten
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

      <div className="panel__grid panel__grid--columns">
        {isLoading && assets.length === 0
          ? Array.from({ length: 6 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
          : visibleAssets.map((asset) => <AssetCard key={asset.id} asset={asset} />)}
      </div>

      {!isLoading && filteredAssets.length === 0 ? (
        <p className="panel__empty">Keine Assets entsprechen den aktuellen Filtern.</p>
      ) : null}

      {!isLoading && visibleAssets.length < filteredAssets.length ? (
        <div className="panel__footer">
          <button type="button" className="panel__action panel__action--ghost" onClick={loadMoreAssets}>
            Weitere {Math.min(ASSET_BATCH_SIZE, filteredAssets.length - visibleAssets.length)} Assets laden
          </button>
        </div>
      ) : null}
    </section>
  );
};
