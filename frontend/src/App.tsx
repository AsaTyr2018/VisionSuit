import { useCallback, useEffect, useMemo, useState } from 'react';

import { AssetExplorer } from './components/AssetExplorer';
import { GalleryExplorer } from './components/GalleryExplorer';
import { UploadWizard } from './components/UploadWizard';
import type { UploadWizardResult } from './components/UploadWizard';
import { LoginDialog } from './components/LoginDialog';
import { AdminPanel } from './components/AdminPanel';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { resolveStorageUrl } from './lib/storage';
import type { Gallery, ImageAsset, ModelAsset, Tag, User } from './types/api';

type ViewKey = 'home' | 'models' | 'images' | 'admin';
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
    description: 'Overview of recent models and image uploads—synchronized with the backend and storage.',
  },
  models: {
    title: 'Models',
    description: 'LoRA explorer with full-text search, type filters, and curator tooling.',
  },
  images: {
    title: 'Images',
    description: 'Image gallery with prompt details and curated sets for presentations.',
  },
  admin: {
    title: 'Administration',
    description:
      'Guided control center with filters and bulk tools for accounts, models, images, and galleries.',
  },
};

const statusLabels: Record<ServiceState, string> = {
  online: 'Online',
  offline: 'Offline',
  degraded: 'Degraded',
  unknown: 'Unknown',
};

const createInitialStatus = (): Record<ServiceStatusKey, ServiceIndicator> => ({
  frontend: { label: 'Frontend', status: 'online', message: 'UI active.' },
  backend: { label: 'Backend', status: 'unknown', message: 'Status check in progress…' },
  minio: { label: 'MinIO', status: 'unknown', message: 'Status check in progress…' },
});

export const App = () => {
  const { user: authUser, token, isAuthenticated, login, logout } = useAuth();
  const [activeView, setActiveView] = useState<ViewKey>('home');
  const [assets, setAssets] = useState<ModelAsset[]>([]);
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  const [isGalleryUploadOpen, setIsGalleryUploadOpen] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [serviceStatus, setServiceStatus] = useState<Record<ServiceStatusKey, ServiceIndicator>>(createInitialStatus);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [focusedGalleryId, setFocusedGalleryId] = useState<string | null>(null);
  const [modelTagQuery, setModelTagQuery] = useState<string | null>(null);
  const [imageTagQuery, setImageTagQuery] = useState<string | null>(null);
  const availableViews = useMemo<ViewKey[]>(() => {
    const views: ViewKey[] = ['home', 'models', 'images'];
    if (authUser?.role === 'ADMIN') {
      views.push('admin');
    }
    return views;
  }, [authUser?.role]);

  const fetchServiceStatus = useCallback(async () => {
    try {
      const status = await api.getServiceStatus();
      setServiceStatus({
        frontend: { label: 'Frontend', status: 'online', message: 'UI active.' },
        backend: {
          label: 'Backend',
          status: status.services.backend.status ?? 'online',
          message: status.services.backend.message ?? 'API available.',
        },
        minio: {
          label: 'MinIO',
          status: status.services.minio.status ?? 'online',
          message: status.services.minio.message ?? 'Storage available.',
        },
      });
    } catch (error) {
      console.error('Service status fetch failed', error);
      setServiceStatus({
        frontend: { label: 'Frontend', status: 'online', message: 'UI active.' },
        backend: { label: 'Backend', status: 'offline', message: 'Backend unavailable.' },
        minio: { label: 'MinIO', status: 'offline', message: 'Storage unavailable.' },
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
      if (token && authUser?.role === 'ADMIN') {
        try {
          const { users: fetchedUsers } = await api.getUsers(token);
          setUsers(fetchedUsers);
        } catch (userError) {
          console.error('Failed to load users', userError);
          setUsers([]);
        }
      } else {
        setUsers([]);
      }
      setErrorMessage(null);
    } catch (error) {
      console.error(error);
      setErrorMessage('Backend not reachable yet. Please check the server or try again later.');
      setUsers([]);
    } finally {
      setIsLoading(false);
    }

    fetchServiceStatus().catch((statusError) => console.error('Failed to refresh service status', statusError));
  }, [fetchServiceStatus, token, authUser?.role]);

  useEffect(() => {
    refreshData().catch((error) => console.error('Unexpected fetch error', error));
  }, [refreshData]);

  useEffect(() => {
    if (activeView === 'admin' && authUser?.role !== 'ADMIN') {
      setActiveView('home');
    }
  }, [activeView, authUser?.role]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!isLoginOpen) {
      setLoginError(null);
    }
  }, [isLoginOpen]);

  useEffect(() => {
    if (!isAuthenticated) {
      setIsAssetUploadOpen(false);
      setIsGalleryUploadOpen(false);
    }
  }, [isAuthenticated]);

  const handleWizardCompletion = (result: UploadWizardResult) => {
    if (result.status === 'success') {
      setToast({
        type: 'success',
        message:
          result.message ??
          'Upload session created. Content will appear after the background analysis finishes.',
      });
      refreshData().catch((error) => console.error('Failed to refresh after upload', error));
    } else {
      setToast({ type: 'error', message: result.message });
    }
  };

  const handleAssetUpdated = useCallback((updatedAsset: ModelAsset) => {
    setAssets((previous) => {
      const index = previous.findIndex((asset) => asset.id === updatedAsset.id);
      if (index === -1) {
        return previous;
      }
      const next = [...previous];
      next[index] = updatedAsset;
      return next;
    });
  }, []);

  const handleOpenAssetUpload = () => {
    if (!isAuthenticated) {
      setIsLoginOpen(true);
      return;
    }
    setIsAssetUploadOpen(true);
  };

  const handleOpenGalleryUpload = () => {
    if (!isAuthenticated) {
      setIsLoginOpen(true);
      return;
    }
    setIsGalleryUploadOpen(true);
  };

  const handleNavigateToGallery = (galleryId: string) => {
    setFocusedGalleryId(galleryId);
    setFocusedAssetId(null);
    setActiveView('images');
  };

  const handleNavigateToModel = (modelId: string) => {
    setFocusedAssetId(modelId);
    setFocusedGalleryId(null);
    setActiveView('models');
  };

  const handleModelTagClick = useCallback((tag: Tag) => {
    setFocusedAssetId(null);
    setModelTagQuery(tag.label);
    setActiveView('models');
  }, []);

  const handleImageTagClick = useCallback((tag: Tag) => {
    setFocusedGalleryId(null);
    setImageTagQuery(tag.label);
    setActiveView('images');
  }, []);

  const handleModelCardClick = useCallback((modelId: string) => {
    setFocusedGalleryId(null);
    setFocusedAssetId(modelId);
    setActiveView('models');
  }, []);

  const handleImageCardClick = useCallback(
    (imageId: string) => {
      setFocusedAssetId(null);
      const matchedGallery =
        galleries.find((gallery) =>
          gallery.entries.some((entry) => entry.imageAsset?.id === imageId),
        ) ?? null;
      setFocusedGalleryId(matchedGallery?.id ?? null);
      setActiveView('images');
    },
    [galleries],
  );

  const handleLoginSubmit = async (email: string, password: string) => {
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      await login(email, password);
      setIsLoginOpen(false);
      setLoginError(null);
      await refreshData();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sign in failed.';
      setLoginError(message);
      throw error;
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    logout();
    setUsers([]);
    setActiveView('home');
    refreshData().catch((error) => console.error('Failed to refresh after logout', error));
  };

  const latestModels = useMemo(() => assets.slice(0, 5), [assets]);
  const latestImages = useMemo(() => images.slice(0, 5), [images]);

  const modelTiles = latestModels.map((asset) => {
    const previewUrl =
      resolveStorageUrl(asset.previewImage, asset.previewImageBucket, asset.previewImageObject) ?? asset.previewImage;
    const modelType = asset.tags.find((tag) => tag.category === 'model-type');
    const regularTags = asset.tags.filter((tag) => tag.id !== modelType?.id);
    const visibleTags = regularTags.slice(0, 5);
    const remainingTagCount = regularTags.length - visibleTags.length;

    return (
      <article key={asset.id} className="home-card home-card--model">
        <div className="home-card__media">
          <button
            type="button"
            className="home-card__media-button"
            onClick={() => handleModelCardClick(asset.id)}
            aria-label={`Open ${asset.title} in the model explorer`}
          >
            {previewUrl ? (
              <img src={previewUrl} alt={asset.title} loading="lazy" />
            ) : (
              <span className="home-card__placeholder">No preview available</span>
            )}
          </button>
        </div>
        <div className="home-card__body">
          <h3 className="home-card__title">{asset.title}</h3>
          <dl className="home-card__meta">
            <div>
              <dt>Model</dt>
              <dd>{modelType?.label ?? 'LoRA-Asset'}</dd>
            </div>
            <div>
              <dt>Curator</dt>
              <dd>{asset.owner.displayName}</dd>
            </div>
          </dl>
          {visibleTags.length > 0 ? (
            <ul className="home-card__tags">
              {visibleTags.map((tag) => (
                <li key={tag.id}>
                  <button
                    type="button"
                    className="home-card__tag"
                    onClick={() => handleModelTagClick(tag)}
                  >
                    #{tag.label}
                  </button>
                </li>
              ))}
              {remainingTagCount > 0 ? <li className="home-card__tags-more">+{remainingTagCount}</li> : null}
            </ul>
          ) : (
            <p className="home-card__tags-empty">No tags assigned yet.</p>
          )}
        </div>
      </article>
    );
  });

  const imageTiles = latestImages.map((image) => {
    const imageUrl =
      resolveStorageUrl(image.storagePath, image.storageBucket, image.storageObject) ?? image.storagePath;
    const visibleTags = image.tags.slice(0, 5);
    const remainingTagCount = image.tags.length - visibleTags.length;
    const matchedGallery = galleries.find((gallery) =>
      gallery.entries.some((entry) => entry.imageAsset?.id === image.id),
    );

    return (
      <article key={image.id} className="home-card home-card--image">
        <div className="home-card__media">
          <button
            type="button"
            className="home-card__media-button"
            onClick={() => handleImageCardClick(image.id)}
            aria-label={
              matchedGallery
                ? `Open ${matchedGallery.title} in the gallery explorer`
                : `Open gallery explorer for ${image.title}`
            }
          >
            {imageUrl ? (
              <img src={imageUrl} alt={image.title} loading="lazy" />
            ) : (
              <span className="home-card__placeholder">No image available</span>
            )}
          </button>
        </div>
        <div className="home-card__body">
          <h3 className="home-card__title">{image.title}</h3>
          <dl className="home-card__meta">
            <div>
              <dt>Model</dt>
              <dd>{image.metadata?.model ?? 'Unknown'}</dd>
            </div>
            <div>
              <dt>Curator</dt>
              <dd>{image.owner.displayName}</dd>
            </div>
          </dl>
          {visibleTags.length > 0 ? (
            <ul className="home-card__tags">
              {visibleTags.map((tag) => (
                <li key={tag.id}>
                  <button
                    type="button"
                    className="home-card__tag"
                    onClick={() => handleImageTagClick(tag)}
                  >
                    #{tag.label}
                  </button>
                </li>
              ))}
              {remainingTagCount > 0 ? <li className="home-card__tags-more">+{remainingTagCount}</li> : null}
            </ul>
          ) : (
            <p className="home-card__tags-empty">No tags assigned yet.</p>
          )}
        </div>
      </article>
    );
  });

  const renderHome = () => (
    <div className="home-grid">
      <section className="home-section">
        <header className="home-section__header">
          <h2>Latest models</h2>
          <p>The most recent uploads from the model explorer presented as compact tiles.</p>
        </header>
        <div className="home-section__grid">
          {isLoading && assets.length === 0
            ? Array.from({ length: 5 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
            : modelTiles}
        </div>
        {!isLoading && modelTiles.length === 0 ? (
          <p className="empty-state">No models available yet.</p>
        ) : null}
      </section>

      <section className="home-section">
        <header className="home-section__header">
          <h2>Latest images</h2>
          <p>Freshly rendered references including prompt excerpts.</p>
        </header>
        <div className="home-section__grid">
          {isLoading && images.length === 0
            ? Array.from({ length: 5 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
            : imageTiles}
        </div>
        {!isLoading && imageTiles.length === 0 ? (
          <p className="empty-state">No images available yet.</p>
        ) : null}
      </section>
    </div>
  );

  const renderContent = () => {
    if (activeView === 'admin') {
      if (!authUser || authUser.role !== 'ADMIN' || !token) {
        return <div className="content__alert">The admin area requires a signed-in admin account.</div>;
      }

      return (
        <AdminPanel
          users={users}
          models={assets}
          images={images}
          galleries={galleries}
          token={token}
          onRefresh={refreshData}
        />
      );
    }

    if (activeView === 'models') {
      return (
        <AssetExplorer
          assets={assets}
          galleries={galleries}
          isLoading={isLoading}
          onStartUpload={handleOpenAssetUpload}
          onNavigateToGallery={handleNavigateToGallery}
          initialAssetId={focusedAssetId}
          onCloseDetail={() => setFocusedAssetId(null)}
          externalSearchQuery={modelTagQuery}
          onExternalSearchApplied={() => setModelTagQuery(null)}
          onAssetUpdated={handleAssetUpdated}
          authToken={token}
          currentUser={authUser}
        />
      );
    }

    if (activeView === 'images') {
      return (
        <GalleryExplorer
          galleries={galleries}
          isLoading={isLoading}
          onStartGalleryDraft={handleOpenGalleryUpload}
          onNavigateToModel={handleNavigateToModel}
          initialGalleryId={focusedGalleryId}
          onCloseDetail={() => setFocusedGalleryId(null)}
          externalSearchQuery={imageTagQuery}
          onExternalSearchApplied={() => setImageTagQuery(null)}
        />
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
          <nav className="sidebar__nav" aria-label="Main navigation">
            {availableViews.map((view) => (
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

          <div className="sidebar__auth">
            {isAuthenticated ? (
              <>
                <p className="sidebar__auth-name">{authUser?.displayName}</p>
                <p className="sidebar__auth-role">{authUser?.role === 'ADMIN' ? 'Administrator' : 'Curator'}</p>
                <button type="button" className="sidebar__auth-button" onClick={handleLogout} disabled={isLoggingIn}>
                  Sign out
                </button>
              </>
            ) : (
              <button
                type="button"
                className="sidebar__auth-button sidebar__auth-button--primary"
                onClick={() => setIsLoginOpen(true)}
                disabled={isLoggingIn}
              >
                Sign in
              </button>
            )}
          </div>

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
      <LoginDialog
        isOpen={isLoginOpen}
        onClose={() => setIsLoginOpen(false)}
        onSubmit={handleLoginSubmit}
        isSubmitting={isLoggingIn}
        errorMessage={loginError}
      />
    </div>
  );
};

export default App;
