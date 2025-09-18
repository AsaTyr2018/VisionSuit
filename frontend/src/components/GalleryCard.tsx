import type { Gallery } from '../types/api';

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export const GalleryCard = ({ gallery }: { gallery: Gallery }) => {
  const previewItems = gallery.entries.slice(0, 4).map((entry) => {
    const type = entry.imageAsset ? 'image' : entry.modelAsset ? 'model' : 'empty';
    const src = entry.imageAsset?.storagePath ?? entry.modelAsset?.previewImage ?? null;
    const title = entry.imageAsset?.title ?? entry.modelAsset?.title ?? `Slot ${entry.position}`;
    return { id: entry.id, type, src, title };
  });

  return (
    <article className="gallery-card">
      <header className="gallery-card__header">
        <div>
          <h3 className="gallery-card__title">{gallery.title}</h3>
          <p className="gallery-card__curator">Kuratiert von {gallery.owner.displayName}</p>
        </div>
        <span className={`gallery-card__badge ${gallery.isPublic ? 'gallery-card__badge--public' : ''}`}>
          {gallery.isPublic ? 'Öffentlich' : 'Privat'}
        </span>
      </header>
      <p className="gallery-card__description">
        {gallery.description ?? 'Noch keine Galerie-Beschreibung hinterlegt.'}
      </p>
      <dl className="gallery-card__meta">
        <div>
          <dt>Slug</dt>
          <dd className="gallery-card__mono">{gallery.slug}</dd>
        </div>
        <div>
          <dt>Aktualisiert</dt>
          <dd>{formatDate(gallery.updatedAt)}</dd>
        </div>
        <div>
          <dt>Einträge</dt>
          <dd>{gallery.entries.length}</dd>
        </div>
        <div>
          <dt>Cover</dt>
          <dd className="gallery-card__mono">{gallery.coverImage ?? '–'}</dd>
        </div>
      </dl>
      <footer className="gallery-card__footer">
        {previewItems.length > 0 ? (
          <div className="gallery-card__preview-grid">
            {previewItems.map((item) => (
              <div key={item.id} className={`gallery-card__preview gallery-card__preview--${item.type}`}>
                {item.src ? <img src={item.src} alt={item.title} loading="lazy" /> : <span>{item.title}</span>}
              </div>
            ))}
            {gallery.entries.length > previewItems.length ? (
              <div className="gallery-card__preview gallery-card__preview--more">+{gallery.entries.length - previewItems.length}</div>
            ) : null}
          </div>
        ) : (
          <span>Diese Galerie enthält noch keine Einträge.</span>
        )}
      </footer>
    </article>
  );
};
