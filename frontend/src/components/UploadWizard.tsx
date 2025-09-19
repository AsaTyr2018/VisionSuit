import { useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';

import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MAX_TOTAL_SIZE_BYTES, MAX_UPLOAD_FILES } from '../lib/uploadLimits';
import type { Gallery } from '../types/api';

export type UploadWizardResult =
  | { status: 'success'; uploadId?: string; message?: string }
  | { status: 'error'; message: string; details?: string[] };

type UploadWizardMode = 'asset' | 'gallery';

interface UploadWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete?: (result: UploadWizardResult) => void;
  mode?: UploadWizardMode;
}

const stepDefinitions = [
  {
    id: 'details' as const,
    label: { asset: 'Basisdaten', gallery: 'Galerie-Einstellungen' },
    helper: {
      asset: 'Titel, Typ und Sichtbarkeit festlegen',
      gallery: 'Ziel-Galerie, Sichtbarkeit und Tags wählen',
    },
  },
  {
    id: 'files' as const,
    label: { asset: 'Dateien', gallery: 'Bilddateien' },
    helper: {
      asset: 'LoRA- oder Bilddateien hinzufügen',
      gallery: 'Mehrere Bilder hinzufügen und Limits beachten',
    },
  },
  {
    id: 'review' as const,
    label: { asset: 'Review', gallery: 'Review' },
    helper: {
      asset: 'Zusammenfassung prüfen & absenden',
      gallery: 'Zusammenfassung prüfen & absenden',
    },
  },
] as const;

type StepId = (typeof stepDefinitions)[number]['id'];

type AssetType = 'lora' | 'image';

type Visibility = 'private' | 'public';

type GalleryMode = 'existing' | 'new';

interface UploadFormState {
  assetType: AssetType;
  title: string;
  description: string;
  visibility: Visibility;
  category: string;
  galleryMode: GalleryMode;
  targetGallery: string;
  tags: string[];
}

const buildInitialState = (mode: UploadWizardMode): UploadFormState => ({
  assetType: mode === 'gallery' ? 'image' : 'lora',
  title: '',
  description: '',
  visibility: 'private',
  category: 'style',
  galleryMode: 'existing',
  targetGallery: '',
  tags: [],
});

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
};

const summarizeTags = (tags: string[]) => {
  if (tags.length === 0) return 'Keine Tags vergeben';
  if (tags.length < 4) return tags.join(', ');
  return `${tags.slice(0, 3).join(', ')} … (+${tags.length - 3})`;
};

const simulateProgress = (update: (value: number) => void) =>
  new Promise<void>((resolve) => {
    let progress = 12;
    update(progress);
    const interval = window.setInterval(() => {
      progress += Math.random() * 18 + 8;
      if (progress >= 92) {
        update(92);
        window.clearInterval(interval);
        resolve();
      } else {
        update(progress);
      }
    }, 280);
  });

export const UploadWizard = ({ isOpen, onClose, onComplete, mode = 'asset' }: UploadWizardProps) => {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [formState, setFormState] = useState<UploadFormState>(() => buildInitialState(mode));
  const [tagDraft, setTagDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [stepError, setStepError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<UploadWizardResult | null>(null);
  const [progressValue, setProgressValue] = useState(0);
  const [availableGalleries, setAvailableGalleries] = useState<Gallery[]>([]);
  const [isLoadingGalleries, setIsLoadingGalleries] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const { token, user } = useAuth();

  const isGalleryMode = mode === 'gallery';
  const steps = useMemo(
    () =>
      stepDefinitions.map((step) => ({
        id: step.id,
        label: isGalleryMode ? step.label.gallery : step.label.asset,
        helper: isGalleryMode ? step.helper.gallery : step.helper.asset,
      })),
    [isGalleryMode],
  );

  const currentStep = steps[currentStepIndex];

  const userId = user?.id;
  const userRole = user?.role;

  const selectedTargetGallery = useMemo(
    () => availableGalleries.find((gallery) => gallery.slug === formState.targetGallery.trim()),
    [availableGalleries, formState.targetGallery],
  );

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setCurrentStepIndex(0);
      setFormState(buildInitialState(mode));
      setTagDraft('');
      setFiles([]);
      setStepError(null);
      setSubmitResult(null);
      setProgressValue(0);
      setIsSubmitting(false);
      setAvailableGalleries([]);
      setIsLoadingGalleries(false);
      setGalleryError(null);
    }
  }, [isOpen, mode]);

  useEffect(() => {
    if (!isOpen || !isGalleryMode) {
      return;
    }

    let isActive = true;

    const loadGalleries = async () => {
      setIsLoadingGalleries(true);
      setGalleryError(null);

      try {
        const entries = await api.getGalleries();
        if (!isActive) return;

        const filtered =
          userRole === 'ADMIN'
            ? entries
            : entries.filter((gallery) => (userId ? gallery.owner.id === userId : false));

        setAvailableGalleries(filtered);
      } catch (error) {
        if (!isActive) return;
        console.error('Failed to load galleries for upload wizard', error);
        setAvailableGalleries([]);
        setGalleryError('Galerien konnten nicht geladen werden. Bitte später erneut versuchen.');
      } finally {
        if (isActive) {
          setIsLoadingGalleries(false);
        }
      }
    };

    void loadGalleries();

    return () => {
      isActive = false;
    };
  }, [isOpen, isGalleryMode, userId, userRole]);

  useEffect(() => {
    if (!isGalleryMode || formState.galleryMode !== 'existing') {
      return;
    }

    const trimmedTarget = formState.targetGallery.trim();
    const hasSelection = trimmedTarget.length > 0;
    const match = availableGalleries.some((gallery) => gallery.slug === trimmedTarget);

    if (hasSelection && !match) {
      setFormState((prev) => ({ ...prev, targetGallery: '' }));
      return;
    }

    if (!hasSelection && availableGalleries.length === 1) {
      setFormState((prev) => ({ ...prev, targetGallery: availableGalleries[0].slug }));
    }
  }, [availableGalleries, formState.galleryMode, formState.targetGallery, isGalleryMode]);

  const handleAddTag = () => {
    const trimmed = tagDraft.trim();
    if (!trimmed) return;
    if (formState.tags.includes(trimmed.toLowerCase())) {
      setTagDraft('');
      return;
    }
    setFormState((prev) => ({ ...prev, tags: [...prev.tags, trimmed] }));
    setTagDraft('');
  };

  const handleRemoveTag = (tag: string) => {
    setFormState((prev) => ({ ...prev, tags: prev.tags.filter((value) => value !== tag) }));
  };

  const handleFiles = (selected: FileList | File[]) => {
    const normalized = Array.from(selected);
    if (normalized.length === 0) {
      return;
    }

    let nextError: string | null = null;

    setFiles((prev) => {
      const names = new Set(prev.map((file) => file.name));
      const merged = [...prev];
      const incoming = normalized.filter((file) => {
        if (names.has(file.name)) {
          return false;
        }
        names.add(file.name);
        return true;
      });

      let filtered = incoming;
      if (isGalleryMode) {
        filtered = incoming.filter((file) => file.type.startsWith('image/'));
        if (filtered.length !== incoming.length) {
          nextError = 'Nur Bilddateien (PNG, JPG, WebP, GIF) können in eine Galerie hochgeladen werden.';
        }
      }

      const availableSlots = MAX_UPLOAD_FILES - merged.length;
      if (availableSlots <= 0) {
        nextError = `Es können maximal ${MAX_UPLOAD_FILES} Dateien pro Upload verarbeitet werden.`;
        return merged;
      }

      const toAdd = filtered.slice(0, availableSlots);
      if (filtered.length > toAdd.length) {
        nextError = `Es können maximal ${MAX_UPLOAD_FILES} Dateien pro Upload verarbeitet werden.`;
      }

      const updated = [...merged, ...toAdd];
      const total = updated.reduce((sum, file) => sum + file.size, 0);
      if (total > MAX_TOTAL_SIZE_BYTES) {
        nextError = `Die Gesamtgröße überschreitet das Limit von ${formatFileSize(MAX_TOTAL_SIZE_BYTES)}.`;
      }

      return updated;
    });

    setStepError(nextError);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files) {
      handleFiles(event.dataTransfer.files);
    }
  };

  const removeFile = (name: string) => {
    setFiles((prev) => prev.filter((file) => file.name !== name));
    setStepError(null);
  };

  const validateStep = (step: StepId) => {
    if (step === 'details') {
      if (!formState.title.trim()) {
        setStepError(
          isGalleryMode
            ? 'Bitte vergib einen Upload-Titel für die neuen Bilder.'
            : 'Bitte vergib einen Titel für das Asset.',
        );
        return false;
      }
      if (formState.galleryMode === 'existing' && !formState.targetGallery.trim()) {
        setStepError('Bitte gib eine bestehende Galerie an oder wähle "Neue Galerie".');
        return false;
      }
      setStepError(null);
      return true;
    }

    if (step === 'files') {
      if (files.length === 0) {
        setStepError('Bitte füge mindestens eine Datei hinzu.');
        return false;
      }
      if (files.length > MAX_UPLOAD_FILES) {
        setStepError(`Es können maximal ${MAX_UPLOAD_FILES} Dateien pro Upload verarbeitet werden.`);
        return false;
      }
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (total > MAX_TOTAL_SIZE_BYTES) {
        setStepError(`Die Gesamtgröße überschreitet das Limit von ${formatFileSize(MAX_TOTAL_SIZE_BYTES)}.`);
        return false;
      }
      setStepError(null);
      return true;
    }

    setStepError(null);
    return true;
  };

  const goToStep = (index: number) => {
    if (index < 0 || index >= steps.length) return;
    setCurrentStepIndex(index);
  };

  const handleNext = () => {
    const stepId = steps[currentStepIndex].id;
    if (!validateStep(stepId)) return;
    goToStep(Math.min(currentStepIndex + 1, steps.length - 1));
  };

  const handleBack = () => {
    goToStep(Math.max(currentStepIndex - 1, 0));
  };

  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  const reviewMetadata = useMemo(() => {
    const base = [
      { label: isGalleryMode ? 'Upload-Titel' : 'Titel', value: formState.title || '–' },
      { label: isGalleryMode ? 'Beschreibung / Notiz' : 'Beschreibung', value: formState.description || '–' },
      {
        label: 'Sichtbarkeit',
        value:
          formState.visibility === 'public'
            ? 'Öffentlich'
            : formState.galleryMode === 'existing'
              ? 'Privat (übernimmt Sichtbarkeit der Galerie)'
              : 'Privat',
      },
      { label: 'Tags', value: summarizeTags(formState.tags) },
      {
        label: 'Ziel-Galerie',
        value:
          formState.galleryMode === 'existing'
            ? selectedTargetGallery
              ? `${selectedTargetGallery.title} (${selectedTargetGallery.owner.displayName})`
              : formState.targetGallery
                ? 'Ausgewählte Galerie nicht mehr verfügbar'
                : 'Bitte Galerie auswählen'
            : 'Neue Galerie wird nach Upload angelegt',
      },
      { label: 'Dateien', value: `${files.length} · ${formatFileSize(totalSize)}` },
    ];

    if (!isGalleryMode) {
      base.splice(2, 0, {
        label: 'Typ',
        value: formState.assetType === 'lora' ? 'LoRA / Safetensor' : 'Bild / Render',
      });
      base.splice(4, 0, { label: 'Kategorie', value: formState.category || 'Allgemein' });
    } else {
      base.splice(2, 0, { label: 'Upload-Kontext', value: 'Galerie-Entwurf (Bilder)' });
      base.push({
        label: 'Upload-Limits',
        value: `${MAX_UPLOAD_FILES} Dateien · bis ${formatFileSize(MAX_TOTAL_SIZE_BYTES)}`,
      });
    }

    if (files.length > 0 && formState.assetType === 'lora') {
      base.push({ label: 'Checksum-Vorschau', value: 'Wird nach Upload vom Backend berechnet' });
    }

    if (files.length > 0 && formState.assetType === 'image' && !isGalleryMode) {
      base.push({ label: 'EXIF/Prompt', value: 'Extraktion nach Upload in Warteschlange' });
    }

    return base;
  }, [
    files.length,
    formState.assetType,
    formState.category,
    formState.description,
    formState.galleryMode,
    formState.tags,
    formState.targetGallery,
    formState.title,
    formState.visibility,
    isGalleryMode,
    selectedTargetGallery,
    totalSize,
  ]);

  const handleSubmit = async () => {
    if (!validateStep('files')) {
      goToStep(1);
      return;
    }
    if (!validateStep('review')) {
      return;
    }

    if (!token) {
      setSubmitResult({ status: 'error', message: 'Anmeldung erforderlich, um Uploads zu starten.' });
      return;
    }

    setIsSubmitting(true);
    setSubmitResult(null);
    setProgressValue(0);

    try {
      await simulateProgress((value) => setProgressValue(Math.min(95, Math.round(value))));

      const assetType = isGalleryMode ? 'image' : formState.assetType;
      const title = formState.title.trim();
      const description = formState.description.trim();
      const targetGallery = formState.targetGallery.trim();

      const response = await api.createUploadDraft(
        {
          assetType,
          context: isGalleryMode ? 'gallery' : 'asset',
          title,
          description: description.length > 0 ? description : undefined,
          visibility: formState.visibility,
          category: !isGalleryMode ? formState.category : undefined,
          tags: formState.tags,
          galleryMode: formState.galleryMode,
          targetGallery,
          files,
        },
        token,
      );

      setProgressValue(100);
      const details = [
        response.assetSlug ? `Asset: ${response.assetSlug}` : null,
        response.gallerySlug ? `Galerie: ${response.gallerySlug}` : null,
        response.imageIds && response.imageIds.length > 1
          ? `${response.imageIds.length} Bilder`
          : response.imageId
            ? '1 Bild'
            : null,
      ]
        .filter(Boolean)
        .join(' · ');

      const result: UploadWizardResult = {
        status: 'success',
        uploadId: response.uploadId,
        message:
          response.message ??
          `Upload abgeschlossen. ${
            details.length > 0
              ? `${details} stehen unmittelbar im Explorer bereit.`
              : 'Dateien stehen unmittelbar im Explorer bereit.'
          }`,
      };
      setSubmitResult(result);
      onComplete?.(result);
    } catch (error) {
      if (error instanceof ApiError) {
        const result: UploadWizardResult = {
          status: 'error',
          message: error.message,
          details: error.details,
        };
        setSubmitResult(result);
        onComplete?.(result);
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : 'Upload konnte nicht gestartet werden. Bitte später erneut versuchen.';
      const result: UploadWizardResult = { status: 'error', message };
      setSubmitResult(result);
      onComplete?.(result);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="upload-wizard" role="dialog" aria-modal="true" aria-labelledby="upload-wizard-title">
      <div className="upload-wizard__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="upload-wizard__dialog">
        <header className="upload-wizard__header">
          <div>
            <h2 id="upload-wizard-title">{isGalleryMode ? 'Galerie-Upload' : 'Upload-Assistent'}</h2>
            <p>
              {isGalleryMode
                ? 'Füge neue Bilder strukturiert in bestehende Sammlungen ein oder starte eine frische Galerie.'
                : 'Führe neue LoRAs oder Renderings strukturiert ein. Nach Abschluss wird automatisch eine Upload-Session im Backend angelegt.'}
            </p>
          </div>
          <button type="button" className="upload-wizard__close" onClick={onClose}>
            Schließen
          </button>
        </header>

        <ol className="upload-wizard__steps">
          {steps.map((step, index) => {
            const isActive = index === currentStepIndex;
            const isDone = index < currentStepIndex;
            return (
              <li
                key={step.id}
                className={`upload-wizard__step ${isActive ? 'upload-wizard__step--active' : ''} ${
                  isDone ? 'upload-wizard__step--done' : ''
                }`}
              >
                <span className="upload-wizard__step-index">{index + 1}</span>
                <div>
                  <span className="upload-wizard__step-label">{step.label}</span>
                  <span className="upload-wizard__step-helper">{step.helper}</span>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="upload-wizard__content">
          {currentStep.id === 'details' ? (
            <div className="upload-wizard__grid">
              <div className="upload-wizard__field">
                <label>
                  <span>{isGalleryMode ? 'Upload-Titel*' : 'Titel*'}</span>
                  <input
                    type="text"
                    value={formState.title}
                    onChange={(event) => setFormState((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder={
                      isGalleryMode
                        ? 'z. B. Spotlight Serie – Nachtaufnahmen'
                        : 'z. B. Neon Depth Portrait Pack'
                    }
                  />
                </label>
              </div>

              <div className="upload-wizard__field upload-wizard__field--inline">
                {!isGalleryMode ? (
                  <label>
                    <span>Typ</span>
                    <div className="upload-wizard__options">
                      <label>
                        <input
                          type="radio"
                          name="asset-type"
                          value="lora"
                          checked={formState.assetType === 'lora'}
                          onChange={() => setFormState((prev) => ({ ...prev, assetType: 'lora' }))}
                        />
                        <span>LoRA / Safetensor</span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="asset-type"
                          value="image"
                          checked={formState.assetType === 'image'}
                          onChange={() => setFormState((prev) => ({ ...prev, assetType: 'image' }))}
                        />
                        <span>Bild / Render</span>
                      </label>
                    </div>
                  </label>
                ) : null}

                <label>
                  <span>Sichtbarkeit</span>
                  <div className="upload-wizard__options">
                    <label>
                      <input
                        type="radio"
                        name="asset-visibility"
                        value="private"
                        checked={formState.visibility === 'private'}
                        onChange={() => setFormState((prev) => ({ ...prev, visibility: 'private' }))}
                      />
                      <span>Privat</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="asset-visibility"
                        value="public"
                        checked={formState.visibility === 'public'}
                        onChange={() => setFormState((prev) => ({ ...prev, visibility: 'public' }))}
                      />
                      <span>Öffentlich</span>
                    </label>
                  </div>
                </label>
              </div>

              {!isGalleryMode ? (
                <div className="upload-wizard__field">
                  <label>
                    <span>Kategorie</span>
                    <select
                      value={formState.category}
                      onChange={(event) => setFormState((prev) => ({ ...prev, category: event.target.value }))}
                    >
                      <option value="style">Stil & Look</option>
                      <option value="character">Character / Person</option>
                      <option value="environment">Environment / Setting</option>
                      <option value="workflow">Workflow / Utility</option>
                    </select>
                  </label>
                </div>
              ) : null}

              <div className="upload-wizard__field upload-wizard__field--full">
                <label>
                  <span>{isGalleryMode ? 'Beschreibung / Notiz' : 'Beschreibung'}</span>
                  <textarea
                    value={formState.description}
                    onChange={(event) => setFormState((prev) => ({ ...prev, description: event.target.value }))}
                    placeholder={
                      isGalleryMode
                        ? 'Optionaler Prompt-Kontext oder Hinweise zur Serie …'
                        : 'Kontext, Besonderheiten, Trigger-Wörter oder Basismodelle …'
                    }
                    rows={3}
                  />
                </label>
              </div>

              <div className="upload-wizard__field upload-wizard__field--full">
                <label>
                  <span>Tags</span>
                  <div className="upload-wizard__tags">
                    {formState.tags.map((tag) => (
                      <button key={tag} type="button" onClick={() => handleRemoveTag(tag)}>
                        {tag}
                        <span aria-hidden="true">×</span>
                      </button>
                    ))}
                    <input
                      type="text"
                      value={tagDraft}
                      onChange={(event) => setTagDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ',') {
                          event.preventDefault();
                          handleAddTag();
                        }
                      }}
                      placeholder="Tag hinzufügen und Enter drücken"
                    />
                  </div>
                </label>
              </div>

              <div className="upload-wizard__field upload-wizard__field--full">
                <span>Galerie-Zuordnung</span>
                <div className="upload-wizard__options upload-wizard__options--stacked">
                  <label>
                    <input
                      type="radio"
                      name="gallery-mode"
                      value="existing"
                      checked={formState.galleryMode === 'existing'}
                      onChange={() => setFormState((prev) => ({ ...prev, galleryMode: 'existing' }))}
                    />
                    <span>{isGalleryMode ? 'Zu bestehender Galerie hinzufügen' : 'Zu bestehender Galerie hinzufügen'}</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="gallery-mode"
                      value="new"
                      checked={formState.galleryMode === 'new'}
                      onChange={() => setFormState((prev) => ({ ...prev, galleryMode: 'new', targetGallery: '' }))}
                    />
                    <span>
                      {isGalleryMode
                        ? 'Neue Galerie während des Uploads anlegen'
                        : 'Neue Galerie im Review-Schritt anlegen'}
                    </span>
                  </label>
                </div>
                {formState.galleryMode === 'existing' ? (
                  <div className="upload-wizard__gallery-select">
                    <label>
                      <span className="sr-only">Bestehende Galerie</span>
                      <select
                        value={formState.targetGallery}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, targetGallery: event.target.value }))
                        }
                        disabled={isLoadingGalleries || availableGalleries.length === 0}
                      >
                        <option value="">
                          {isLoadingGalleries
                            ? 'Galerien werden geladen …'
                            : availableGalleries.length === 0
                              ? 'Keine Galerie verfügbar'
                              : 'Bitte Galerie auswählen'}
                        </option>
                        {availableGalleries.map((gallery) => (
                          <option key={gallery.id} value={gallery.slug}>
                            {gallery.title} · {gallery.owner.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    {galleryError ? (
                      <p className="upload-wizard__error" role="alert">
                        {galleryError}
                      </p>
                    ) : null}
                    {!galleryError && !isLoadingGalleries && availableGalleries.length === 0 ? (
                      <p className="upload-wizard__helper">
                        Keine passenden Galerien gefunden. Lege eine neue Galerie an oder ändere die Auswahl.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {currentStep.id === 'files' ? (
            <div className="upload-wizard__files">
              <label
                className="upload-wizard__dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDrop}
              >
                <input
                  type="file"
                  multiple
                  accept={isGalleryMode ? 'image/*' : undefined}
                  onChange={(event) => {
                    if (event.target.files) {
                      handleFiles(event.target.files);
                      event.target.value = '';
                    }
                  }}
                />
                <span>Ziehe Dateien hierher oder klicke, um sie auszuwählen.</span>
                <span className="upload-wizard__dropzone-helper">
                  {isGalleryMode
                    ? `Unterstützt PNG, JPG, WebP und GIF. Mehrfachauswahl bis ${MAX_UPLOAD_FILES} Dateien mit insgesamt ${formatFileSize(
                        MAX_TOTAL_SIZE_BYTES,
                      )}.`
                    : `Unterstützt Safetensors, PNG, JPG sowie ZIP-Bundles. Maximal ${MAX_UPLOAD_FILES} Dateien mit insgesamt ${formatFileSize(
                        MAX_TOTAL_SIZE_BYTES,
                      )}.`}
                </span>
              </label>

              {files.length > 0 ? (
                <div className="upload-wizard__file-list" role="list">
                  {files.map((file) => (
                    <div key={file.name} className="upload-wizard__file" role="listitem">
                      <div>
                        <span className="upload-wizard__file-name">{file.name}</span>
                        <span className="upload-wizard__file-meta">
                          {formatFileSize(file.size)} · {file.type || 'Dateityp wird beim Upload bestimmt'}
                        </span>
                      </div>
                      <button type="button" onClick={() => removeFile(file.name)}>
                        Entfernen
                      </button>
                    </div>
                  ))}
                  <div className="upload-wizard__file-summary">
                    Gesamt: {files.length} Datei{files.length === 1 ? '' : 'en'} · {formatFileSize(totalSize)}
                  </div>
                </div>
              ) : (
                <p className="upload-wizard__empty">Noch keine Dateien ausgewählt.</p>
              )}
            </div>
          ) : null}

          {currentStep.id === 'review' ? (
            <div className="upload-wizard__review">
              <div className="upload-wizard__review-card">
                <h3>Zusammenfassung</h3>
                <dl>
                  {reviewMetadata.map((item) => (
                    <div key={item.label}>
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="upload-wizard__review-card">
                <h3>Nächste Schritte</h3>
                <ul>
                  <li>Upload-Session wird angelegt und Dateien werden nacheinander übertragen.</li>
                  <li>Nach Abschluss prüft der Analyse-Worker automatisch Safetensor-Header bzw. EXIF-/Prompt-Daten.</li>
                  <li>
                    Du erhältst einen Hinweis im Dashboard, sobald die Zuordnung zu Galerien oder LoRA-Bibliothek abgeschlossen
                    ist.
                  </li>
                </ul>
              </div>

              {submitResult ? (
                <div
                  className={`upload-wizard__result upload-wizard__result--${submitResult.status === 'success' ? 'success' : 'error'}`}
                >
                  {submitResult.status === 'success' ? (
                    <>
                      <strong>Upload gestartet</strong>
                      <span>
                        {submitResult.message}
                        {submitResult.uploadId ? ` (ID: ${submitResult.uploadId})` : ''}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>Fehler</strong>
                      <span>{submitResult.message}</span>
                      {submitResult.details && submitResult.details.length > 0 ? (
                        <ul className="upload-wizard__result-details">
                          {submitResult.details.map((detail) => (
                            <li key={detail}>{detail}</li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {isSubmitting ? (
                <div className="upload-wizard__progress" aria-live="polite">
                  <div className="upload-wizard__progress-bar" style={{ width: `${progressValue}%` }} />
                  <span>Übertrage … {progressValue}%</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {stepError ? <p className="upload-wizard__error">{stepError}</p> : null}

        <footer className="upload-wizard__footer">
          <div className="upload-wizard__footer-meta">
            <span>
              Schritt {currentStepIndex + 1} von {steps.length}
            </span>
            <span>{currentStep.helper}</span>
          </div>
          <div className="upload-wizard__footer-actions">
            <button type="button" className="panel__action" onClick={currentStepIndex === 0 ? onClose : handleBack}>
              {currentStepIndex === 0 ? 'Abbrechen' : 'Zurück'}
            </button>
            {currentStep.id !== 'review' ? (
              <button type="button" className="panel__action panel__action--primary" onClick={handleNext}>
                Weiter
              </button>
            ) : (
              <button
                type="button"
                className="panel__action panel__action--primary"
                onClick={handleSubmit}
                disabled={isSubmitting || submitResult?.status === 'success'}
              >
                Upload starten
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
};
