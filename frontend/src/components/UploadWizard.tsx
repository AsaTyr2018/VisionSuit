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
    label: { asset: 'Basic information', gallery: 'Gallery settings' },
    helper: {
      asset: 'Set title, type, and visibility',
      gallery: 'Choose target gallery, visibility, and tags',
    },
  },
  {
    id: 'files' as const,
    label: { asset: 'Files', gallery: 'Image files' },
    helper: {
      asset: 'Add LoRA or image files',
      gallery: 'Add multiple images and respect limits',
    },
  },
  {
    id: 'review' as const,
    label: { asset: 'Review', gallery: 'Review' },
    helper: {
      asset: 'Review summary & submit',
      gallery: 'Review summary & submit',
    },
  },
] as const;

type StepId = (typeof stepDefinitions)[number]['id'];

type AssetTypee = 'lora' | 'image';

type Visibility = 'private' | 'public';

type GalleryMode = 'existing' | 'new';

interface UploadFormState {
  assetTypee: AssetTypee;
  title: string;
  description: string;
  visibility: Visibility;
  category: string;
  trigger: string;
  galleryMode: GalleryMode;
  targetGallery: string;
  tags: string[];
}

const buildInitialState = (mode: UploadWizardMode): UploadFormState => ({
  assetTypee: mode === 'gallery' ? 'image' : 'lora',
  title: '',
  description: '',
  visibility: 'private',
  category: 'style',
  trigger: '',
  galleryMode: mode === 'gallery' ? 'existing' : 'new',
  targetGallery: '',
  tags: [],
});

const CATEGORY_LABELS: Record<string, string> = {
  style: 'Style & look',
  character: 'Character / person',
  environment: 'Environment / setting',
  workflow: 'Workflow / utility',
};

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
};

const summarizeTags = (tags: string[]) => {
  if (tags.length === 0) return 'No tags assigned';
  if (tags.length < 4) return tags.join(', ');
  return `${tags.slice(0, 3).join(', ')} … (+${tags.length - 3})`;
};

const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|webp|gif)$/i;

const isImageFile = (file: File) => file.type.startsWith('image/') || IMAGE_EXTENSION_PATTERN.test(file.name);

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
        setGalleryError('Galleries could not be loaded. Please try again later.');
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

    if (!isGalleryMode) {
      setFiles((prev) => {
        let modelFile: File | null = null;
        let previewFile: File | null = null;

        for (const file of prev) {
          if (isImageFile(file)) {
            if (!previewFile) {
              previewFile = file;
            }
          } else if (!modelFile) {
            modelFile = file;
          }
        }

        for (const file of normalized) {
          if (isImageFile(file)) {
            if (previewFile && previewFile.name !== file.name) {
              nextError = 'Only one preview image can be uploaded per model.';
              continue;
            }
            previewFile = file;
            continue;
          }

          if (modelFile && modelFile.name !== file.name) {
            nextError = 'Only one model file can be selected per upload.';
            continue;
          }

          modelFile = file;
        }

        const candidate: File[] = [];
        if (modelFile) candidate.push(modelFile);
        if (previewFile) candidate.push(previewFile);

        const total = candidate.reduce((sum, file) => sum + file.size, 0);
        if (total > MAX_TOTAL_SIZE_BYTES) {
          nextError = `The total size exceeds the limit of ${formatFileSize(MAX_TOTAL_SIZE_BYTES)}.`;
          return prev;
        }

        return candidate;
      });

      setStepError(nextError);
      return;
    }

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

      const filtered = incoming.filter((file) => {
        if (isImageFile(file)) {
          return true;
        }
        if (!nextError) {
          nextError = 'Only image files (PNG, JPG, WebP, GIF) can be uploaded to a gallery.';
        }
        return false;
      });

      const availableSlots = MAX_UPLOAD_FILES - merged.length;
      if (availableSlots <= 0) {
        nextError = `A maximum of ${MAX_UPLOAD_FILES} files can be processed per upload.`;
        return merged;
      }

      const toAdd = filtered.slice(0, availableSlots);
      if (filtered.length > toAdd.length) {
        nextError = `A maximum of ${MAX_UPLOAD_FILES} files can be processed per upload.`;
      }

      const updated = [...merged, ...toAdd];
      const total = updated.reduce((sum, file) => sum + file.size, 0);
      if (total > MAX_TOTAL_SIZE_BYTES) {
        nextError = `The total size exceeds the limit of ${formatFileSize(MAX_TOTAL_SIZE_BYTES)}.`;
        return prev;
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
            ? 'Please provide an upload title for the new images.'
            : 'Please provide a title for the asset.',
        );
        return false;
      }
      if (formState.galleryMode === 'existing' && !formState.targetGallery.trim()) {
        setStepError('Please specify an existing gallery or choose "New gallery".');
        return false;
      }
      if (!isGalleryMode && formState.assetTypee === 'lora' && !formState.trigger.trim()) {
        setStepError('Please provide a trigger or activator phrase for the model.');
        return false;
      }
      setStepError(null);
      return true;
    }

    if (step === 'files') {
      if (files.length === 0) {
        setStepError(
          isGalleryMode ? 'Please add at least one file.' : 'Please add a model file.',
        );
        return false;
      }

      if (!isGalleryMode) {
        const modelFiles = files.filter((file) => !isImageFile(file));
        const previewFiles = files.filter((file) => isImageFile(file));

        if (modelFiles.length === 0) {
          setStepError('Please add a model file.');
          return false;
        }

        if (modelFiles.length > 1) {
          setStepError('Only one model file can be processed per upload.');
          return false;
        }

        if (previewFiles.length > 1) {
          setStepError('Only one preview image can be added per upload.');
          return false;
        }
      } else if (files.length > MAX_UPLOAD_FILES) {
        setStepError(`A maximum of ${MAX_UPLOAD_FILES} files can be processed per upload.`);
        return false;
      }

      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (total > MAX_TOTAL_SIZE_BYTES) {
        setStepError(`The total size exceeds the limit of ${formatFileSize(MAX_TOTAL_SIZE_BYTES)}.`);
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
      { label: isGalleryMode ? 'Upload title' : 'Title', value: formState.title || '–' },
      { label: isGalleryMode ? 'Description / note' : 'Description', value: formState.description || '–' },
      {
        label: 'Visibility',
        value:
          formState.visibility === 'public'
            ? 'Public'
            : formState.galleryMode === 'existing'
              ? 'Private (inherits gallery visibility)'
              : 'Private',
      },
      { label: 'Tags', value: summarizeTags(formState.tags) },
      {
        label: 'Target gallery',
        value: isGalleryMode
          ? formState.galleryMode === 'existing'
            ? selectedTargetGallery
              ? `${selectedTargetGallery.title} (${selectedTargetGallery.owner.displayName})`
              : formState.targetGallery
                ? 'Selected gallery no longer available'
                : 'Select a gallery'
            : 'New gallery will be created after the upload'
          : 'New gallery will be created automatically',
      },
      { label: 'Files', value: `${files.length} · ${formatFileSize(totalSize)}` },
    ];

    if (!isGalleryMode) {
      base.splice(2, 0, {
        label: 'Type',
        value: formState.assetTypee === 'lora' ? 'LoRA / safetensor' : 'Image / render',
      });
      base.splice(4, 0, {
        label: 'Category',
        value: CATEGORY_LABELS[formState.category] ?? 'General',
      });
      base.splice(5, 0, {
        label: 'Trigger / Activator',
        value: formState.trigger ? formState.trigger : '–',
      });
    } else {
      base.splice(2, 0, { label: 'Upload context', value: 'Gallery draft (images)' });
      base.push({
        label: 'Upload limits',
        value: `${MAX_UPLOAD_FILES} files · up to ${formatFileSize(MAX_TOTAL_SIZE_BYTES)}`,
      });
    }

    if (files.length > 0 && formState.assetTypee === 'lora') {
      base.push({ label: 'Checksum preview', value: 'Calculated by backend after upload' });
    }

    if (files.length > 0 && formState.assetTypee === 'image' && !isGalleryMode) {
      base.push({ label: 'EXIF/prompt', value: 'Extraction queued after upload' });
    }

    return base;
  }, [
    files.length,
    formState.assetTypee,
    formState.category,
    formState.description,
    formState.galleryMode,
    formState.trigger,
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
      setSubmitResult({ status: 'error', message: 'Sign-in required to start uploads.' });
      return;
    }

    setIsSubmitting(true);
    setSubmitResult(null);
    setProgressValue(0);

    try {
      await simulateProgress((value) => setProgressValue(Math.min(95, Math.round(value))));

      const assetTypee = isGalleryMode ? 'image' : formState.assetTypee;
      const title = formState.title.trim();
      const description = formState.description.trim();
      const targetGallery = formState.targetGallery.trim();
      const trigger = formState.trigger.trim();

      const response = await api.createUploadDraft(
        {
          assetTypee,
          context: isGalleryMode ? 'gallery' : 'asset',
          title,
          description: description.length > 0 ? description : undefined,
          visibility: formState.visibility,
          category: !isGalleryMode ? formState.category : undefined,
          trigger: !isGalleryMode && assetTypee === 'lora' && trigger.length > 0 ? trigger : undefined,
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
        response.gallerySlug ? `Gallery: ${response.gallerySlug}` : null,
        response.imageIds && response.imageIds.length > 1
          ? `${response.imageIds.length} images`
          : response.imageId
            ? '1 image'
            : null,
      ]
        .filter(Boolean)
        .join(' · ');

      const result: UploadWizardResult = {
        status: 'success',
        uploadId: response.uploadId,
        message:
          response.message ??
          `Upload complete. ${
            details.length > 0
              ? `${details} are immediately available in the explorer.`
              : 'Files are immediately available in the explorer.'
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
          : 'Upload could not be started. Please try again later.';
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
            <h2 id="upload-wizard-title">{isGalleryMode ? 'Gallery upload' : 'Upload assistant'}</h2>
            <p>
              {isGalleryMode
                ? 'Add new images to existing collections or start a new gallery in a structured way.'
                : 'Introduce new LoRAs or renderings in a structured way. An upload session is created automatically after completion.'}
            </p>
          </div>
          <button type="button" className="upload-wizard__close" onClick={onClose}>
            Close
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
                  <span>Upload title*</span>
                  <input
                    type="text"
                    value={formState.title}
                    onChange={(event) => setFormState((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder={
                      isGalleryMode
                        ? 'e.g. Spotlight Series – Night Shots'
                        : 'e.g. Neon Depth Portrait Pack'
                    }
                  />
                </label>
              </div>

              <div className="upload-wizard__field upload-wizard__field--inline">
                <label>
                  <span>Visibility</span>
                  <div className="upload-wizard__options">
                    <label>
                      <input
                        type="radio"
                        name="asset-visibility"
                        value="private"
                        checked={formState.visibility === 'private'}
                        onChange={() => setFormState((prev) => ({ ...prev, visibility: 'private' }))}
                      />
                      <span>Private</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="asset-visibility"
                        value="public"
                        checked={formState.visibility === 'public'}
                        onChange={() => setFormState((prev) => ({ ...prev, visibility: 'public' }))}
                      />
                      <span>Public</span>
                    </label>
                  </div>
                </label>
              </div>

              {!isGalleryMode ? (
                <div className="upload-wizard__field">
                  <label>
                    <span>Category</span>
                    <select
                      value={formState.category}
                      onChange={(event) => setFormState((prev) => ({ ...prev, category: event.target.value }))}
                    >
                      <option value="style">Style & look</option>
                      <option value="character">Character / person</option>
                      <option value="environment">Environment / setting</option>
                      <option value="workflow">Workflow / utility</option>
                    </select>
                  </label>
                </div>
              ) : null}

              {!isGalleryMode ? (
                <div className="upload-wizard__field">
                  <label>
                    <span>Trigger / Activator*</span>
                    <input
                      type="text"
                      value={formState.trigger}
                      onChange={(event) => setFormState((prev) => ({ ...prev, trigger: event.target.value }))}
                      placeholder="Primary activation phrase"
                      required
                    />
                  </label>
                </div>
              ) : null}

              <div className="upload-wizard__field upload-wizard__field--full">
                <label>
                  <span>{isGalleryMode ? 'Description / note' : 'Description'}</span>
                  <textarea
                    value={formState.description}
                    onChange={(event) => setFormState((prev) => ({ ...prev, description: event.target.value }))}
                    placeholder={
                      isGalleryMode
                        ? 'Optional prompt context or notes about the series…'
                        : 'Context, special considerations, trigger words, or base models…'
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
                      placeholder="Add a tag and press Enter"
                    />
                  </div>
                </label>
              </div>

              {isGalleryMode ? (
                <div className="upload-wizard__field upload-wizard__field--full">
                  <span>Gallery assignment</span>
                  <div className="upload-wizard__options upload-wizard__options--stacked">
                    <label>
                      <input
                        type="radio"
                        name="gallery-mode"
                        value="existing"
                        checked={formState.galleryMode === 'existing'}
                        onChange={() => setFormState((prev) => ({ ...prev, galleryMode: 'existing' }))}
                      />
                      <span>Add to existing gallery</span>
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
                          ? 'Create a new gallery during the upload'
                          : 'Create a new gallery during the review step'}
                      </span>
                    </label>
                  </div>
                  {formState.galleryMode === 'existing' ? (
                    <div className="upload-wizard__gallery-select">
                      <label>
                        <span className="sr-only">Existing gallery</span>
                        <select
                          value={formState.targetGallery}
                          onChange={(event) =>
                            setFormState((prev) => ({ ...prev, targetGallery: event.target.value }))
                          }
                          disabled={isLoadingGalleries || availableGalleries.length === 0}
                        >
                          <option value="">
                            {isLoadingGalleries
                              ? 'Loading galleries…'
                              : availableGalleries.length === 0
                                ? 'No gallery available'
                                : 'Select a gallery'}
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
                          No matching galleries found. Create a new gallery or adjust the selection.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

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
                <span>Drag files here or click to choose.</span>
                <span className="upload-wizard__dropzone-helper">
                  {isGalleryMode
                    ? `Supports PNG, JPG, WebP, and GIF. Select up to ${MAX_UPLOAD_FILES} files with a combined size of ${formatFileSize(
                        MAX_TOTAL_SIZE_BYTES,
                      )}.`
                    : `Supports safetensors or ZIP bundles for the model plus an optional PNG, JPG, WebP, or GIF preview. Upload up to one model and one preview with a combined size of ${formatFileSize(
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
                          {formatFileSize(file.size)} · {file.type || 'File type determined during upload'}
                        </span>
                      </div>
                      <button type="button" onClick={() => removeFile(file.name)}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="upload-wizard__file-summary">
                    Total: {files.length} file{files.length === 1 ? '' : 's'} · {formatFileSize(totalSize)}
                  </div>
                </div>
              ) : (
                <p className="upload-wizard__empty">No files selected yet.</p>
              )}
            </div>
          ) : null}

          {currentStep.id === 'review' ? (
            <div className="upload-wizard__review">
              <div className="upload-wizard__review-card">
                <h3>Summary</h3>
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
                <h3>Next steps</h3>
                <ul>
                  <li>An upload session is created and files are transferred sequentially.</li>
                  <li>After completion, the analysis worker automatically inspects safetensor headers or EXIF/prompt data.</li>
                  <li>You will be notified in the dashboard once gallery or LoRA library assignments are complete.</li>
                </ul>
              </div>

              {submitResult ? (
                <div
                  className={`upload-wizard__result upload-wizard__result--${submitResult.status === 'success' ? 'success' : 'error'}`}
                >
                  {submitResult.status === 'success' ? (
                    <>
                      <strong>Upload started</strong>
                      <span>
                        {submitResult.message}
                        {submitResult.uploadId ? ` (ID: ${submitResult.uploadId})` : ''}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>Error</strong>
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
                  <span>Transferring… {progressValue}%</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {stepError ? <p className="upload-wizard__error">{stepError}</p> : null}

        <footer className="upload-wizard__footer">
          <div className="upload-wizard__footer-meta">
            <span>
              Step {currentStepIndex + 1} of {steps.length}
            </span>
            <span>{currentStep.helper}</span>
          </div>
          <div className="upload-wizard__footer-actions">
            <button type="button" className="panel__action" onClick={currentStepIndex === 0 ? onClose : handleBack}>
              {currentStepIndex === 0 ? 'Cancel' : 'Back'}
            </button>
            {currentStep.id !== 'review' ? (
              <button type="button" className="panel__action panel__action--primary" onClick={handleNext}>
                Next
              </button>
            ) : (
              <button
                type="button"
                className="panel__action panel__action--primary"
                onClick={handleSubmit}
                disabled={isSubmitting || submitResult?.status === 'success'}
              >
                Start upload
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
};
