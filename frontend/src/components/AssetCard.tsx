import type { ModelAsset } from '../types/api';

interface AssetCardProps {
  asset: ModelAsset;
}

const formatFileSize = (bytes?: number | null) => {
  if (!bytes) return '–';
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
};

export const AssetCard = ({ asset }: AssetCardProps) => (
  <article className="asset-card">
    <header className="asset-card__header">
      <div>
        <h3 className="asset-card__title">{asset.title}</h3>
        <p className="asset-card__version">Version {asset.version}</p>
      </div>
      <span className="asset-card__badge">
        {asset.tags.find((tag) => tag.category === 'model-type')?.label ?? 'Asset'}
      </span>
    </header>
    <p className="asset-card__description">{asset.description ?? 'Noch keine Beschreibung hinterlegt.'}</p>
    <dl className="asset-card__meta">
      <div>
        <dt>Dateipfad</dt>
        <dd title={asset.storagePath} className="asset-card__mono">
          {asset.storagePath}
        </dd>
      </div>
      <div>
        <dt>Dateigröße</dt>
        <dd>{formatFileSize(asset.fileSize)}</dd>
      </div>
      <div>
        <dt>Checksumme</dt>
        <dd className="asset-card__mono">{asset.checksum ?? '–'}</dd>
      </div>
      <div>
        <dt>Kurator</dt>
        <dd>{asset.owner.displayName}</dd>
      </div>
    </dl>
    <footer className="asset-card__tags">
      {asset.tags.map((tag) => (
        <span key={tag.id}>{tag.label}</span>
      ))}
    </footer>
  </article>
);
