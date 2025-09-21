import { useMemo } from 'react';

import { resolveAvatarUrl } from '../lib/avatar';
import { resolveCachedStorageUrl } from '../lib/storage';
import type {
  UserProfile as UserProfileResponse,
  UserProfileGallerySummary,
  UserProfileModelSummary,
} from '../types/api';

interface UserProfileProps {
  profile: UserProfileResponse | null;
  isLoading: boolean;
  error?: string | null;
  onBack?: () => void;
  onRetry?: () => void;
  onOpenModel?: (modelId: string) => void;
  onOpenGallery?: (galleryId: string) => void;
  canAudit?: boolean;
  isAuditActive?: boolean;
  onToggleAudit?: () => void;
}

const formatDate = (value: string) => {
  try {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value));
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to format date', error);
    }
    return value;
  }
};

const formatRole = (role: UserProfileResponse['role']) => {
  if (role === 'ADMIN') {
    return 'Administrator';
  }
  if (role === 'CURATOR') {
    return 'Curator';
  }
  return 'Member';
};

const getInitials = (name: string) => {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) {
    return '?';
  }
  return parts
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
};

const renderModelCard = (
  model: UserProfileModelSummary,
  onOpenModel?: (modelId: string) => void,
) => {
  const previewUrl =
    resolveCachedStorageUrl(model.previewImage, model.previewImageBucket, model.previewImageObject, {
      updatedAt: model.updatedAt,
      cacheKey: model.id,
    }) ?? model.previewImage ?? undefined;
  const tagList = model.tags.slice(0, 4);
  const remainingTags = model.tags.length - tagList.length;

  if (!onOpenModel) {
    return (
      <article key={model.id} className="profile-view__model-card">
        <div className={`profile-view__model-media${previewUrl ? '' : ' profile-view__model-media--empty'}`}>
          {previewUrl ? <img src={previewUrl} alt={model.title} loading="lazy" /> : <span>No preview</span>}
        </div>
        <div className="profile-view__model-body">
          <div className="profile-view__model-header">
            <h3>{model.title}</h3>
            {!model.isPublic ? <span className="profile-view__badge profile-view__badge--private">Private</span> : null}
          </div>
          <p>Version {model.version}</p>
          <p className="profile-view__model-updated">Updated {formatDate(model.updatedAt)}</p>
          {tagList.length > 0 ? (
            <ul className="profile-view__tag-list">
              {tagList.map((tag) => (
                <li key={tag.id}>#{tag.label}</li>
              ))}
              {remainingTags > 0 ? <li className="profile-view__tag-more">+{remainingTags}</li> : null}
            </ul>
          ) : (
            <p className="profile-view__tag-empty">No tags assigned yet.</p>
          )}
        </div>
      </article>
    );
  }

  return (
    <button
      key={model.id}
      type="button"
      className="profile-view__model-card profile-view__model-card--interactive"
      onClick={() => onOpenModel(model.id)}
      aria-label={`Open ${model.title} in the model explorer`}
    >
      <div className={`profile-view__model-media${previewUrl ? '' : ' profile-view__model-media--empty'}`}>
        {previewUrl ? <img src={previewUrl} alt={model.title} loading="lazy" /> : <span>No preview</span>}
      </div>
      <div className="profile-view__model-body">
        <div className="profile-view__model-header">
          <h3>{model.title}</h3>
          {!model.isPublic ? <span className="profile-view__badge profile-view__badge--private">Private</span> : null}
        </div>
        <p>Version {model.version}</p>
        <p className="profile-view__model-updated">Updated {formatDate(model.updatedAt)}</p>
        {tagList.length > 0 ? (
          <ul className="profile-view__tag-list">
            {tagList.map((tag) => (
              <li key={tag.id}>#{tag.label}</li>
            ))}
            {remainingTags > 0 ? <li className="profile-view__tag-more">+{remainingTags}</li> : null}
          </ul>
        ) : (
          <p className="profile-view__tag-empty">No tags assigned yet.</p>
        )}
      </div>
    </button>
  );
};

const renderGalleryCard = (
  gallery: UserProfileGallerySummary,
  onOpenGallery?: (galleryId: string) => void,
) => {
  const coverUrl =
    resolveCachedStorageUrl(gallery.coverImage, gallery.coverImageBucket, gallery.coverImageObject, {
      updatedAt: gallery.updatedAt,
      cacheKey: gallery.id,
    }) ?? gallery.coverImage ?? undefined;
  const entryLabel = gallery.stats.entryCount === 1 ? 'Entry' : 'Entries';

  if (!onOpenGallery) {
    return (
      <article key={gallery.id} className="profile-view__gallery-card">
        <div className={`profile-view__gallery-media${coverUrl ? '' : ' profile-view__gallery-media--empty'}`}>
          {coverUrl ? <img src={coverUrl} alt={gallery.title} loading="lazy" /> : <span>No cover</span>}
        </div>
        <div className="profile-view__gallery-body">
          <div className="profile-view__gallery-header">
            <h3>{gallery.title}</h3>
            <span className={`profile-view__gallery-badge${gallery.isPublic ? ' profile-view__gallery-badge--public' : ''}`}>
              {gallery.isPublic ? 'Public' : 'Private'}
            </span>
          </div>
          {gallery.description ? (
            <p className="profile-view__gallery-description">{gallery.description}</p>
          ) : (
            <p className="profile-view__gallery-description profile-view__gallery-description--muted">
              No description yet.
            </p>
          )}
          <dl className="profile-view__gallery-stats">
            <div>
              <dt>{entryLabel}</dt>
              <dd>{gallery.stats.entryCount}</dd>
            </div>
            <div>
              <dt>Images</dt>
              <dd>{gallery.stats.imageCount}</dd>
            </div>
            <div>
              <dt>LoRAs</dt>
              <dd>{gallery.stats.modelCount}</dd>
            </div>
          </dl>
          <p className="profile-view__gallery-updated">Updated {formatDate(gallery.updatedAt)}</p>
        </div>
      </article>
    );
  }

  return (
    <button
      key={gallery.id}
      type="button"
      className="profile-view__gallery-card profile-view__gallery-card--interactive"
      onClick={() => onOpenGallery(gallery.id)}
      aria-label={`Open ${gallery.title} in the gallery explorer`}
    >
      <div className={`profile-view__gallery-media${coverUrl ? '' : ' profile-view__gallery-media--empty'}`}>
        {coverUrl ? <img src={coverUrl} alt={gallery.title} loading="lazy" /> : <span>No cover</span>}
      </div>
      <div className="profile-view__gallery-body">
        <div className="profile-view__gallery-header">
          <h3>{gallery.title}</h3>
          <span className={`profile-view__gallery-badge${gallery.isPublic ? ' profile-view__gallery-badge--public' : ''}`}>
            {gallery.isPublic ? 'Public' : 'Private'}
          </span>
        </div>
        {gallery.description ? (
          <p className="profile-view__gallery-description">{gallery.description}</p>
        ) : (
          <p className="profile-view__gallery-description profile-view__gallery-description--muted">
            No description yet.
          </p>
        )}
        <dl className="profile-view__gallery-stats">
          <div>
            <dt>{entryLabel}</dt>
            <dd>{gallery.stats.entryCount}</dd>
          </div>
          <div>
            <dt>Images</dt>
            <dd>{gallery.stats.imageCount}</dd>
          </div>
          <div>
            <dt>LoRAs</dt>
            <dd>{gallery.stats.modelCount}</dd>
          </div>
        </dl>
        <p className="profile-view__gallery-updated">Updated {formatDate(gallery.updatedAt)}</p>
      </div>
    </button>
  );
};

export const UserProfile = ({
  profile,
  isLoading,
  error,
  onBack,
  onRetry,
  onOpenModel,
  onOpenGallery,
  canAudit,
  isAuditActive,
  onToggleAudit,
}: UserProfileProps) => {
  const avatarUrl = profile ? resolveAvatarUrl(profile.avatarUrl, profile.id) : null;
  const initials = profile ? getInitials(profile.displayName) : '?';
  const { nextRankDescription, blockedNotice } = useMemo(() => {
    if (!profile) {
      return { nextRankDescription: null, blockedNotice: null };
    }

    if (profile.rank.isBlocked) {
      return {
        nextRankDescription: null,
        blockedNotice: 'Ranking for this curator has been disabled by an administrator.',
      };
    }

    if (!profile.rank.nextLabel || profile.rank.nextScore == null) {
      return { nextRankDescription: null, blockedNotice: null };
    }

    const remaining = profile.rank.nextScore - profile.rank.score;
    if (remaining <= 0) {
      return {
        nextRankDescription: `Already eligible for ${profile.rank.nextLabel}.`,
        blockedNotice: null,
      };
    }

    return {
      nextRankDescription: `${remaining} contribution point${remaining === 1 ? '' : 's'} to reach ${profile.rank.nextLabel}.`,
      blockedNotice: null,
    };
  }, [profile]);

  return (
    <section className="profile-view">
      <header className="profile-view__header">
        <div className="profile-view__header-main">
          <div className={`profile-view__avatar${avatarUrl ? '' : ' profile-view__avatar--placeholder'}`}>
            {avatarUrl ? <img src={avatarUrl} alt={`${profile?.displayName ?? 'Curator'} avatar`} /> : <span>{initials}</span>}
          </div>
          <div className="profile-view__identity">
            <div className="profile-view__identity-row">
              <h2 className="profile-view__name">{profile?.displayName ?? 'Curator'}</h2>
              {profile ? <span className="profile-view__rank-badge">{profile.rank.label}</span> : null}
            </div>
            {profile ? <p className="profile-view__rank-description">{profile.rank.description}</p> : null}
            <dl className="profile-view__meta">
              <div>
                <dt>Role</dt>
                <dd>{profile ? formatRole(profile.role) : 'Curator'}</dd>
              </div>
              <div>
                <dt>Joined</dt>
                <dd>{profile ? formatDate(profile.joinedAt) : '—'}</dd>
              </div>
              <div>
                <dt>Score</dt>
                <dd>{profile ? profile.rank.score : '—'}</dd>
              </div>
            </dl>
            {blockedNotice ? (
              <p className="profile-view__rank-progress">{blockedNotice}</p>
            ) : nextRankDescription ? (
              <p className="profile-view__rank-progress">{nextRankDescription}</p>
            ) : null}
          </div>
        </div>
        <div className="profile-view__header-actions">
          {onRetry ? (
            <button type="button" className="profile-view__action" onClick={onRetry} disabled={isLoading}>
              Refresh profile
            </button>
          ) : null}
          {canAudit && onToggleAudit ? (
            <button
              type="button"
              className={`profile-view__action profile-view__action--audit${isAuditActive ? ' profile-view__action--active' : ''}`}
              onClick={onToggleAudit}
              aria-pressed={isAuditActive ? 'true' : 'false'}
              disabled={isLoading}
            >
              {isAuditActive ? 'Exit audit' : 'Audit'}
            </button>
          ) : null}
          {onBack ? (
            <button type="button" className="profile-view__action profile-view__action--primary" onClick={onBack}>
              Back
            </button>
          ) : null}
        </div>
      </header>

      {profile?.visibility?.audit ? (
        <div className="profile-view__notice profile-view__notice--audit" role="status">
          Audit mode active. Private uploads are temporarily visible to administrators.
        </div>
      ) : profile?.visibility && !profile.visibility.includePrivate ? (
        <div className="profile-view__notice" role="status">
          Showing public uploads only. Private items remain hidden by curator preference.
        </div>
      ) : profile?.visibility?.includePrivate ? (
        <div className="profile-view__notice" role="status">
          Private uploads are included because you own this profile.
        </div>
      ) : null}

      {isLoading && !profile ? <div className="profile-view__status">Loading profile…</div> : null}
      {error ? <div className="profile-view__error">{error}</div> : null}

      {profile ? (
        <>
          <section className="profile-view__section">
            <h3>About</h3>
            {profile.bio ? (
              <p className="profile-view__bio">{profile.bio}</p>
            ) : (
              <p className="profile-view__bio profile-view__bio--muted">This curator has not written a bio yet.</p>
            )}
          </section>

          <section className="profile-view__section profile-view__section--stats" aria-label="Contribution stats">
            <div>
              <span className="profile-view__stat-value">{profile.stats.modelCount}</span>
              <span className="profile-view__stat-label">Models</span>
            </div>
            <div>
              <span className="profile-view__stat-value">{profile.stats.galleryCount}</span>
              <span className="profile-view__stat-label">Collections</span>
            </div>
            <div>
              <span className="profile-view__stat-value">{profile.stats.imageCount}</span>
              <span className="profile-view__stat-label">Images</span>
            </div>
            <div>
              <span
                className={`profile-view__stat-value${
                  profile.stats.receivedLikeCount > 0 ? ' profile-view__stat-value--likes' : ''
                }`}
              >
                {profile.stats.receivedLikeCount}
              </span>
              <span className="profile-view__stat-label">Received likes</span>
            </div>
          </section>

          <section className="profile-view__section">
            <div className="profile-view__section-heading">
              <h3>Uploaded models</h3>
              <span className="profile-view__section-count">{profile.models.length}</span>
            </div>
            {profile.models.length > 0 ? (
              <div className="profile-view__model-grid" role="list">
                {profile.models.map((model) => renderModelCard(model, onOpenModel))}
              </div>
            ) : (
              <p className="profile-view__empty">No models uploaded yet.</p>
            )}
          </section>

          <section className="profile-view__section">
            <div className="profile-view__section-heading">
              <h3>Collections</h3>
              <span className="profile-view__section-count">{profile.galleries.length}</span>
            </div>
            {profile.galleries.length > 0 ? (
              <div className="profile-view__gallery-grid" role="list">
                {profile.galleries.map((gallery) => renderGalleryCard(gallery, onOpenGallery))}
              </div>
            ) : (
              <p className="profile-view__empty">No collections curated yet.</p>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
};

