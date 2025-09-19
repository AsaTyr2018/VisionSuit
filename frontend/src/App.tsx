import { useCallback, useEffect, useMemo, useState } from 'react';

import { AssetExplorer } from './components/AssetExplorer';
import { GalleryExplorer } from './components/GalleryExplorer';
import { ImageGallery } from './components/ImageGallery';
import { UploadWizard } from './components/UploadWizard';
import type { UploadWizardResult } from './components/UploadWizard';
import { api } from './lib/api';
import { resolveStorageUrl } from './lib/storage';
import type { Gallery, ImageAsset, ModelAsset } from './types/api';

type ViewKey = 'home' | 'models' | 'images';
type ServiceStatusKey = 'frontend' | 'backend' | 'minio';
type ServiceState = 'online' | 'offline' | 'degraded' | 'unknown';

interface ServiceIndicator {
  label: string;
  status: ServiceState;
  message: string;
}

const viewMeta: Record<ViewKey, { title: string; description: string }> = {
  home: {
    title: 'Home',
    description: 'Überblick über neue Modelle und Bild-Uploads – direkt aus Backend und Storage gespeist.',
  },
  models: {
    title: 'Models',
    description: 'LoRA-Explorer mit Volltextsuche, Typfiltern und Kurator:innen-Ansicht.',
  },
  images: {
    title: 'Images',
    description: 'Bildgalerie mit Prompt-Details und kuratierten Sets für Präsentationen.',
  },
};

const statusLabels: Record<ServiceState, string> = {
  online: 'Online',
  offline: 'Offline',
  degraded: 'Eingeschränkt',
  unknown: 'Unbekannt',
};

const truncate = (value: string, length = 140) => {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length - 1)}…`;
};

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const createInitialStatus = (): Record<ServiceStatusKey, ServiceIndicator> => ({
  frontend: { label: 'Frontend', status: 'online', message: 'UI aktiv.' },
  backend: { label: 'Backend', status: 'unknown', message: 'Status wird geprüft …' },
  minio: { label: 'MinIO', status: 'unknown', message: 'Status wird geprüft …' },
});

export const App = () => {
  const [activeView, setActiveView] = useState<ViewKey>('home');
  const [assets, setAssets] = useState<ModelAsset[]>([]);
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  const [isGalleryUploadOpen, setIsGalleryUploadOpen] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [serviceStatus, setServiceStatus] = useState<Record<ServiceStatusKey, ServiceIndicator>>(createInitialStatus);

  const fetchServiceStatus = useCallback(async () => {
    try {
      const status = await api.getServiceStatus();
      setServiceStatus({
        frontend: { label: 'Frontend', status: 'online', message: 'UI aktiv.' },
        backend: {
          label: 'Backend',
          status: status.services.backend.status ?? 'online',
          message: status.services.backend.message ?? 'API erreichbar.',
        },
        minio: {
          label: 'MinIO',
          status: status.services.minio.status ?? 'online',
          message: status.services.minio.message ?? 'Storage verfügbar.',
        },
      });
    } catch (error) {
      console.error('Service status fetch failed', error);
      setServiceStatus({
        frontend: { label: 'Frontend', status: 'online', message: 'UI aktiv.' },
        backend: { label: 'Backend', status: 'offline', message: 'Backend nicht erreichbar.' },
        minio: { label: 'MinIO', status: 'offline', message: 'Storage nicht erreichbar.' },
      });
    }
  }, []);

  const refreshData = useCallback(async () => {
    try {
      setIsLoading(true);
      const [fetchedAssets, fetchedGalleries, fetchedImages] = await Promise.all([
        api.getModelAssets(),
        api.getGalleries(),
        api.getImageAssets(),
      ]);

      setAssets(fetchedAssets);
      setGalleries(fetchedGalleries);
      setImages(fetchedImages);
      setErrorMessage(null);
    } catch (error) {
      console.error(error);
      setErrorMessage('Backend noch nicht erreichbar. Bitte Server prüfen oder später erneut versuchen.');
    } finally {
      setIsLoading(false);
    }

    fetchServiceStatus().catch((statusError) => console.error('Failed to refresh service status', statusError));
  }, [fetchServiceStatus]);

  useEffect(() => {
    refreshData().catch((error) => console.error('Unexpected fetch error', error));
  }, [refreshData]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const handleWizardCompletion = (result: UploadWizardResult) => {
    if (result.status === 'success') {
      setToast({
        type: 'success',
        message:
          result.message ??
          'Upload-Session wurde erstellt. Die Inhalte erscheinen nach Abschluss der Hintergrundanalyse.',
      });
      refreshData().catch((error) => console.error('Failed to refresh after upload', error));
    } else {
      setToast({ type: 'error', message: result.message });
    }
  };

  const latestModels = useMemo(() => assets.slice(0, 6), [assets]);
  const latestImages = useMemo(() => images.slice(0, 6), [images]);

  const modelTiles = latestModels.map((asset) => {
    const previewUrl =
      resolveStorageUrl(asset.previewImage, asset.previewImageBucket, asset.previewImageObject) ?? asset.previewImage;
    return (
      <article key={asset.id} className="tile tile--model">
        <div className="tile__media">
          {previewUrl ? (
            <img src={previewUrl} alt={asset.title} loading="lazy" />
          ) : (
            <span className="tile__placeholder">Kein Vorschaubild verfügbar</span>
          )}
        </div>
        <div className="tile__body">
          <header className="tile__header">
            <h3 className="tile__title">{asset.title}</h3>
            <span className="tile__meta">v{asset.version}</span>
          </header>
          <p className="tile__description">
            {asset.description ? truncate(asset.description, 150) : 'Noch keine Beschreibung hinterlegt.'}
          </p>
          <dl className="tile__details">
            <div>
              <dt>Kurator:in</dt>
              <dd>{asset.owner.displayName}</dd>
            </div>
            <div>
              <dt>Aktualisiert</dt>
              <dd>{formatDate(asset.updatedAt)}</dd>
            </div>
          </dl>
          {asset.tags.length > 0 ? (
            <ul className="tile__tags">
              {asset.tags.slice(0, 4).map((tag) => (
                <li key={tag.id}>#{tag.label}</li>
              ))}
              {asset.tags.length > 4 ? <li>+{asset.tags.length - 4}</li> : null}
            </ul>
          ) : null}
        </div>
      </article>
    );
  });

  const imageTiles = latestImages.map((image) => {
    const imageUrl =
      resolveStorageUrl(image.storagePath, image.storageBucket, image.storageObject) ?? image.storagePath;
    return (
      <article key={image.id} className="tile tile--image">
        <div className="tile__media">
          {imageUrl ? (
            <img src={imageUrl} alt={image.title} loading="lazy" />
          ) : (
            <span className="tile__placeholder">Kein Bild verfügbar</span>
          )}
        </div>
        <div className="tile__body">
          <header className="tile__header">
            <h3 className="tile__title">{image.title}</h3>
            <span className="tile__meta">{formatDate(image.updatedAt)}</span>
          </header>
          <p className="tile__description">{image.prompt ? truncate(image.prompt, 140) : 'Kein Prompt hinterlegt.'}</p>
          <dl className="tile__details">
            <div>
              <dt>Model</dt>
              <dd>{image.metadata.model ?? 'Unbekannt'}</dd>
            </div>
            <div>
              <dt>Sampler</dt>
              <dd>{image.metadata.sampler ?? '–'}</dd>
            </div>
          </dl>
          {image.tags.length > 0 ? (
            <ul className="tile__tags">
              {image.tags.slice(0, 4).map((tag) => (
                <li key={tag.id}>#{tag.label}</li>
              ))}
              {image.tags.length > 4 ? <li>+{image.tags.length - 4}</li> : null}
            </ul>
          ) : null}
        </div>
      </article>
    );
  });

  const renderHome = () => (
    <div className="home-grid">
      <section className="home-section">
        <header className="home-section__header">
          <h2>Neueste Modelle</h2>
          <p>Die jüngsten Uploads aus dem Model-Explorer als kompakte Kacheln.</p>
        </header>
        <div className="tile-grid">
          {isLoading && assets.length === 0
            ? Array.from({ length: 4 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
            : modelTiles}
        </div>
        {!isLoading && modelTiles.length === 0 ? (
          <p className="empty-state">Noch keine Modelle verfügbar.</p>
        ) : null}
      </section>

      <section className="home-section">
        <header className="home-section__header">
          <h2>Neueste Bilder</h2>
          <p>Frisch gerenderte Referenzen inklusive Prompt-Auszügen.</p>
        </header>
        <div className="tile-grid">
          {isLoading && images.length === 0
            ? Array.from({ length: 4 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
            : imageTiles}
        </div>
        {!isLoading && imageTiles.length === 0 ? (
          <p className="empty-state">Noch keine Bilder vorhanden.</p>
        ) : null}
      </section>
    </div>
  );

  const renderContent = () => {
    if (activeView === 'models') {
      return (
        <AssetExplorer
          assets={assets}
          isLoading={isLoading}
          onStartUpload={() => setIsAssetUploadOpen(true)}
        />
      );
    }

    if (activeView === 'images') {
      return (
        <div className="content__stack">
          <ImageGallery images={images} isLoading={isLoading} />
          <GalleryExplorer
            galleries={galleries}
            isLoading={isLoading}
            onStartGalleryDraft={() => setIsGalleryUploadOpen(true)}
          />
        </div>
      );
    }

    return renderHome();
  };

  return (
    <div className="app">
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar__brand">
            <span className="sidebar__logo">VisionSuit</span>
            <span className="sidebar__tagline">AI Asset Control</span>
          </div>
          <nav className="sidebar__nav" aria-label="Hauptnavigation">
            {(Object.keys(viewMeta) as ViewKey[]).map((view) => (
              <button
                key={view}
                type="button"
                className={`sidebar__nav-button${activeView === view ? ' sidebar__nav-button--active' : ''}`}
                onClick={() => setActiveView(view)}
              >
                {viewMeta[view].title}
              </button>
            ))}
          </nav>

          <div className="sidebar__status" aria-label="Service Status">
            <h2>Service Status</h2>
            <ul className="sidebar__status-list">
              {(['frontend', 'backend', 'minio'] as ServiceStatusKey[]).map((key) => {
                const entry = serviceStatus[key];
                return (
                  <li key={key} className="sidebar__status-item">
                    <div className="sidebar__status-header">
                      <span>{entry.label}</span>
                      <span className={`status-pill status-pill--${entry.status}`}>{statusLabels[entry.status]}</span>
                    </div>
                    <p>{entry.message}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        <div className="content">
          <div className="content__inner">
            {toast ? (
              <div className={`toast toast--${toast.type}`} role="status">
                {toast.message}
              </div>
            ) : null}

            <header className="content__header">
              <div>
                <h1 className="content__title">{viewMeta[activeView].title}</h1>
                <p className="content__subtitle">{viewMeta[activeView].description}</p>
              </div>
              <div className="content__actions">
                <button type="button" className="content__action" onClick={() => refreshData()}>
                  Aktualisieren
                </button>
                <button
                  type="button"
                  className="content__action content__action--primary"
                  onClick={() => setIsAssetUploadOpen(true)}
                >
                  Upload starten
                </button>
              </div>
            </header>

            {errorMessage ? <div className="content__alert">{errorMessage}</div> : null}

            {renderContent()}
          </div>
        </div>
      </div>

      <UploadWizard
        mode="asset"
        isOpen={isAssetUploadOpen}
        onClose={() => setIsAssetUploadOpen(false)}
        onComplete={handleWizardCompletion}
      />
      <UploadWizard
        mode="gallery"
        isOpen={isGalleryUploadOpen}
        onClose={() => setIsGalleryUploadOpen(false)}
        onComplete={handleWizardCompletion}
      />
    </div>
  );
};

export default App;
