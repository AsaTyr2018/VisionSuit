import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent as ReactMouseEvent } from 'react';

import { AssetExplorer } from './components/AssetExplorer';
import { GalleryExplorer } from './components/GalleryExplorer';
import { UploadWizard } from './components/UploadWizard';
import type { UploadWizardResult } from './components/UploadWizard';
import { LoginDialog } from './components/LoginDialog';
import { RegisterDialog } from './components/RegisterDialog';
import { AdminPanel } from './components/AdminPanel';
import { OnSiteGenerator } from './components/OnSiteGenerator';
import { UserProfile as UserProfileView } from './components/UserProfile';
import { ServiceStatusPage } from './components/ServiceStatusPage';
import { AccountSettingsDialog } from './components/AccountSettingsDialog';
import { NotificationsCenter } from './components/NotificationsCenter';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { resolveCachedStorageUrl } from './lib/storage';
import { isAuditHiddenFromViewer, isAuditPlaceholderForViewer } from './lib/moderation';
import { buildApiUrl, defaultSiteTitle } from './config';
import type { ServiceIndicator, ServiceState, ServiceStatusKey } from './types/serviceStatus';
import type {
  Gallery,
  GeneratorSettings,
  ImageAsset,
  ModelAsset,
  RankTier,
  RankingSettings,
  Tag,
  User,
  UserProfile as UserProfileData,
  PlatformConfig,
  NotificationItem,
  NotificationCategory,
  NotificationStreamEvent,
  NotificationType,
} from './types/api';

type ViewKey =
  | 'home'
  | 'notifications'
  | 'models'
  | 'images'
  | 'generator'
  | 'admin'
  | 'profile'
  | 'status';
type PrimaryViewKey = 'home' | 'notifications' | 'models' | 'images' | 'generator' | 'admin';

const viewMeta: Record<ViewKey, { title: string; description: string }> = {
  home: {
    title: 'Home',
    description: 'Overview of recent models and image uploads—synchronized with the backend and storage.',
  },
  notifications: {
    title: 'Notifications',
    description: 'Stay on top of announcements, moderation updates, likes, and comments in real time.',
  },
  models: {
    title: 'Models',
    description: 'LoRA explorer with full-text search, type filters, and curator tooling.',
  },
  images: {
    title: 'Images',
    description: 'Image gallery with prompt details and curated sets for presentations.',
  },
  generator: {
    title: 'On-Site Generator',
    description:
      'Compose Stable Diffusion prompts, mix LoRAs, and queue render jobs for the GPU worker agent.',
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
  status: {
    title: 'Service status',
    description: 'Live health overview for the VisionSuit frontend, API, storage, and GPU services.',
  },
};

const statusLabels: Record<ServiceState, string> = {
  online: 'Online',
  offline: 'Offline',
  degraded: 'Degraded',
  unknown: 'Unknown',
  deactivated: 'Deactivated',
};

const serviceBadgeLabels: Record<ServiceStatusKey, string> = {
  frontend: 'UI',
  backend: 'API',
  minio: 'S3',
  gpu: 'GPU',
};

const DEFAULT_ASSET_PAGE_SIZE = 24;

const notificationCategories: NotificationCategory[] = ['announcements', 'moderation', 'likes', 'comments'];

const notificationTypeToCategory: Record<NotificationType, NotificationCategory> = {
  ANNOUNCEMENT: 'announcements',
  MODERATION: 'moderation',
  MODERATION_QUEUE: 'moderation',
  LIKE: 'likes',
  COMMENT: 'comments',
};

const createEmptyNotificationDeck = (): Record<NotificationCategory, NotificationItem[]> => ({
  announcements: [],
  moderation: [],
  likes: [],
  comments: [],
});

const createEmptyNotificationCounts = (): Record<NotificationCategory, number> => ({
  announcements: 0,
  moderation: 0,
  likes: 0,
  comments: 0,
});

const filterModelAssetsForViewer = (assets: ModelAsset[], viewer?: User | null) => {
  const isAdmin = viewer?.role === 'ADMIN';
  const allowAdult = isAdmin ? true : viewer?.showAdultContent ?? false;
  const filteredByAdult = assets.filter((asset) => {
    if (!asset.isAdult) {
      return true;
    }

    if (allowAdult) {
      return true;
    }

    if (viewer && asset.owner.id === viewer.id) {
      return true;
    }

    return false;
  });

  if (!viewer) {
    return filteredByAdult.filter((asset) => asset.moderationStatus !== 'REMOVED');
  }

  if (viewer.role === 'ADMIN') {
    return filteredByAdult;
  }

  return filteredByAdult.filter((asset) => {
    if (asset.moderationStatus === 'REMOVED') {
      return false;
    }

    const isHidden = isAuditHiddenFromViewer(asset.moderationStatus, asset.owner.id, viewer);
    if (isHidden) {
      return false;
    }

    if (asset.moderationStatus === 'FLAGGED') {
      return viewer?.role === 'ADMIN' || isAuditPlaceholderForViewer(asset.moderationStatus, asset.owner.id, viewer);
    }

    return true;
  });
};

const filterImageAssetsForViewer = (images: ImageAsset[], viewer?: User | null) => {
  const isAdmin = viewer?.role === 'ADMIN';
  const allowAdult = isAdmin ? true : viewer?.showAdultContent ?? false;
  const filteredByAdult = images.filter((image) => {
    if (!image.isAdult) {
      return true;
    }

    if (allowAdult) {
      return true;
    }

    if (viewer && image.owner.id === viewer.id) {
      return true;
    }

    return false;
  });

  if (!viewer) {
    return filteredByAdult.filter((image) => image.moderationStatus !== 'REMOVED');
  }

  if (viewer.role === 'ADMIN') {
    return filteredByAdult;
  }

  return filteredByAdult.filter((image) => {
    if (image.moderationStatus === 'REMOVED') {
      return false;
    }

    const isHidden = isAuditHiddenFromViewer(image.moderationStatus, image.owner.id, viewer);
    if (isHidden) {
      return false;
    }

    if (image.moderationStatus === 'FLAGGED') {
      return viewer?.role === 'ADMIN' || isAuditPlaceholderForViewer(image.moderationStatus, image.owner.id, viewer);
    }

    return true;
  });
};

const createInitialStatus = (): Record<ServiceStatusKey, ServiceIndicator> => ({
  frontend: { label: 'Frontend', status: 'online', message: 'UI active.' },
  backend: { label: 'Backend', status: 'unknown', message: 'Status check in progress…' },
  minio: { label: 'MinIO', status: 'unknown', message: 'Status check in progress…' },
  gpu: { label: 'GPU node', status: 'unknown', message: 'Status check in progress…' },
});

export const App = () => {
  const { user: authUser, token, isAuthenticated, login, logout, refreshUser } = useAuth();
  const [activeView, setActiveView] = useState<ViewKey>('home');
  const [returnView, setReturnView] = useState<PrimaryViewKey>('home');
  const [assets, setAssets] = useState<ModelAsset[]>([]);
  const [modelAssetsCursor, setModelAssetsCursor] = useState<string | null>(null);
  const [modelAssetsHasMore, setModelAssetsHasMore] = useState(false);
  const [isLoadingMoreModels, setIsLoadingMoreModels] = useState(false);
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [imageAssetsCursor, setImageAssetsCursor] = useState<string | null>(null);
  const [imageAssetsHasMore, setImageAssetsHasMore] = useState(false);
  const [isLoadingMoreImages, setIsLoadingMoreImages] = useState(false);
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
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig>({
    siteTitle: defaultSiteTitle,
    allowRegistration: true,
    maintenanceMode: false,
  });
  const [serviceStatus, setServiceStatus] = useState<Record<ServiceStatusKey, ServiceIndicator>>(createInitialStatus);
  const [notificationDeck, setNotificationDeck] = useState<Record<NotificationCategory, NotificationItem[]>>(createEmptyNotificationDeck);
  const [notificationUnread, setNotificationUnread] = useState<Record<NotificationCategory, number>>(createEmptyNotificationCounts);
  const [totalUnreadNotifications, setTotalUnreadNotifications] = useState(0);
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
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings | null>(null);
  const [isUpdatingAdultPreference, setIsUpdatingAdultPreference] = useState(false);
  const lastScrollY = useRef(0);
  const [isFooterVisible, setIsFooterVisible] = useState(true);
  const isGpuModuleEnabled = generatorSettings?.isGpuEnabled ?? true;
  const generatorAccessMode = generatorSettings?.accessMode ?? 'ADMIN_ONLY';

  const canAccessGenerator = useMemo(() => {
    if (!isGpuModuleEnabled) {
      return false;
    }

    if (!authUser || !isAuthenticated) {
      return false;
    }

    if (authUser.role === 'ADMIN') {
      return true;
    }

    return generatorAccessMode === 'MEMBERS';
  }, [authUser, generatorAccessMode, isAuthenticated, isGpuModuleEnabled]);

  const userRole = authUser?.role ?? null;
  const isAdminUser = userRole === 'ADMIN';
  const isMaintenanceLocked = platformConfig.maintenanceMode && !isAdminUser;

  const availableViews = useMemo<PrimaryViewKey[]>(() => {
    const views: PrimaryViewKey[] = ['home'];
    if (isAuthenticated) {
      views.push('notifications');
    }
    views.push('models', 'images');
    if (canAccessGenerator) {
      views.push('generator');
    }
    if (authUser?.role === 'ADMIN') {
      views.push('admin');
    }
    return views;
  }, [authUser?.role, canAccessGenerator, isAuthenticated]);

  useEffect(() => {
    if (!canAccessGenerator && activeView === 'generator') {
      setActiveView('home');
      setReturnView('home');
    }
  }, [activeView, canAccessGenerator]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    lastScrollY.current = window.scrollY;

    const handleScroll = () => {
      const currentY = window.scrollY;
      const delta = currentY - lastScrollY.current;

      if (Math.abs(delta) < 6) {
        lastScrollY.current = currentY;
        return;
      }

      if (delta > 0 && currentY > 80) {
        setIsFooterVisible((visible) => {
          if (!visible) {
            return visible;
          }
          return false;
        });
      } else {
        setIsFooterVisible((visible) => {
          if (visible) {
            return visible;
          }
          return true;
        });
      }

      lastScrollY.current = currentY;
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const openPrimaryView = useCallback((view: PrimaryViewKey) => {
    setReturnView(view);
    setActiveProfileId(null);
    setActiveProfile(null);
    setProfileError(null);
    setActiveView(view);
  }, []);

  const openStatusView = useCallback(() => {
    setActiveProfileId(null);
    setActiveProfile(null);
    setProfileError(null);
    setActiveView('status');
  }, []);

  const handleServiceStatusClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      openStatusView();
    },
    [openStatusView],
  );

  const handleGeneratorNotify = useCallback((payload: { type: 'success' | 'error'; message: string }) => {
    setToast(payload);
  }, []);

  const resolveFrontendIndicator = useCallback((): ServiceIndicator => {
    const isBrowserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    return {
      label: 'Frontend',
      status: isBrowserOnline ? 'online' : 'degraded',
      message: isBrowserOnline ? 'UI active.' : 'Browser offline. Check your connection.',
    };
  }, []);

  const fetchServiceStatus = useCallback(async () => {
    try {
      const status = await api.getServiceStatus();
      setServiceStatus({
        frontend: resolveFrontendIndicator(),
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
        gpu: {
          label: 'GPU node',
          status: status.services.gpu.status ?? 'unknown',
          message: status.services.gpu.message ?? 'GPU node status unknown.',
        },
      });
      return;
    } catch (error) {
      console.error('Service status fetch failed', error);
    }

    try {
      const [backendProbe, minioProbe, gpuProbe] = await Promise.allSettled([
        api.getBackendServiceStatus(),
        api.getMinioServiceStatus(),
        api.getGpuServiceStatus(),
      ]);

      setServiceStatus((previous) => {
        const previousStatus = previous ?? createInitialStatus();

        const backendIndicator =
          backendProbe.status === 'fulfilled'
            ? {
                label: 'Backend',
                status: backendProbe.value.service.status ?? 'online',
                message: backendProbe.value.service.message ?? 'API available.',
              }
            : {
                label: 'Backend',
                status: 'offline',
                message: 'Backend unavailable.',
              };

        const backendOffline = backendIndicator.status === 'offline';

        const minioIndicator =
          minioProbe.status === 'fulfilled'
            ? {
                label: 'MinIO',
                status: minioProbe.value.service.status ?? 'unknown',
                message: minioProbe.value.service.message ?? 'Storage status available.',
              }
            : {
                label: previousStatus.minio.label,
                status: 'unknown',
                message: backendOffline
                  ? 'Storage status unavailable while the backend is offline.'
                  : previousStatus.minio.message
                  ? `Storage probe unreachable. Last known: ${previousStatus.minio.message}`
                  : 'Storage status probe unreachable.',
              };

        const gpuIndicator =
          gpuProbe.status === 'fulfilled'
            ? {
                label: 'GPU node',
                status: gpuProbe.value.service.status ?? 'unknown',
                message: gpuProbe.value.service.message ?? 'GPU node status available.',
              }
            : {
                label: previousStatus.gpu.label,
                status: 'unknown',
                message: backendOffline
                  ? 'GPU status unavailable while the backend is offline.'
                  : previousStatus.gpu.message
                  ? `GPU probe unreachable. Last known: ${previousStatus.gpu.message}`
                  : 'GPU status probe unreachable.',
              };

        return {
          frontend: resolveFrontendIndicator(),
          backend: backendIndicator,
          minio: minioIndicator,
          gpu: gpuIndicator,
        };
      });
    } catch (probeError) {
      console.error('Service status fallback probes failed', probeError);
      setServiceStatus((previous) => {
        const previousStatus = previous ?? createInitialStatus();
        return {
          frontend: resolveFrontendIndicator(),
          backend: { label: 'Backend', status: 'offline', message: 'Backend unavailable.' },
          minio: {
            label: previousStatus.minio.label,
            status: 'unknown',
            message: 'Storage status unavailable while the backend is offline.',
          },
          gpu: {
            label: previousStatus.gpu.label,
            status: 'unknown',
            message: 'GPU status unavailable while the backend is offline.',
          },
        };
      });
    }
  }, [resolveFrontendIndicator]);

  const refreshData = useCallback(async () => {
    try {
      setIsLoading(true);
      setModelAssetsCursor(null);
      setModelAssetsHasMore(false);
      setImageAssetsCursor(null);
      setImageAssetsHasMore(false);

      const [modelResponse, fetchedGalleries, imageResponse] = await Promise.all([
        api.getModelAssets({ token: token ?? undefined, take: DEFAULT_ASSET_PAGE_SIZE }),
        api.getGalleries(token ?? undefined),
        api.getImageAssets({ token: token ?? undefined, take: DEFAULT_ASSET_PAGE_SIZE }),
      ]);

      setAssets(modelResponse.items);
      setModelAssetsCursor(modelResponse.nextCursor);
      setModelAssetsHasMore(modelResponse.hasMore);
      setGalleries(fetchedGalleries);
      setImages(imageResponse.items);
      setImageAssetsCursor(imageResponse.nextCursor);
      setImageAssetsHasMore(imageResponse.hasMore);
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

      if (token && isAuthenticated) {
        try {
          const notificationSummary = await api.getNotifications(token);
          setNotificationDeck(notificationSummary.notifications);
          setNotificationUnread(notificationSummary.unreadCounts);
          setTotalUnreadNotifications(notificationSummary.totalUnread);
        } catch (notificationError) {
          console.error('Failed to load notifications', notificationError);
          setNotificationDeck(createEmptyNotificationDeck());
          setNotificationUnread(createEmptyNotificationCounts());
          setTotalUnreadNotifications(0);
        }
      } else {
        setNotificationDeck(createEmptyNotificationDeck());
        setNotificationUnread(createEmptyNotificationCounts());
        setTotalUnreadNotifications(0);
      }
      setErrorMessage(null);
    } catch (error) {
      console.error(error);
      setErrorMessage('Backend not reachable yet. Please check the server or try again later.');
      setUsers([]);
      setModelAssetsCursor(null);
      setModelAssetsHasMore(false);
      setImageAssetsCursor(null);
      setImageAssetsHasMore(false);
    } finally {
      setIsLoading(false);
    }

    fetchServiceStatus().catch((statusError) => console.error('Failed to refresh service status', statusError));
  }, [fetchServiceStatus, token, authUser?.role, isAuthenticated]);

  const loadMoreModelAssets = useCallback(async () => {
    if (isLoadingMoreModels || !modelAssetsHasMore) {
      return;
    }

    setIsLoadingMoreModels(true);
    try {
      const response = await api.getModelAssets({
        token: token ?? undefined,
        cursor: modelAssetsCursor ?? undefined,
        take: DEFAULT_ASSET_PAGE_SIZE,
      });

      setAssets((previous) => {
        if (response.items.length === 0) {
          return previous;
        }

        const seen = new Set(previous.map((asset) => asset.id));
        const nextItems = response.items.filter((asset) => !seen.has(asset.id));
        if (nextItems.length === 0) {
          return previous;
        }

        return [...previous, ...nextItems];
      });

      setModelAssetsCursor(response.nextCursor);
      setModelAssetsHasMore(response.hasMore);
    } catch (error) {
      console.error('Failed to load additional model assets', error);
      setModelAssetsHasMore(false);
    } finally {
      setIsLoadingMoreModels(false);
    }
  }, [isLoadingMoreModels, modelAssetsHasMore, modelAssetsCursor, token]);

  const loadMoreImageAssets = useCallback(async () => {
    if (isLoadingMoreImages || !imageAssetsHasMore) {
      return;
    }

    setIsLoadingMoreImages(true);
    try {
      const response = await api.getImageAssets({
        token: token ?? undefined,
        cursor: imageAssetsCursor ?? undefined,
        take: DEFAULT_ASSET_PAGE_SIZE,
      });

      setImages((previous) => {
        if (response.items.length === 0) {
          return previous;
        }

        const seen = new Set(previous.map((image) => image.id));
        const nextItems = response.items.filter((image) => !seen.has(image.id));
        if (nextItems.length === 0) {
          return previous;
        }

        return [...previous, ...nextItems];
      });

      setImageAssetsCursor(response.nextCursor);
      setImageAssetsHasMore(response.hasMore);
    } catch (error) {
      console.error('Failed to load additional image assets', error);
      setImageAssetsHasMore(false);
    } finally {
      setIsLoadingMoreImages(false);
    }
  }, [imageAssetsCursor, imageAssetsHasMore, isLoadingMoreImages, token]);

  const handleMarkNotificationRead = useCallback(
    async (notification: NotificationItem, category: NotificationCategory) => {
      if (!token) {
        return;
      }

      try {
        const response = await api.markNotificationRead(token, notification.id);
        const resolvedCategory = notificationTypeToCategory[response.notification.type];

        setNotificationDeck((previous) => {
          const updated: Record<NotificationCategory, NotificationItem[]> = { ...previous };
          const categoriesToUpdate = new Set<NotificationCategory>([category, resolvedCategory]);
          for (const key of categoriesToUpdate) {
            const current = previous[key] ?? [];
            updated[key] = current.map((entry) =>
              entry.id === response.notification.id ? response.notification : entry,
            );
          }
          return updated;
        });
        setNotificationUnread(response.unreadCounts);
        setTotalUnreadNotifications(response.totalUnread);
      } catch (error) {
        console.error('Failed to mark notification as read', error);
        setToast({ type: 'error', message: 'Unable to update notification.' });
      }
    },
    [token, setToast],
  );

  const handleMarkCategoryRead = useCallback(
    async (category: NotificationCategory | null) => {
      if (!token) {
        return;
      }

      try {
        const response = await api.markNotificationsRead(token, category ?? undefined);
        const updatedIds = new Set(response.updatedIds);

        if (updatedIds.size > 0) {
          setNotificationDeck((previous) => {
            const updated: Record<NotificationCategory, NotificationItem[]> = { ...previous };
            const categoriesToProcess = category ? [category] : notificationCategories;
            const timestamp = new Date().toISOString();

            for (const key of categoriesToProcess) {
              updated[key] = previous[key].map((entry) =>
                updatedIds.has(entry.id)
                  ? { ...entry, readAt: entry.readAt ?? timestamp }
                  : entry,
              );
            }

            return updated;
          });
        }

        setNotificationUnread(response.unreadCounts);
        setTotalUnreadNotifications(response.totalUnread);
      } catch (error) {
        console.error('Failed to update notifications', error);
        setToast({ type: 'error', message: 'Unable to update notifications.' });
      }
    },
    [token, setToast],
  );

  useEffect(() => {
    let isActive = true;

    api
      .getPlatformConfig()
      .then((config) => {
        if (isActive) {
          setPlatformConfig(config);
        }
      })
      .catch((error) => {
        if (process.env.NODE_ENV === 'development') {
          console.warn('Failed to load platform config', error);
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    document.title = platformConfig.siteTitle;
  }, [platformConfig.siteTitle]);

  useEffect(() => {
    if ((!platformConfig.allowRegistration || platformConfig.maintenanceMode) && isRegisterOpen) {
      setIsRegisterOpen(false);
    }
  }, [isRegisterOpen, platformConfig.allowRegistration, platformConfig.maintenanceMode]);

  useEffect(() => {
    refreshData().catch((error) => console.error('Unexpected fetch error', error));
  }, [refreshData]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!isAuthenticated || !token) {
      return;
    }

    const source = new EventSource(
      buildApiUrl(`/api/notifications/stream?accessToken=${encodeURIComponent(token)}`),
    );

    const handleNotification = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as NotificationStreamEvent;
        const category = notificationTypeToCategory[payload.notification.type];

        setNotificationDeck((previous) => {
          const existing = previous[category] ?? [];
          if (existing.some((entry) => entry.id === payload.notification.id)) {
            return previous;
          }

          return {
            ...previous,
            [category]: [payload.notification, ...existing],
          };
        });
        setNotificationUnread(payload.unreadCounts);
        setTotalUnreadNotifications(payload.totalUnread);

        if (!payload.notification.readAt) {
          setToast({ type: 'success', message: payload.notification.title });
        }
      } catch (error) {
        console.error('Failed to process notification event', error);
      }
    };

    const handleError = (event: Event) => {
      console.error('Notification stream error', event);
    };

    source.addEventListener('notification', handleNotification as EventListener);
    source.addEventListener('error', handleError);

    return () => {
      source.removeEventListener('notification', handleNotification as EventListener);
      source.removeEventListener('error', handleError);
      source.close();
    };
  }, [isAuthenticated, token, setToast]);

  useEffect(() => {
    let isActive = true;

    const loadGeneratorSettings = async () => {
      try {
        const settings = await api.getGeneratorSettings(token);
        if (isActive) {
          setGeneratorSettings(settings);
        }
      } catch (error) {
        if (process.env.NODE_ENV === 'development') {
          console.warn('Failed to load generator settings', error);
        }
      }
    };

    loadGeneratorSettings();

    return () => {
      isActive = false;
    };
  }, [token]);

  useEffect(() => {
    if (activeView === 'admin' && authUser?.role !== 'ADMIN') {
      openPrimaryView('home');
    }
  }, [activeView, authUser?.role, openPrimaryView]);

  useEffect(() => {
    if (activeView === 'generator' && !canAccessGenerator) {
      openPrimaryView('home');
    }
  }, [activeView, canAccessGenerator, openPrimaryView]);

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

  const handleOpenGeneratorCta = useCallback(() => {
    if (!isAuthenticated) {
      setIsLoginOpen(true);
      return;
    }

    if (!canAccessGenerator) {
      setToast({
        type: 'error',
        message: 'The on-site generator is limited to approved members at the moment.',
      });
      return;
    }

    openPrimaryView('generator');
  }, [canAccessGenerator, isAuthenticated, openPrimaryView]);

  const handleOpenModerationCta = useCallback(() => {
    if (!isAuthenticated) {
      setIsLoginOpen(true);
      return;
    }

    if (authUser?.role !== 'ADMIN') {
      setToast({
        type: 'error',
        message: 'Only administrators can access the moderation workspace.',
      });
      return;
    }

    openPrimaryView('admin');
  }, [authUser?.role, isAuthenticated, openPrimaryView]);

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

  const handleOpenPrismaStudio = useCallback(() => {
    if (!authUser || authUser.role !== 'ADMIN') {
      setToast({ type: 'error', message: 'Prisma Studio is available to administrators only.' });
      return;
    }

    if (!token) {
      setToast({ type: 'error', message: 'Authentication required to open Prisma Studio.' });
      return;
    }

    const studioUrl = buildApiUrl(`/db?accessToken=${encodeURIComponent(token)}`);
    const popup = window.open(studioUrl, '_blank', 'noopener');
    if (!popup) {
      setToast({
        type: 'error',
        message: 'Enable pop-ups to launch Prisma Studio in a separate tab.',
      });
    }
  }, [authUser, setToast, token]);

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

  const handleLogout = useCallback(() => {
    void fetch('/db/logout', { method: 'POST', credentials: 'include' }).catch((error) => {
      console.warn('Failed to clear Prisma Studio session on logout:', error);
    });
    logout();
    setUsers([]);
    setActiveProfileId(null);
    setActiveProfile(null);
    setProfileError(null);
    setProfileReloadKey(0);
    setIsAccountSettingsOpen(false);
    setNotificationDeck(createEmptyNotificationDeck());
    setNotificationUnread(createEmptyNotificationCounts());
    setTotalUnreadNotifications(0);
    openPrimaryView('home');
    refreshData().catch((error) => console.error('Failed to refresh after logout', error));
  }, [logout, openPrimaryView, refreshData]);

  useEffect(() => {
    if (!platformConfig.maintenanceMode) {
      return;
    }

    if (!isAuthenticated) {
      return;
    }

    if (userRole && userRole !== 'ADMIN') {
      handleLogout();
    }
  }, [platformConfig.maintenanceMode, isAuthenticated, userRole, handleLogout]);

  const handleAdultPreferenceToggle = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!authUser || !token) {
      setToast({ type: 'error', message: 'Sign in to adjust adult content visibility.' });
      event.preventDefault();
      return;
    }

    const nextValue = event.currentTarget.checked;
    setIsUpdatingAdultPreference(true);

    try {
      await api.updateOwnProfile(token, authUser.id, { showAdultContent: nextValue });
      await refreshUser();
      await refreshData();
      setToast({
        type: 'success',
        message: nextValue
          ? 'Adult content enabled. Hidden assets will now appear across explorers.'
          : 'Adult content disabled. Restricted assets are now filtered out.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update preference.';
      setToast({ type: 'error', message });
    } finally {
      setIsUpdatingAdultPreference(false);
    }
  };

  const visibleModelAssets = useMemo(
    () => filterModelAssetsForViewer(assets, authUser),
    [assets, authUser],
  );
  const visibleImageAssets = useMemo(
    () => filterImageAssetsForViewer(images, authUser),
    [images, authUser],
  );

  const latestModels = useMemo(() => visibleModelAssets.slice(0, 5), [visibleModelAssets]);
  const latestImages = useMemo(() => visibleImageAssets.slice(0, 5), [visibleImageAssets]);
  const showAdultBadges = authUser?.showAdultContent ?? false;
  const isRegistrationUnavailable =
    !platformConfig.allowRegistration || platformConfig.maintenanceMode;
  const registrationLockMessage = platformConfig.maintenanceMode
    ? 'Maintenance mode is active. Only administrators can sign in.'
    : 'Registration is currently disabled by administrators.';

  const modelTiles = latestModels.map((asset) => {
    const isAuditPlaceholder = isAuditPlaceholderForViewer(
      asset.moderationStatus,
      asset.owner.id,
      authUser,
    );

    if (isAuditPlaceholder) {
      return (
        <article key={asset.id} className="home-card home-card--model home-card--audit">
          <div className="home-card__media home-card__media--empty">
            <span className="home-card__placeholder">In Audit</span>
          </div>
          <div className="home-card__body">
            <h3 className="home-card__title">{asset.title}</h3>
            <p className="home-card__moderation-note">Your model is currently in audit.</p>
          </div>
        </article>
      );
    }

    const previewUrl =
      resolveCachedStorageUrl(
        asset.previewImage,
        asset.previewImageBucket,
        asset.previewImageObject,
        { updatedAt: asset.updatedAt, cacheKey: asset.id },
      ) ?? asset.previewImage;
    const modelType = asset.tags.find((tag) => tag.category === 'model-type');
    const regularTags = asset.tags.filter((tag) => tag.id !== modelType?.id);
    const visibleTags = regularTags.slice(0, 5);
    const remainingTagCount = regularTags.length - visibleTags.length;
    const isFlagged = asset.moderationStatus === 'FLAGGED';
    const shouldObscure = isFlagged && authUser?.role !== 'ADMIN';
    const mediaButtonClasses = [
      'home-card__media-button',
      isFlagged ? 'moderation-overlay' : '',
      isFlagged && !shouldObscure ? 'moderation-overlay--visible' : '',
      shouldObscure ? 'moderation-overlay--blurred' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <article key={asset.id} className="home-card home-card--model">
        <div className="home-card__media">
          <button
            type="button"
            className={mediaButtonClasses}
            onClick={() => handleModelCardClick(asset.id)}
            aria-label={`Open ${asset.title} in the model explorer`}
          >
            {previewUrl ? (
              <img src={previewUrl} alt={asset.title} loading="lazy" />
            ) : (
              <span className="home-card__placeholder">No preview available</span>
            )}
            {isFlagged ? <span className="moderation-overlay__label">In audit</span> : null}
          </button>
        </div>
        <div className="home-card__body">
          <div className="home-card__title-row">
            <h3 className="home-card__title">{asset.title}</h3>
            {showAdultBadges && asset.isAdult ? (
              <span className="home-card__badge home-card__badge--adult" title="Marked as adult content">
                Adult
              </span>
            ) : null}
          </div>
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
          {isFlagged ? <p className="home-card__moderation-note">Flagged for moderation.</p> : null}
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
    const isAuditPlaceholder = isAuditPlaceholderForViewer(
      image.moderationStatus,
      image.owner.id,
      authUser,
    );

    if (isAuditPlaceholder) {
      return (
        <article key={image.id} className="home-card home-card--image home-card--audit">
          <div className="home-card__media home-card__media--empty">
            <span className="home-card__placeholder">In Audit</span>
          </div>
          <div className="home-card__body">
            <h3 className="home-card__title">{image.title}</h3>
            <p className="home-card__moderation-note">Your image is currently in audit.</p>
          </div>
        </article>
      );
    }

    const imageUrl =
      resolveCachedStorageUrl(image.storagePath, image.storageBucket, image.storageObject, {
        updatedAt: image.updatedAt,
        cacheKey: image.id,
      }) ?? image.storagePath;
    const visibleTags = image.tags.slice(0, 5);
    const remainingTagCount = image.tags.length - visibleTags.length;
    const matchedGallery = galleries.find((gallery) =>
      gallery.entries.some((entry) => entry.imageAsset?.id === image.id),
    );
    const isFlagged = image.moderationStatus === 'FLAGGED';
    const shouldObscure = isFlagged && authUser?.role !== 'ADMIN';
    const mediaButtonClasses = [
      'home-card__media-button',
      isFlagged ? 'moderation-overlay' : '',
      isFlagged && !shouldObscure ? 'moderation-overlay--visible' : '',
      shouldObscure ? 'moderation-overlay--blurred' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <article key={image.id} className="home-card home-card--image">
        <div className="home-card__media">
          <button
            type="button"
            className={mediaButtonClasses}
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
            {isFlagged ? <span className="moderation-overlay__label">In audit</span> : null}
          </button>
        </div>
        <div className="home-card__body">
          <div className="home-card__title-row">
            <h3 className="home-card__title">{image.title}</h3>
            {showAdultBadges && image.isAdult ? (
              <span className="home-card__badge home-card__badge--adult" title="Marked as adult content">
                Adult
              </span>
            ) : null}
          </div>
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
          {isFlagged ? <p className="home-card__moderation-note">Flagged for moderation.</p> : null}
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

  const renderHome = () => {
    const isCurator = authUser?.role === 'CURATOR' || authUser?.role === 'ADMIN';
    const curatorCount = users.filter((user) => user.role === 'CURATOR' || user.role === 'ADMIN').length;
    const flaggedModels = assets.filter((asset) => asset.moderationStatus === 'FLAGGED').length;
    const flaggedImages = images.filter((image) => image.moderationStatus === 'FLAGGED').length;
    const totalPublished = assets.length + images.length;
    const pendingModeration = flaggedModels + flaggedImages;
    const moderationCoverage =
      totalPublished === 0
        ? '100%'
        : `${Math.max(0, Math.round(((totalPublished - pendingModeration) / totalPublished) * 100))}%`;
    const callToActions = [
      {
        id: 'upload-model',
        title: isCurator ? 'Upload model' : 'Become curator',
        onClick: isCurator ? handleOpenAssetUpload : () => setIsLoginOpen(true),
        accent: 'violet' as const,
      },
      {
        id: 'draft-gallery',
        title: isCurator ? 'Curate gallery' : 'Browse galleries',
        onClick: isCurator ? handleOpenGalleryUpload : () => openPrimaryView('images'),
        accent: 'cyan' as const,
      },
      {
        id: 'queue-generator',
        title: 'Queue generator run',
        onClick: handleOpenGeneratorCta,
        accent: 'amber' as const,
      },
      authUser?.role === 'ADMIN'
        ? {
            id: 'review-moderation',
            title: 'Moderation queue',
            onClick: handleOpenModerationCta,
            accent: 'rose' as const,
          }
        : null,
      {
        id: 'check-status',
        title: 'Service status',
        onClick: () => openPrimaryView('status'),
        accent: 'slate' as const,
      },
    ].filter(Boolean) as Array<{
      id: string;
      title: string;
      onClick: () => void;
      accent: 'violet' | 'cyan' | 'amber' | 'rose' | 'slate';
    }>;

    const latestHighlights = [
      visibleModelAssets[0]
        ? {
            id: `model-${visibleModelAssets[0].id}`,
            label: 'Model release',
            title: visibleModelAssets[0].name,
            description: visibleModelAssets[0].summary ?? 'New LoRA adapter available to explore.',
            onClick: () => openPrimaryView('models'),
          }
        : null,
      visibleImageAssets[0]
        ? {
            id: `image-${visibleImageAssets[0].id}`,
            label: 'Fresh render',
            title: visibleImageAssets[0].title ?? 'New reference render',
            description: visibleImageAssets[0].prompt ?? 'See the latest inspiration from the community.',
            onClick: () => openPrimaryView('images'),
          }
        : null,
    ].filter(Boolean) as Array<{
      id: string;
      label: string;
      title: string;
      description: string;
      onClick: () => void;
    }>;

    return (
      <div className="home-grid">
        <section className="home-section home-section--whats-new">
          <header className="home-section__header">
            <h2>What&apos;s new</h2>
            <p>Latest highlights across the catalog so you can dive into fresh releases first.</p>
          </header>
          <div className="home-whats-new-grid">
            {latestHighlights.length === 0 ? (
              <p className="home-whats-new-empty">New models and renders will appear here once published.</p>
            ) : (
              latestHighlights.map((item) => (
                <button key={item.id} type="button" className="home-whats-new-card" onClick={item.onClick}>
                  <span className="home-whats-new-card__label">{item.label}</span>
                  <span className="home-whats-new-card__title">{item.title}</span>
                  <span className="home-whats-new-card__description">{item.description}</span>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="home-section home-section--callouts">
          <header className="home-section__header">
            <h2>Take action</h2>
          </header>
          <ul className="home-cta-list">
            {callToActions.map((action) => (
              <li key={action.id}>
                <button
                  type="button"
                  className={`home-cta-pill home-cta-pill--${action.accent}`}
                  onClick={action.onClick}
                >
                  <span className="home-cta-pill__title">{action.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="home-section home-section--trust">
          <header className="home-section__header">
            <h2>Platform health</h2>
          </header>
          <dl className="home-trust-list">
            <div className="home-trust-list__item">
              <dt>Curated models</dt>
              <dd>{assets.length.toLocaleString()}</dd>
            </div>
            <div className="home-trust-list__item">
              <dt>Active curators</dt>
              <dd>{curatorCount.toLocaleString()}</dd>
            </div>
            <div className="home-trust-list__item">
              <dt>Moderation coverage</dt>
              <dd>{moderationCoverage}</dd>
            </div>
          </dl>
        </section>

        <section className="home-section">
          <header className="home-section__header">
            <h2>Latest models</h2>
            <p>The most recent uploads from the model explorer presented as compact tiles.</p>
          </header>
          <div className="home-section__grid">
            {isLoading && visibleModelAssets.length === 0
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
            {isLoading && visibleImageAssets.length === 0
              ? Array.from({ length: 5 }).map((_, index) => <div key={index} className="skeleton skeleton--card" />)
              : imageTiles}
          </div>
          {!isLoading && imageTiles.length === 0 ? (
            <p className="empty-state">No images available yet.</p>
          ) : null}
          {imageAssetsHasMore ? (
            <div className="home-section__actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  if (isLoadingMoreImages) {
                    return;
                  }
                  void loadMoreImageAssets();
                }}
                disabled={isLoadingMoreImages}
              >
                {isLoadingMoreImages ? 'Loading more images…' : 'Load more images'}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    );
  };

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
          generatorSettings={generatorSettings}
          onGeneratorSettingsUpdated={setGeneratorSettings}
          onPlatformConfigUpdated={setPlatformConfig}
        />
      );
    }

    if (activeView === 'notifications') {
      if (!authUser || !isAuthenticated) {
        return <div className="content__alert">Sign in to review your notifications.</div>;
      }

      return (
        <NotificationsCenter
          notifications={notificationDeck}
          unreadCounts={notificationUnread}
          onMarkNotificationRead={handleMarkNotificationRead}
          onMarkCategoryRead={handleMarkCategoryRead}
          onOpenModel={handleModelCardClick}
          onOpenImage={handleImageCardClick}
        />
      );
    }

    if (activeView === 'models') {
      return (
        <AssetExplorer
          assets={visibleModelAssets}
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
          hasMoreAssets={modelAssetsHasMore}
          onLoadMoreAssets={loadMoreModelAssets}
          isLoadingMoreAssets={isLoadingMoreModels}
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

    if (activeView === 'generator') {
      if (!isGpuModuleEnabled) {
        return <div className="content__alert">The GPU module is disabled by an administrator.</div>;
      }

      if (!authUser || !token || !canAccessGenerator) {
        return <div className="content__alert">The On-Site Generator requires a signed-in account.</div>;
      }

      return (
        <OnSiteGenerator
          models={visibleModelAssets}
          token={token}
          currentUser={authUser}
          onNotify={handleGeneratorNotify}
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
          viewer={authUser}
        />
      );
    }

    if (activeView === 'status') {
      return (
        <ServiceStatusPage
          services={(['frontend', 'backend', 'minio', 'gpu'] as ServiceStatusKey[]).map((key) => ({
            key,
            badge: serviceBadgeLabels[key],
            indicator: serviceStatus[key],
          }))}
          statusLabels={statusLabels}
          onBack={() => openPrimaryView(returnView)}
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
  const currentYear = new Date().getFullYear();

  if (isMaintenanceLocked) {
    return (
      <div className="app app--maintenance">
        <LoginDialog
          isOpen
          onClose={() => undefined}
          onSubmit={handleLoginSubmit}
          isSubmitting={isLoggingIn}
          errorMessage={loginError}
          noticeMessage="Maintenance active. Admin Only"
          isDismissible={false}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar__brand">
            <span className="sidebar__logo">{platformConfig.siteTitle}</span>
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
                <span className="sidebar__nav-button-inner">
                  <span className="sidebar__nav-label">{viewMeta[view].title}</span>
                  {view === 'notifications' && totalUnreadNotifications > 0 ? (
                    <span className="sidebar__nav-badge">{totalUnreadNotifications}</span>
                  ) : null}
                </span>
              </button>
            ))}
            {authUser?.role === 'ADMIN' ? (
              <button type="button" className="sidebar__nav-button" onClick={handleOpenPrismaStudio}>
                Prisma Studio
              </button>
            ) : null}
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
                    if (isRegistrationUnavailable) {
                      setToast({ type: 'error', message: registrationLockMessage });
                      return;
                    }
                    setIsRegisterOpen(true);
                    setRegisterError(null);
                  }}
                  disabled={isLoggingIn || isRegistering || isRegistrationUnavailable}
                >
                  Create account
                </button>
                {isRegistrationUnavailable ? (
                  <p
                    className={`sidebar__auth-note${
                      platformConfig.maintenanceMode ? ' sidebar__auth-note--warning' : ''
                    }`}
                  >
                    {registrationLockMessage}
                  </p>
                ) : null}
              </>
            )}
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
              <div className="content__actions">
                {authUser ? (
                  <label
                    className={`content__toggle${authUser.showAdultContent ? ' content__toggle--active' : ''}`}
                    htmlFor="nsfw-toggle"
                  >
                    <input
                      id="nsfw-toggle"
                      type="checkbox"
                      checked={authUser.showAdultContent}
                      onChange={handleAdultPreferenceToggle}
                      disabled={isUpdatingAdultPreference}
                    />
                    <span>
                      {authUser.showAdultContent ? 'Adult content visible' : 'Adult content hidden'}
                    </span>
                  </label>
                ) : (
                  <div className="content__toggle content__toggle--disabled" role="status" aria-live="polite">
                    Guests browse in safe mode
                  </div>
                )}
              </div>
            </header>

            {errorMessage ? <div className="content__alert">{errorMessage}</div> : null}

            {renderContent()}

            <footer
              className={`footer${isFooterVisible ? ' footer--visible' : ' footer--hidden'}`}
              aria-label="Support and credits"
            >
              <div className="footer__inner">
                <div className="footer__support-block">
                  <div className="footer__support-copy">
                    <span className="footer__label">VisionSuit Support</span>
                    <p className="footer__description">Connect with the team or follow live platform updates.</p>
                  </div>
                  <div className="footer__support-actions">
                    <nav className="footer__icons" aria-label="Support channels">
                      <a
                        href="https://discord.gg/UEb68YQwKR"
                        className="footer__icon-link"
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <span className="sr-only">Join the Discord Support Hub</span>
                        <svg className="footer__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M20.317 4.369a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.078.037c-.211.375-.444.864-.608 1.249-1.844-.276-3.68-.276-5.486 0-.164-.398-.41-.874-.622-1.249a.077.077 0 0 0-.078-.037 19.736 19.736 0 0 0-4.885 1.515.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.061a.082.082 0 0 0 .031.056c2.052 1.5 4.041 2.416 5.993 3.029a.078.078 0 0 0 .084-.027c.461-.63.873-1.295 1.226-1.996a.076.076 0 0 0-.041-.105c-.652-.247-1.27-.545-1.872-.892a.077.077 0 0 1-.007-.129c.125-.094.25-.192.37-.291a.074.074 0 0 1 .077-.01c3.927 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.244.198.37.292a.077.077 0 0 1-.006.128 12.298 12.298 0 0 1-1.873.892.076.076 0 0 0-.04.106c.36.7.772 1.366 1.225 1.996a.076.076 0 0 0 .084.028c1.961-.613 3.95-1.53 6.002-3.03a.077.077 0 0 0 .031-.055c.5-5.177-.838-9.673-3.548-13.665a.061.061 0 0 0-.031-.028ZM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.419 0 1.334-.955 2.419-2.157 2.419Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.419 0 1.334-.947 2.419-2.157 2.419Z" />
                        </svg>
                      </a>
                      <a
                        href="https://github.com/MythosMachina"
                        className="footer__icon-link"
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <span className="sr-only">Visit MythosMachina Studio on GitHub</span>
                        <svg className="footer__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M12 .5c-6.63 0-12 5.37-12 12 0 5.3 3.438 9.747 8.205 11.325.6.111.82-.261.82-.58 0-.286-.011-1.04-.017-2.04-3.338.726-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.73.083-.73 1.205.084 1.84 1.236 1.84 1.236 1.07 1.834 2.809 1.304 3.495.997.108-.775.418-1.305.762-1.605-2.665-.303-5.466-1.332-5.466-5.931 0-1.31.469-2.381 1.236-3.221-.124-.303-.536-1.523.117-3.176 0 0 1.008-.322 3.3 1.23a11.52 11.52 0 0 1 3.003-.404c1.02.005 2.047.138 3.003.404 2.291-1.552 3.297-1.23 3.297-1.23.655 1.653.243 2.873.119 3.176.77.84 1.235 1.911 1.235 3.221 0 4.61-2.807 5.625-5.48 5.921.43.372.823 1.103.823 2.222 0 1.604-.015 2.896-.015 3.289 0 .321.216.697.825.579C20.565 22.243 24 17.78 24 12.5 24 5.87 18.627.5 12 .5Z" />
                        </svg>
                      </a>
                    </nav>
                    <a href="#service-status" className="footer__status-link" onClick={handleServiceStatusClick}>
                      Service Status
                    </a>
                  </div>
                </div>
                <div className="footer__spacer" aria-hidden="true" />
                <div className="footer__meta-group">
                  <div className="footer__credits" aria-label="Project credits">
                    <span className="footer__credit-heading">MythosMachina Studio</span>
                    <p className="footer__credit-copy">
                      © {currentYear} MythosMachina · All rights reserved · Developed by{' '}
                      <a href="https://github.com/AsaTyr2018/" target="_blank" rel="noreferrer noopener">
                        AsaTyr
                      </a>
                      .
                    </p>
                  </div>
                  <div className="footer__spacer footer__spacer--muted" aria-hidden="true" />
                  <div className="footer__status-deck" aria-label="Live service indicator">
                    <div className="footer__status-summary">
                      {(['frontend', 'backend', 'minio', 'gpu'] as ServiceStatusKey[]).map((key) => {
                        const entry = serviceStatus[key];
                        return (
                          <span key={key} className={`footer__status-pill footer__status-pill--${entry.status}`}>
                            <span className="footer__status-initial">{serviceBadgeLabels[key]}</span>
                            <span className={`status-led status-led--${entry.status}`} aria-hidden="true" />
                            <span className="sr-only">{`${entry.label}: ${statusLabels[entry.status]}`}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </footer>
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
