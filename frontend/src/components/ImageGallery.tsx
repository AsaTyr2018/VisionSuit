import { useDeferredValue, useEffect, useMemo, useState } from 'react';

import type { ImageAsset } from '../types/api';

import { resolveStorageUrl } from '../lib/storage';

interface ImageGalleryProps {
  images: ImageAsset[];
  isLoading: boolean;
}

type SortOption = 'recent' | 'alpha' | 'size-desc' | 'size-asc';

const IMAGE_BATCH_SIZE = 24;

const normalize = (value?: string | null) => value?.toLowerCase().normalize('NFKD') ?? '';

const matchesSearch = (image: ImageAsset, query: string) => {
  if (!query) return true;

  const haystack = [
    image.title,
    image.prompt ?? '',
    image.negativePrompt ?? '',
    image.metadata?.model ?? '',
    image.metadata?.sampler ?? '',
    image.metadata?.seed ?? '',
    ...image.tags.map((tag) => tag.label ?? ''),
  ]
    .map((entry) => normalize(entry))
    .join(' ');

  return haystack.includes(query);
};

const formatDimensions = (image: ImageAsset) => {
  if (!image.dimensions) {
    return 'Unbekannt';
  }

  return `${image.dimensions.width} × ${image.dimensions.height}`;
};

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export const ImageGallery = ({ images, isLoading }: ImageGalleryProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOption, setSortOption] = useState<SortOption>('recent');
  const [visibleLimit, setVisibleLimit] = useState(IMAGE_BATCH_SIZE);

  const deferredSearch = useDeferredValue(searchTerm);
  const normalizedQuery = normalize(deferredSearch.trim());

  const filteredImages = useMemo(() => {
    const filtered = images.filter((image) => matchesSearch(image, normalizedQuery));

    const sorters: Record<SortOption, (a: ImageAsset, b: ImageAsset) => number> = {
      recent: (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      alpha: (a, b) => a.title.localeCompare(b.title, 'de'),
      'size-desc': (a, b) => (b.fileSize ?? 0) - (a.fileSize ?? 0),
      'size-asc': (a, b) => (a.fileSize ?? Number.POSITIVE_INFINITY) - (b.fileSize ?? Number.POSITIVE_INFINITY),
    };

    return filtered.sort(sorters[sortOption]);
  }, [images, normalizedQuery, sortOption]);

  useEffect(() => {
    setVisibleLimit(IMAGE_BATCH_SIZE);
  }, [normalizedQuery, sortOption]);

  const visibleImages = useMemo(() => filteredImages.slice(0, visibleLimit), [filteredImages, visibleLimit]);
  const remainingCount = filteredImages.length - visibleImages.length;

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h2 className="panel__title">Image-Galerie</h2>
          <p className="panel__subtitle">
            Durchsuche Renderings, Prompt-Varianten und Referenzen. Titel, Prompt-Details und Model-Informationen werden in die
            Volltextsuche einbezogen.
          </p>
        </div>
      </header>

      <div className="filter-toolbar" aria-label="Filter für Bilder">
        <div className="filter-toolbar__row">
          <label className="filter-toolbar__search">
            <span className="sr-only">Bilder durchsuchen</span>
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Titel, Prompt oder Tags durchsuchen"
              disabled={isLoading && images.length === 0}
            />
          </label>

          <label className="filter-toolbar__control">
            <span>Sortierung</span>
            <select value={sortOption} onChange={(event) => setSortOption(event.target.value as SortOption)} className="filter-select">
              <option value="recent">Neueste zuerst</option>
              <option value="alpha">Titel · A → Z</option>
              <option value="size-desc">Dateigröße · Groß → Klein</option>
              <option value="size-asc">Dateigröße · Klein → Groß</option>
            </select>
          </label>
        </div>
      </div>

      <div className="result-info" role="status">
        {isLoading && images.length === 0
          ? 'Lade Bilder …'
          : `Zeigt ${visibleImages.length} von ${filteredImages.length} Bildern`}
      </div>

      <div className="image-gallery__grid">
        {isLoading && images.length === 0
          ? Array.from({ length: 8 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
          : visibleImages.map((image) => {
              const imageUrl =
                resolveStorageUrl(image.storagePath, image.storageBucket, image.storageObject) ?? image.storagePath;
              return (
                <article key={image.id} className="image-card">
                  <div className="image-card__media">
                    {imageUrl ? (
                      <img src={imageUrl} alt={image.title} loading="lazy" />
                    ) : (
                      <span className="image-card__placeholder">Kein Vorschaubild verfügbar</span>
                    )}
                  </div>
                  <div className="image-card__body">
                    <header className="image-card__header">
                      <h3 className="image-card__title">{image.title}</h3>
                      <span className="image-card__timestamp">{formatDate(image.updatedAt)}</span>
                    </header>
                    <p className="image-card__prompt">{image.prompt ?? 'Kein Prompt hinterlegt.'}</p>
                    <dl className="image-card__meta">
                      <div>
                        <dt>Dimensions</dt>
                        <dd>{formatDimensions(image)}</dd>
                      </div>
                      <div>
                        <dt>Model</dt>
                        <dd>{image.metadata?.model ?? 'Unbekannt'}</dd>
                      </div>
                      <div>
                        <dt>Sampler</dt>
                        <dd>{image.metadata?.sampler ?? '–'}</dd>
                      </div>
                    </dl>
                    {image.tags.length > 0 ? (
                      <ul className="image-card__tags">
                        {image.tags.slice(0, 6).map((tag) => (
                          <li key={tag.id}>#{tag.label}</li>
                        ))}
                        {image.tags.length > 6 ? <li>+{image.tags.length - 6}</li> : null}
                      </ul>
                    ) : null}
                  </div>
                </article>
              );
            })}
      </div>

      {!isLoading && filteredImages.length === 0 ? (
        <p className="panel__empty">Keine Bilder entsprechen der aktuellen Suche.</p>
      ) : null}

      {!isLoading && remainingCount > 0 ? (
        <div className="panel__footer">
          <button type="button" className="panel__action panel__action--ghost" onClick={() => setVisibleLimit((current) => current + IMAGE_BATCH_SIZE)}>
            Weitere {Math.min(IMAGE_BATCH_SIZE, remainingCount)} Bilder laden
          </button>
        </div>
      ) : null}
    </section>
  );
};
