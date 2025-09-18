import type { Gallery } from '../types/api';

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export const GalleryCard = ({ gallery }: { gallery: Gallery }) => (
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
    <footer className="gallery-card__footer">Platzhalter für Vorschau-Kacheln der Galerie-Einträge.</footer>
  </article>
);
