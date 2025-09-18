import { useCallback, useEffect, useMemo, useState } from 'react';

import { AssetExplorer } from './components/AssetExplorer';
import { GalleryExplorer } from './components/GalleryExplorer';
import { StatCard } from './components/StatCard';
import { UploadWizard } from './components/UploadWizard';
import type { UploadWizardResult } from './components/UploadWizard';
import { api } from './lib/api';
import type { Gallery, MetaStats, ModelAsset } from './types/api';

const statsPlaceholder = Array.from({ length: 3 }, (_, index) => index);

export const App = () => {
  const [stats, setStats] = useState<MetaStats | null>(null);
  const [assets, setAssets] = useState<ModelAsset[]>([]);
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isUploadWizardOpen, setIsUploadWizardOpen] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const refreshData = useCallback(async () => {
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
  }, []);

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
        {toast ? (
          <div className={`toast toast--${toast.type}`} role="status">
            {toast.message}
          </div>
        ) : null}

        <header className="topbar">
          <div className="topbar__brand">
            <span className="topbar__logo">VisionSuit</span>
            <span className="topbar__tag">AI Ops Platform</span>
          </div>
          <nav className="topbar__nav" aria-label="Hauptnavigation">
            <a href="#features">Features</a>
            <a href="#governance">Governance</a>
            <a href="#pipeline">Pipeline</a>
            <a href="#explorer">Explorer</a>
          </nav>
          <div className="topbar__meta">
            <div className={`status-indicator status-indicator--${errorMessage ? 'danger' : 'success'}`}>
              <span aria-hidden="true" />
              <span className="status-indicator__label">{errorMessage ? 'Backend Offline' : 'Systems nominal'}</span>
            </div>
            <button
              type="button"
              className="topbar__cta"
              onClick={() => setIsUploadWizardOpen(true)}
            >
              Upload starten
            </button>
          </div>
        </header>

        <main>
          <section className="hero" id="overview">
            <span className="hero__badge">Production Control Center</span>
            <div className="hero__layout">
              <div className="hero__content">
                <h1 className="hero__title">
                  VisionSuit orchestriert deinen gesamten KI-Asset-Lifecycle – nachvollziehbar, auditierbar und skalierbar.
                </h1>
                <p className="hero__description">
                  Plane Uploads, führe Governance-Regeln durch und veröffentliche kuratierte Galerien ohne Medienbruch. Die
                  Plattform konsolidiert Prüfungen, Storage und Monitoring in einer produktionsreifen Oberfläche.
                </p>
                <div className="hero__actions">
                  <button
                    type="button"
                    className="panel__action panel__action--primary"
                    onClick={() => setIsUploadWizardOpen(true)}
                  >
                    Upload-Wizard öffnen
                  </button>
                  <button
                    type="button"
                    className="panel__action"
                    onClick={() => document.getElementById('explorer')?.scrollIntoView({ behavior: 'smooth' })}
                  >
                    Explorer ansehen
                  </button>
                </div>
                <dl className="hero__metrics">
                  <div>
                    <dt>API Base</dt>
                    <dd>{import.meta.env.VITE_API_URL ?? 'http://localhost:4000'}</dd>
                  </div>
                  <div>
                    <dt>Audit Trail</dt>
                    <dd>Session-Protokolle &amp; Queue Monitoring aktiv</dd>
                  </div>
                  <div>
                    <dt>SLA</dt>
                    <dd>&lt; 5 Minuten bis Analyse-Start</dd>
                  </div>
                </dl>
              </div>
              <aside className="hero__card" aria-label="Wizard Pipeline">
                <h3>Upload-Pipeline</h3>
                <p className="hero__card-helper">Validierung, Dateiannahme und Übergabe an Worker – automatisiert in drei
                  Schritten.</p>
                <ul className="hero__card-list">
                  <li>
                    <span>1</span>
                    <div>
                      <strong>Erfassung</strong>
                      <p>Titel, Sichtbarkeit, Tags und Governance-Vorgaben werden live geprüft.</p>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>Validierung</strong>
                      <p>Drag &amp; Drop, Duplikat-Prüfung sowie Größenlimits garantieren konsistente Ingests.</p>
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <strong>Freigabe</strong>
                      <p>Review-Summary mit Gallery-Zuordnung &amp; Übergabe an Analyse-Worker.</p>
                    </div>
                  </li>
                </ul>
                <div className="hero__card-footer">
                  <span>Analyse-Queue aktiv</span>
                  <span>Checksum &amp; Prompt-Parsing inklusive</span>
                </div>
              </aside>
            </div>
          </section>

          <section className="trust" aria-label="Kundennutzen">
            <h2>Vertrauenswürdige KI-Produktionen</h2>
            <p>Studios wie <strong>NeoFrame Labs</strong>, <strong>FrameForge</strong> und <strong>Atlas Render</strong> setzen
              auf VisionSuit für revisionssichere Uploads und transparente Datenströme.</p>
            <div className="trust__stats">
              <article>
                <h3>99,8%</h3>
                <p>erfolgreiche Upload-Validierungen dank Zod-gestützter Eingangsprüfung.</p>
              </article>
              <article>
                <h3>24/7</h3>
                <p>Self-Service Uploads über Wizard &amp; API – inklusive Audit Logging.</p>
              </article>
              <article>
                <h3>&lt; 60s</h3>
                <p>bis zur Worker-Queue für Safetensors, Prompts und Referenzbilder.</p>
              </article>
            </div>
          </section>

          <section className="panel panel--accent hero__highlights" id="features">
            <header className="panel__header">
              <div>
                <h2 className="panel__title">Feature Matrix</h2>
                <p className="panel__subtitle">
                  Tools für Operations, Sicherheit und Automatisierung – einsatzbereit für produktive Teams.
                </p>
              </div>
            </header>
            <div className="hero__highlight-grid">
              <article className="hero__highlight">
                <h3>Operations &amp; Sicherheit</h3>
                <p>Jede Upload-Session erhält eine eindeutige Referenz inklusive Status, Owner und Audit-Log.</p>
                <ul className="hero__highlight-list">
                  <li>Versionierung pro Upload-Lauf</li>
                  <li>Visibility-Policies (Privat/Public)</li>
                  <li>Robuste Validierungen &amp; Limits</li>
                </ul>
              </article>
              <article className="hero__highlight">
                <h3>Analyse &amp; Automatisierung</h3>
                <p>Worker extrahieren Checksums, Prompt-Daten und Tag-Empfehlungen direkt nach Abschluss des Uploads.</p>
                <ul className="hero__highlight-list">
                  <li>Safetensor-Checksum-Berechnung</li>
                  <li>EXIF/Prompt Parsing für Renders</li>
                  <li>Automatische Gallery-Vorschläge</li>
                </ul>
              </article>
              <article className="hero__highlight">
                <h3>Integrationen</h3>
                <p>Out-of-the-box Integration für MinIO-Speicher, Prisma-Datenmodell und CI/CD-taugliche Deployments.</p>
                <ul className="hero__highlight-list">
                  <li>S3-kompatibler Storage</li>
                  <li>API-ready für Automationen</li>
                  <li>CLI-Installer inkl. Secrets</li>
                </ul>
              </article>
            </div>
          </section>

          <section className="panel panel--frosted" aria-labelledby="governance-title" id="governance">
            <header className="panel__header">
              <div>
                <h2 className="panel__title" id="governance-title">Governance Cockpit</h2>
                <p className="panel__subtitle">
                  Überblick über Assets, Galerien, Tags und Aktivität – aktualisiert mit jedem Upload.
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

          <section className="panel panel--outline process" id="pipeline">
            <header className="panel__header">
              <div>
                <h2 className="panel__title">Upload-Governance in vier Phasen</h2>
                <p className="panel__subtitle">
                  Von der initialen Validierung bis zur Veröffentlichung in der Asset-Bibliothek – jede Phase ist nachvollziehbar
                  dokumentiert.
                </p>
              </div>
            </header>
            <ol className="process__timeline">
              <li>
                <span className="process__index">1</span>
                <div>
                  <h3>Session anlegen</h3>
                  <p>Wizard erstellt eine Upload-Session mit Owner, Sichtbarkeit und erwarteten Artefakten.</p>
                </div>
              </li>
              <li>
                <span className="process__index">2</span>
                <div>
                  <h3>Ingest &amp; Prüfungen</h3>
                  <p>MIME-Checks, Größenlimits und Checksums sichern Assets bereits vor der Worker-Verarbeitung ab.</p>
                </div>
              </li>
              <li>
                <span className="process__index">3</span>
                <div>
                  <h3>Analyse-Worker</h3>
                  <p>EXIF-/Prompt-Parsing, Safetensor-Metadaten sowie Tag-Suggestions laufen asynchron im Hintergrund.</p>
                </div>
              </li>
              <li>
                <span className="process__index">4</span>
                <div>
                  <h3>Release &amp; Monitoring</h3>
                  <p>Nach erfolgreicher Analyse erscheinen Assets im Explorer, inklusive Audit-Trail und Gallery-Verknüpfung.</p>
                </div>
              </li>
            </ol>
          </section>

          <section className="cta-panel" aria-label="Onboarding">
            <div>
              <h2>Bereit für produktive Teams</h2>
              <p>
                Der Wizard führt dein Team vom ersten Upload bis zum Review mit klaren Statusangaben und strukturierter
                Übergabe. Überwache Fortschritt, wiederhole Uploads oder erweitere Metadaten – alles in einem Panel.
              </p>
            </div>
            <div className="cta-panel__actions">
              <button
                type="button"
                className="panel__action panel__action--primary"
                onClick={() => setIsUploadWizardOpen(true)}
              >
                Jetzt Upload planen
              </button>
              <span>Keine Sorge: Demo-Daten bleiben erhalten.</span>
            </div>
          </section>

          <section id="explorer" className="panel-anchor">
            <AssetExplorer
              assets={assets}
              isLoading={isLoading}
              onStartUpload={() => setIsUploadWizardOpen(true)}
            />
          </section>
          <section className="panel-anchor">
            <GalleryExplorer galleries={galleries} isLoading={isLoading} />
          </section>
        </main>

        <footer className="footer" aria-label="Footer">
          <div>
            <span className="footer__title">VisionSuit</span>
            <p>Produktionsreifes Control Panel für KI-Assets &amp; Galerien.</p>
          </div>
          <div className="footer__links">
            <a href="#overview">Overview</a>
            <a href="#features">Features</a>
            <a href="#pipeline">Pipeline</a>
            <a href="#explorer">Explorer</a>
          </div>
          <div className="footer__status">
            <strong>Status</strong>
            <span>{errorMessage ? 'Backend aktuell offline' : 'Alle Systeme grün'}</span>
          </div>
        </footer>
      </div>
      <UploadWizard
        isOpen={isUploadWizardOpen}
        onClose={() => setIsUploadWizardOpen(false)}
        onComplete={handleWizardCompletion}
      />
    </div>
  );
};

export default App;
