import type { ModelAsset } from '../types/api';

import { resolveCachedStorageUrl, resolveStorageUrl } from '../lib/storage';

interface AssetCardProps {
  asset: ModelAsset;
}

const formatFileSize = (bytes?: number | null) => {
  if (!bytes) return '–';
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
};

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export const AssetCard = ({ asset }: AssetCardProps) => {
  const modelType = asset.tags.find((tag) => tag.category === 'model-type')?.label ?? 'Asset';
  const previewUrl = resolveCachedStorageUrl(asset.previewImage, asset.previewImageBucket, asset.previewImageObject, {
    updatedAt: asset.updatedAt,
    cacheKey: asset.id,
  });
  const downloadUrl =
    resolveStorageUrl(asset.storagePath, asset.storageBucket, asset.storageObject) ?? asset.storagePath;

  return (
    <article className="asset-card">
      {previewUrl ? (
        <div className="asset-card__media">
          <img src={previewUrl} alt={`Preview of ${asset.title}`} loading="lazy" />
        </div>
      ) : null}
      <header className="asset-card__header">
        <div>
          <h3 className="asset-card__title">{asset.title}</h3>
          <p className="asset-card__version">Version {asset.version}</p>
        </div>
        <span className="asset-card__badge">{modelType}</span>
      </header>
      <p className="asset-card__description">{asset.description ?? 'No description provided yet.'}</p>
      <dl className="asset-card__meta">
        <div>
          <dt>Storage</dt>
          <dd title={downloadUrl} className="asset-card__mono">
            <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
              {asset.storageObject ?? asset.storagePath}
            </a>
          </dd>
        </div>
        {asset.storageBucket ? (
          <div>
            <dt>Bucket</dt>
            <dd className="asset-card__mono">{asset.storageBucket}</dd>
          </div>
        ) : null}
        <div>
          <dt>File size</dt>
          <dd>{formatFileSize(asset.fileSize)}</dd>
        </div>
        <div>
          <dt>Checksum</dt>
          <dd className="asset-card__mono">{asset.checksum ?? '–'}</dd>
        </div>
        <div>
          <dt>Curator</dt>
          <dd>{asset.owner.displayName}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(asset.updatedAt)}</dd>
        </div>
      </dl>
      <footer className="asset-card__tags">
        {asset.tags.map((tag) => (
          <span key={tag.id}>{tag.label}</span>
        ))}
      </footer>
    </article>
  );
};
