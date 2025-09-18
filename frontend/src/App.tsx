import { useEffect, useMemo, useState } from 'react';

import { AssetExplorer } from './components/AssetExplorer';
import { GalleryExplorer } from './components/GalleryExplorer';
import { StatCard } from './components/StatCard';
import { api } from './lib/api';
import type { Gallery, MetaStats, ModelAsset } from './types/api';

const statsPlaceholder = Array.from({ length: 3 }, (_, index) => index);

export const App = () => {
  const [stats, setStats] = useState<MetaStats | null>(null);
  const [assets, setAssets] = useState<ModelAsset[]>([]);
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        const [fetchedStats, fetchedAssets, fetchedGalleries] = await Promise.all([
          api.getStats(),
          api.getModelAssets(),
          api.getGalleries(),
        ]);

        setStats(fetchedStats);
        setAssets(fetchedAssets);
        setGalleries(fetchedGalleries);
        setErrorMessage(null);
      } catch (error) {
        console.error(error);
        setErrorMessage('Backend noch nicht erreichbar. Bitte Server prüfen oder später erneut versuchen.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData().catch((error) => console.error('Unexpected fetch error', error));
  }, []);

  const statsList = useMemo(
    () =>
      stats
        ? [
            { label: 'LoRA Assets', value: stats.modelCount, helper: 'Versionierte Safetensors & Metadaten' },
            { label: 'Galerie-Einträge', value: stats.imageCount, helper: 'Gerenderte Beispiele & Referenzen' },
            { label: 'Kuratiere Galerien', value: stats.galleryCount, helper: 'Moderierte Sammlungen' },
            { label: 'Tags', value: stats.tagCount, helper: 'Verschlagwortung für Suche & Filter' },
          ]
        : [],
    [stats],
  );

  return (
    <div className="app">
      <div className="app__wrapper">
        <header className="hero">
          <span className="hero__badge">VisionSuit Platform</span>
          <h1 className="hero__title">Kuratierte KI-Galerien &amp; LoRA-Hosting – bereit für deinen ersten Upload.</h1>
          <p className="hero__description">
            Dieser Entwurf zeigt das grundlegende Erlebnis für VisionSuit. Die Karten nutzen Seed-Daten aus dem neuen Backend
            und markieren kommende Features wie Upload-Assistent, Review-Workflows und kollaborative Kuratierung.
          </p>
          <div className="hero__meta">
            <span className={`hero__meta-badge ${errorMessage ? 'hero__meta-badge--danger' : 'hero__meta-badge--success'}`}>
              Backend Status: {errorMessage ? 'Offline' : 'Online'}
            </span>
            <span className="hero__meta-badge">API Base: {import.meta.env.VITE_API_URL ?? 'http://localhost:4000'}</span>
            <span className="hero__meta-badge">Build Stage: Prototype 0.1</span>
          </div>
        </header>

        <section className="panel panel--frosted">
          <header className="panel__header">
            <div>
              <h2 className="panel__title">Kennzahlen</h2>
              <p className="panel__subtitle">
                Schnellübersicht der wichtigsten Inhalte deiner Instanz. Die Werte aktualisieren sich automatisch nach dem Seed.
              </p>
            </div>
          </header>
          <div className="panel__grid panel__grid--stats">
            {isLoading && statsList.length === 0
              ? statsPlaceholder.map((key) => <div key={key} className="skeleton" />)
              : statsList.map((item) => <StatCard key={item.label} {...item} />)}
          </div>
          {errorMessage ? <p className="panel__error">{errorMessage}</p> : null}
        </section>

        <AssetExplorer assets={assets} isLoading={isLoading} />
        <GalleryExplorer galleries={galleries} isLoading={isLoading} />
      </div>
    </div>
  );
};

export default App;
