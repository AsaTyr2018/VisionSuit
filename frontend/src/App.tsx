import { useCallback, useEffect, useMemo, useState } from 'react';

import { AssetExplorer } from './components/AssetExplorer';
import { GalleryExplorer } from './components/GalleryExplorer';
import { UploadWizard } from './components/UploadWizard';
import type { UploadWizardResult } from './components/UploadWizard';
import { LoginDialog } from './components/LoginDialog';
import { RegisterDialog } from './components/RegisterDialog';
import { AdminPanel } from './components/AdminPanel';
import { UserProfile as UserProfileView } from './components/UserProfile';
import { AccountSettingsDialog } from './components/AccountSettingsDialog';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { resolveStorageUrl } from './lib/storage';
import type {
  Gallery,
  ImageAsset,
  ModelAsset,
  RankTier,
  RankingSettings,
  Tag,
  User,
  UserProfile as UserProfileData,
} from './types/api';

type ViewKey = 'home' | 'models' | 'images' | 'admin' | 'profile';
type PrimaryViewKey = 'home' | 'models' | 'images' | 'admin';
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
      'Guided control center with filters and bulk tools for accounts, models, images, galleries, and rankings.',
  },
  profile: {
    title: 'Curator profile',
    description: 'Contribution overview for a selected curator.',
  },
};

const statusLabels: Record<ServiceState, string> = {
  online: 'Online',
  offline: 'Offline',
  degraded: 'Degraded',
  unknown: 'Unknown',
};

const serviceBadgeLabels: Record<ServiceStatusKey, string> = {
  frontend: 'UI',
  backend: 'API',
  minio: 'S3',
};

const createInitialStatus = (): Record<ServiceStatusKey, ServiceIndicator> => ({
  frontend: { label: 'Frontend', status: 'online', message: 'UI active.' },
  backend: { label: 'Backend', status: 'unknown', message: 'Status check in progress…' },
  minio: { label: 'MinIO', status: 'unknown', message: 'Status check in progress…' },
});

export const App = () => {
  const { user: authUser, token, isAuthenticated, login, logout, refreshUser } = useAuth();
  const [activeView, setActiveView] = useState<ViewKey>('home');
  const [returnView, setReturnView] = useState<PrimaryViewKey>('home');
  const [assets, setAssets] = useState<ModelAsset[]>([]);
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [rankingSettings, setRankingSettings] = useState<RankingSettings | null>(null);
  const [rankingTiers, setRankingTiers] = useState<RankTier[]>([]);
  const [rankingTiersFallback, setRankingTiersFallback] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  const [isGalleryUploadOpen, setIsGalleryUploadOpen] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [serviceStatus, setServiceStatus] = useState<Record<ServiceStatusKey, ServiceIndicator>>(createInitialStatus);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [focusedGalleryId, setFocusedGalleryId] = useState<string | null>(null);
  const [modelTagQuery, setModelTagQuery] = useState<string | null>(null);
  const [imageTagQuery, setImageTagQuery] = useState<string | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [activeProfile, setActiveProfile] = useState<UserProfileData | null>(null);
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const [isProfileAuditMode, setIsProfileAuditMode] = useState(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);
  const availableViews = useMemo<PrimaryViewKey[]>(() => {
    const views: PrimaryViewKey[] = ['home', 'models', 'images'];
    if (authUser?.role === 'ADMIN') {
      views.push('admin');
    }
    return views;
  }, [authUser?.role]);

  const openPrimaryView = useCallback((view: PrimaryViewKey) => {
    setReturnView(view);
    setActiveProfileId(null);
    setActiveProfile(null);
    setProfileError(null);
    setActiveView(view);
  }, []);

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
        api.getModelAssets(token),
        api.getGalleries(token),
        api.getImageAssets(token),
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

        try {
          const { settings } = await api.getRankingSettings(token);
          setRankingSettings(settings);
        } catch (settingsError) {
          console.error('Failed to load ranking settings', settingsError);
          setRankingSettings(null);
        }

        try {
          const { tiers, isFallback } = await api.getRankTiers(token);
          setRankingTiers(tiers);
          setRankingTiersFallback(isFallback);
        } catch (tierError) {
          console.error('Failed to load rank tiers', tierError);
          setRankingTiers([]);
          setRankingTiersFallback(false);
        }
      } else {
        setUsers([]);
        setRankingSettings(null);
        setRankingTiers([]);
        setRankingTiersFallback(false);
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
      openPrimaryView('home');
    }
  }, [activeView, authUser?.role, openPrimaryView]);

  useEffect(() => {
    if (!activeProfileId) {
      setActiveProfile(null);
      setProfileError(null);
      setIsProfileLoading(false);
      return;
    }

    let isActive = true;
    setIsProfileLoading(true);
    setProfileError(null);

    const shouldAudit = authUser?.role === 'ADMIN' && isProfileAuditMode;

    api
      .getUserProfile(activeProfileId, { token: token ?? undefined, audit: shouldAudit })
      .then(({ profile }) => {
        if (!isActive) {
          return;
        }
        setActiveProfile(profile);
        if (profile.visibility) {
          setIsProfileAuditMode(profile.visibility.audit);
        }
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }
        console.error('Failed to load user profile', error);
        setProfileError('Failed to load curator profile. Please try again.');
      })
      .finally(() => {
        if (isActive) {
          setIsProfileLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [activeProfileId, profileReloadKey, token, authUser?.role, isProfileAuditMode]);

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
    if (!isRegisterOpen) {
      setRegisterError(null);
    }
  }, [isRegisterOpen]);

  useEffect(() => {
    if (!isAuthenticated) {
      setIsAssetUploadOpen(false);
      setIsGalleryUploadOpen(false);
      setIsAccountSettingsOpen(false);
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

  const handleGalleryUpdated = useCallback((updatedGallery: Gallery) => {
    setGalleries((previous) => {
      const index = previous.findIndex((gallery) => gallery.id === updatedGallery.id);
      if (index === -1) {
        return previous;
      }
      const next = [...previous];
      next[index] = updatedGallery;
      return next;
    });
  }, []);

  const handleImageUpdated = useCallback((updatedImage: ImageAsset) => {
    setImages((previous) => {
      const index = previous.findIndex((image) => image.id === updatedImage.id);
      if (index === -1) {
        return previous;
      }
      const next = [...previous];
      next[index] = updatedImage;
      return next;
    });
    setGalleries((previous) => {
      let hasChanges = false;
      const next = previous.map((gallery) => {
        let galleryChanged = false;
        const entries = gallery.entries.map((entry) => {
          if (entry.imageAsset && entry.imageAsset.id === updatedImage.id) {
            galleryChanged = true;
            return { ...entry, imageAsset: updatedImage };
          }
          return entry;
        });
        if (galleryChanged) {
          hasChanges = true;
          return { ...gallery, entries };
        }
        return gallery;
      });
      return hasChanges ? next : previous;
    });
  }, []);

  const handleAssetDeleted = useCallback(
    (assetId: string) => {
      setAssets((previous) => previous.filter((asset) => asset.id !== assetId));
      setGalleries((previous) =>
        previous.map((gallery) => ({
          ...gallery,
          entries: gallery.entries.filter((entry) => entry.modelAsset?.id !== assetId),
        })),
      );
      refreshData().catch((error) => console.error('Failed to refresh after model deletion', error));
    },
    [refreshData],
  );

  const handleGalleryDeleted = useCallback(
    (galleryId: string) => {
      setGalleries((previous) => previous.filter((gallery) => gallery.id !== galleryId));
      refreshData().catch((error) => console.error('Failed to refresh after gallery deletion', error));
    },
    [refreshData],
  );

  const handleImageDeleted = useCallback(
    (imageId: string) => {
      setImages((previous) => previous.filter((image) => image.id !== imageId));
      setGalleries((previous) =>
        previous.map((gallery) => ({
          ...gallery,
          entries: gallery.entries.filter((entry) => entry.imageAsset?.id !== imageId),
        })),
      );
      refreshData().catch((error) => console.error('Failed to refresh after image deletion', error));
    },
    [refreshData],
  );

  const handleOpenAssetUpload = () => {
    if (!isAuthenticated) {
      setIsLoginOpen(true);
      return;
    }
    if (authUser?.role === 'USER') {
      setToast({
        type: 'error',
        message: 'Uploads are limited to curators. Contact an administrator to request an upgrade.',
      });
      return;
    }
    setIsAssetUploadOpen(true);
  };

  const handleOpenGalleryUpload = () => {
    if (!isAuthenticated) {
      setIsLoginOpen(true);
      return;
    }
    if (authUser?.role === 'USER') {
      setToast({
        type: 'error',
        message: 'Uploads are limited to curators. Contact an administrator to request an upgrade.',
      });
      return;
    }
    setIsGalleryUploadOpen(true);
  };

  const handleNavigateToGallery = (galleryId: string) => {
    setFocusedGalleryId(galleryId);
    setFocusedAssetId(null);
    openPrimaryView('images');
  };

  const handleNavigateToModel = (modelId: string) => {
    setFocusedAssetId(modelId);
    setFocusedGalleryId(null);
    openPrimaryView('models');
  };

  const handleModelTagClick = useCallback((tag: Tag) => {
    setFocusedAssetId(null);
    setModelTagQuery(tag.label);
    openPrimaryView('models');
  }, [openPrimaryView]);

  const handleImageTagClick = useCallback((tag: Tag) => {
    setFocusedGalleryId(null);
    setImageTagQuery(tag.label);
    openPrimaryView('images');
  }, [openPrimaryView]);

  const handleModelCardClick = useCallback((modelId: string) => {
    setFocusedGalleryId(null);
    setFocusedAssetId(modelId);
    openPrimaryView('models');
  }, [openPrimaryView]);

  const handleImageCardClick = useCallback(
    (imageId: string) => {
      setFocusedAssetId(null);
      const matchedGallery =
        galleries.find((gallery) =>
          gallery.entries.some((entry) => entry.imageAsset?.id === imageId),
        ) ?? null;
      setFocusedGalleryId(matchedGallery?.id ?? null);
      openPrimaryView('images');
    },
    [galleries, openPrimaryView],
  );

  const handleOpenUserProfile = useCallback(
    (userId: string) => {
      if (activeView !== 'profile') {
        setReturnView(activeView);
      }
      setActiveProfileId(userId);
      setActiveProfile((previous) => (previous?.id === userId ? previous : null));
      setProfileError(null);
      setIsProfileAuditMode(false);
      setActiveView('profile');
    },
    [activeView],
  );

  const handleCloseProfile = useCallback(() => {
    openPrimaryView(returnView);
    setActiveProfileId(null);
    setIsProfileAuditMode(false);
  }, [openPrimaryView, returnView]);

  const handleRefreshProfile = useCallback(() => {
    if (!activeProfileId) {
      return;
    }
    setProfileReloadKey((previous) => previous + 1);
  }, [activeProfileId]);

  const handleToggleProfileAudit = useCallback(() => {
    if (!authUser || authUser.role !== 'ADMIN') {
      return;
    }
    setIsProfileAuditMode((previous) => !previous);
  }, [authUser]);

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

  const handleRegisterSubmit = async ({
    email,
    displayName,
    password,
  }: {
    email: string;
    displayName: string;
    password: string;
  }) => {
    setIsRegistering(true);
    setRegisterError(null);
    try {
      await api.register(email, displayName, password);
      await login(email, password);
      setIsRegisterOpen(false);
      setIsLoginOpen(false);
      setToast({ type: 'success', message: 'Account created successfully. Welcome aboard!' });
      await refreshData();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed.';
      setRegisterError(message);
      throw error;
    } finally {
      setIsRegistering(false);
    }
  };

  const handleLogout = () => {
    logout();
    setUsers([]);
    setActiveProfileId(null);
    setActiveProfile(null);
    setProfileError(null);
    setProfileReloadKey(0);
    setIsAccountSettingsOpen(false);
    openPrimaryView('home');
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
              <dd>
                <button
                  type="button"
                  className="curator-link"
                  onClick={() => handleOpenUserProfile(asset.owner.id)}
                >
                  {asset.owner.displayName}
                </button>
              </dd>
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
              <dd>
                <button
                  type="button"
                  className="curator-link"
                  onClick={() => handleOpenUserProfile(image.owner.id)}
                >
                  {image.owner.displayName}
                </button>
              </dd>
            </div>
            <div>
              <dt>Likes</dt>
              <dd className={`home-card__likes${image.viewerHasLiked ? ' home-card__likes--active' : ''}`}>
                {image.likeCount}
              </dd>
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
          onOpenProfile={handleOpenUserProfile}
          rankingSettings={rankingSettings}
          rankingTiers={rankingTiers}
          rankingTiersFallback={rankingTiersFallback}
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
          onAssetDeleted={handleAssetDeleted}
          authToken={token}
          currentUser={authUser}
          onOpenProfile={handleOpenUserProfile}
          onGalleryUpdated={handleGalleryUpdated}
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
          authToken={token}
          currentUser={authUser}
          onGalleryUpdated={handleGalleryUpdated}
          onImageUpdated={handleImageUpdated}
          onOpenProfile={handleOpenUserProfile}
          onGalleryDeleted={handleGalleryDeleted}
          onImageDeleted={handleImageDeleted}
        />
      );
    }

    if (activeView === 'profile') {
      return (
        <UserProfileView
          profile={activeProfile}
          isLoading={isProfileLoading}
          error={profileError}
          onBack={handleCloseProfile}
          onRetry={handleRefreshProfile}
          onOpenModel={handleNavigateToModel}
          onOpenGallery={handleNavigateToGallery}
          canAudit={authUser?.role === 'ADMIN' && Boolean(activeProfileId)}
          isAuditActive={activeProfile?.visibility?.audit ?? (authUser?.role === 'ADMIN' && isProfileAuditMode)}
          onToggleAudit={handleToggleProfileAudit}
        />
      );
    }

    return renderHome();
  };

  const currentMeta = viewMeta[activeView];
  const headerTitle =
    activeView === 'profile' && activeProfile ? activeProfile.displayName : currentMeta.title;
  const headerDescription =
    activeView === 'profile' && activeProfile
      ? `Featuring ${activeProfile.stats.modelCount} model${activeProfile.stats.modelCount === 1 ? '' : 's'} and ${activeProfile.stats.galleryCount} collection${activeProfile.stats.galleryCount === 1 ? '' : 's'}.`
      : currentMeta.description;

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
                onClick={() => openPrimaryView(view)}
              >
                {viewMeta[view].title}
              </button>
            ))}
          </nav>

          <div className="sidebar__auth">
            {isAuthenticated ? (
              <>
                <p className="sidebar__auth-name">{authUser?.displayName}</p>
                <p className="sidebar__auth-role">
                  {authUser?.role === 'ADMIN'
                    ? 'Administrator'
                    : authUser?.role === 'CURATOR'
                      ? 'Curator'
                      : 'Member'}
                </p>
                <div className="sidebar__auth-actions">
                  <button
                    type="button"
                    className="sidebar__auth-button sidebar__auth-button--primary"
                    onClick={() => setIsAccountSettingsOpen(true)}
                    disabled={isLoggingIn}
                  >
                    Manage account
                  </button>
                  <button type="button" className="sidebar__auth-button" onClick={handleLogout} disabled={isLoggingIn}>
                    Sign out
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="sidebar__auth-button sidebar__auth-button--primary"
                  onClick={() => setIsLoginOpen(true)}
                  disabled={isLoggingIn || isRegistering}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className="sidebar__auth-button"
                  onClick={() => {
                    setIsRegisterOpen(true);
                    setRegisterError(null);
                  }}
                  disabled={isLoggingIn || isRegistering}
                >
                  Create account
                </button>
              </>
            )}
          </div>

          <div className="sidebar__status" aria-label="Service Status">
            <h2>Service Status</h2>
            <ul className="sidebar__status-list">
              {(['frontend', 'backend', 'minio'] as ServiceStatusKey[]).map((key) => {
                const entry = serviceStatus[key];
                return (
                  <li key={key} className={`sidebar__status-item sidebar__status-item--${entry.status}`}>
                    <span className={`sidebar__status-icon sidebar__status-icon--${key}`} aria-hidden="true">
                      {serviceBadgeLabels[key]}
                    </span>
                    <div className="sidebar__status-content">
                      <div className="sidebar__status-header">
                        <span className="sidebar__status-title">{entry.label}</span>
                        <span className="status-led-wrapper">
                          <span className={`status-led status-led--${entry.status}`} aria-hidden="true" />
                          <span className="visually-hidden">{statusLabels[entry.status]}</span>
                        </span>
                      </div>
                      <p className="sidebar__status-message">{entry.message}</p>
                    </div>
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
                <h1 className="content__title">{headerTitle}</h1>
                <p className="content__subtitle">{headerDescription}</p>
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
      {isAuthenticated && token && authUser ? (
        <AccountSettingsDialog
          isOpen={isAccountSettingsOpen}
          onClose={() => setIsAccountSettingsOpen(false)}
          token={token}
          user={authUser}
          onRefreshUser={refreshUser}
          onProfileSaved={(message) => {
            setToast({ type: 'success', message });
          }}
          onPasswordChanged={(message) => {
            setToast({ type: 'success', message });
          }}
        />
      ) : null}
      <LoginDialog
        isOpen={isLoginOpen}
        onClose={() => setIsLoginOpen(false)}
        onSubmit={handleLoginSubmit}
        isSubmitting={isLoggingIn}
        errorMessage={loginError}
      />
      <RegisterDialog
        isOpen={isRegisterOpen}
        onClose={() => setIsRegisterOpen(false)}
        onSubmit={handleRegisterSubmit}
        isSubmitting={isRegistering}
        errorMessage={registerError}
      />
    </div>
  );
};

export default App;
