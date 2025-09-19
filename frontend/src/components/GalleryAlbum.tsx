import { useEffect, useMemo, useState } from 'react';

import type { Gallery } from '../types/api';

import { resolveStorageUrl } from '../lib/storage';

interface GalleryAlbumItem {
  id: string;
  type: 'image' | 'model';
  title: string;
  subtitle: string | null;
  description: string | null;
  src?: string;
}

const buildAlbumItems = (gallery: Gallery): GalleryAlbumItem[] =>
  gallery.entries
    .map((entry) => {
      if (entry.imageAsset) {
        return {
          id: entry.id,
          type: 'image' as const,
          title: entry.imageAsset.title,
          subtitle: entry.note ?? entry.imageAsset.metadata.model ?? null,
          description: entry.imageAsset.prompt ?? null,
          src: resolveStorageUrl(
            entry.imageAsset.storagePath,
            entry.imageAsset.storageBucket,
            entry.imageAsset.storageObject,
          ),
        } satisfies GalleryAlbumItem;
      }

      if (entry.modelAsset) {
        return {
          id: entry.id,
          type: 'model' as const,
          title: entry.modelAsset.title,
          subtitle: entry.modelAsset.version ? `Version ${entry.modelAsset.version}` : null,
          description: entry.note ?? entry.modelAsset.description ?? null,
          src: resolveStorageUrl(
            entry.modelAsset.previewImage,
            entry.modelAsset.previewImageBucket,
            entry.modelAsset.previewImageObject,
          ),
        } satisfies GalleryAlbumItem;
      }

      return null;
    })
    .filter((item): item is GalleryAlbumItem => Boolean(item));

const COUNT_LABEL: Record<GalleryAlbumItem['type'], string> = {
  image: 'Bild',
  model: 'LoRA',
};

const useLightbox = (itemCount: number) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  useEffect(() => {
    if (activeIndex === null) {
      return;
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveIndex(null);
        return;
      }

      if (event.key === 'ArrowRight') {
        setActiveIndex((current) => {
          if (current === null) {
            return current;
          }

          return Math.min(itemCount - 1, current + 1);
        });
        return;
      }

      if (event.key === 'ArrowLeft') {
        setActiveIndex((current) => {
          if (current === null) {
            return current;
          }

          return Math.max(0, current - 1);
        });
      }
    };

    window.addEventListener('keydown', handleKey);

    return () => window.removeEventListener('keydown', handleKey);
  }, [activeIndex, itemCount]);

  useEffect(() => {
    if (activeIndex === null) {
      document.body.style.removeProperty('overflow');
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [activeIndex]);

  return { activeIndex, setActiveIndex } as const;
};

export const GalleryAlbum = ({ gallery }: { gallery: Gallery }) => {
  const items = useMemo(() => buildAlbumItems(gallery), [gallery]);
  const { activeIndex, setActiveIndex } = useLightbox(items.length);

  const activeItem = useMemo(
    () => (typeof activeIndex === 'number' ? items[activeIndex] ?? null : null),
    [activeIndex, items],
  );

  useEffect(() => {
    if (activeIndex !== null && activeIndex >= items.length) {
      setActiveIndex(items.length > 0 ? items.length - 1 : null);
    }
  }, [activeIndex, items.length, setActiveIndex]);

  const imageCount = useMemo(() => items.filter((item) => item.type === 'image').length, [items]);
  const modelCount = useMemo(() => items.filter((item) => item.type === 'model').length, [items]);

  const coverUrl = resolveStorageUrl(gallery.coverImage, gallery.coverImageBucket, gallery.coverImageObject);

  const previewItems = items.slice(0, 5);
  const overflowCount = Math.max(0, items.length - previewItems.length);

  return (
    <article className="gallery-album">
      <header className="gallery-album__header">
        <div className="gallery-album__identity">
          <h3 className="gallery-album__title">{gallery.title}</h3>
          <p className="gallery-album__subtitle">
            Kuratiert von {gallery.owner.displayName} · Aktualisiert am{' '}
            {new Date(gallery.updatedAt).toLocaleDateString('de-DE', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </p>
        </div>
        <dl className="gallery-album__stats">
          <div>
            <dt>Einträge</dt>
            <dd>{gallery.entries.length}</dd>
          </div>
          <div>
            <dt>Bilder</dt>
            <dd>{imageCount}</dd>
          </div>
          <div>
            <dt>LoRAs</dt>
            <dd>{modelCount}</dd>
          </div>
        </dl>
      </header>

      {coverUrl ? (
        <div className="gallery-album__cover" aria-hidden="true">
          <img src={coverUrl} alt="" loading="lazy" />
        </div>
      ) : null}

      <div className="gallery-album__grid">
        {previewItems.length > 0 ? (
          previewItems.map((item, index) => {
            const isHero = index === 0;
            return (
              <button
                key={item.id}
                type="button"
                className={`gallery-album__item gallery-album__item--${item.type}${
                  isHero ? ' gallery-album__item--hero' : ''
                }`}
                onClick={() => setActiveIndex(index)}
              >
                {item.src ? (
                  <img src={item.src} alt={item.title} loading="lazy" />
                ) : (
                  <span className="gallery-album__placeholder">Kein Vorschaubild verfügbar</span>
                )}
                <div className="gallery-album__overlay">
                  <span className="gallery-album__label">{COUNT_LABEL[item.type]}</span>
                  <h4>{item.title}</h4>
                  {item.subtitle ? <p>{item.subtitle}</p> : null}
                </div>
              </button>
            );
          })
        ) : (
          <div className="gallery-album__empty">Noch keine Einträge in dieser Galerie.</div>
        )}

        {overflowCount > 0 ? (
          <button
            type="button"
            className="gallery-album__item gallery-album__item--more"
            onClick={() => setActiveIndex(previewItems.length)}
          >
            <span>+{overflowCount} weitere Inhalte</span>
          </button>
        ) : null}
      </div>

      <div className="gallery-album__details">
        {gallery.description ? (
          <p className="gallery-album__description">{gallery.description}</p>
        ) : (
          <p className="gallery-album__description gallery-album__description--muted">
            Noch keine Galerie-Beschreibung hinterlegt.
          </p>
        )}
        <span className={`gallery-album__badge${gallery.isPublic ? ' gallery-album__badge--public' : ''}`}>
          {gallery.isPublic ? 'Öffentliche Sammlung' : 'Private Sammlung'}
        </span>
      </div>

      {items.length > 0 ? (
        <div className="gallery-album__thumbnails" role="list">
          {items.map((item, index) => (
            <button
              key={`thumb-${item.id}`}
              type="button"
              role="listitem"
              className={`gallery-album__thumbnail gallery-album__thumbnail--${item.type}`}
              onClick={() => setActiveIndex(index)}
            >
              {item.src ? <img src={item.src} alt={item.title} loading="lazy" /> : <span>{item.title}</span>}
            </button>
          ))}
        </div>
      ) : null}

      {activeItem ? (
        <div className="gallery-lightbox" role="dialog" aria-modal="true" aria-label={`${activeItem.title} vergrößern`}>
          <div className="gallery-lightbox__backdrop" onClick={() => setActiveIndex(null)} aria-hidden="true" />
          <div className="gallery-lightbox__content">
            <header className="gallery-lightbox__header">
              <div>
                <span className={`gallery-lightbox__chip gallery-lightbox__chip--${activeItem.type}`}>
                  {COUNT_LABEL[activeItem.type]}
                </span>
                <h3>{activeItem.title}</h3>
                {activeItem.subtitle ? <p>{activeItem.subtitle}</p> : null}
              </div>
              <div className="gallery-lightbox__actions">
                <button
                  type="button"
                  className="gallery-lightbox__nav"
                  onClick={() => setActiveIndex((current) => {
                    if (current === null) {
                      return current;
                    }

                    return Math.max(0, current - 1);
                  })}
                  disabled={activeIndex === 0}
                  aria-label="Vorheriger Eintrag"
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="gallery-lightbox__nav"
                  onClick={() => setActiveIndex((current) => {
                    if (current === null) {
                      return current;
                    }

                    return Math.min(items.length - 1, current + 1);
                  })}
                  disabled={activeIndex === items.length - 1}
                  aria-label="Nächster Eintrag"
                >
                  ›
                </button>
                <button
                  type="button"
                  className="gallery-lightbox__close"
                  onClick={() => setActiveIndex(null)}
                  aria-label="Vorschau schließen"
                >
                  ×
                </button>
              </div>
            </header>
            <div className="gallery-lightbox__body">
              {activeItem.src ? (
                <img src={activeItem.src} alt={activeItem.title} />
              ) : (
                <span className="gallery-lightbox__placeholder">Kein Vorschaubild vorhanden</span>
              )}
            </div>
            {activeItem.description ? (
              <footer className="gallery-lightbox__footer">
                <h4>Beschreibung</h4>
                <p>{activeItem.description}</p>
              </footer>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
};
