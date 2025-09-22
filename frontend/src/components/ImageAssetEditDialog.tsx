import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react';

import { api, ApiError } from '../lib/api';
import type { ImageAsset } from '../types/api';

interface ImageAssetEditDialogProps {
  isOpen: boolean;
  onClose: () => void;
  image: ImageAsset;
  token: string | null | undefined;
  onSuccess?: (updated: ImageAsset) => void;
  owners: { id: string; label: string }[];
}

const parseTags = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const formatNullable = (value?: string | null) => value ?? '';

type ImageEditTab = 'details' | 'prompts' | 'metadata';

const imageEditTabs: { id: ImageEditTab; label: string; description: string }[] = [
  {
    id: 'details',
    label: 'Details',
    description: 'Retitle the render, adjust descriptions, and manage curator ownership.',
  },
  {
    id: 'prompts',
    label: 'Prompts',
    description: 'Fine-tune positive and negative prompt fields for searchability.',
  },
  {
    id: 'metadata',
    label: 'Metadata',
    description: 'Update seed, sampler, and CFG details for reference.',
  },
];

const formatDateTime = (value: string) => new Date(value).toLocaleString('en-US');

const formatFileSize = (bytes?: number | null) => {
  if (!bytes || Number.isNaN(bytes)) {
    return null;
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let remaining = bytes;
  let unitIndex = 0;

  while (remaining >= 1024 && unitIndex < units.length - 1) {
    remaining /= 1024;
    unitIndex += 1;
  }

  return `${remaining.toFixed(remaining >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatDimensions = (dimensions?: { width: number; height: number }) => {
  if (!dimensions) {
    return null;
  }

  const { width, height } = dimensions;
  if (!width || !height) {
    return null;
  }

  return `${width} × ${height}`;
};

export const ImageAssetEditDialog = ({
  isOpen,
  onClose,
  image,
  token,
  onSuccess,
  owners,
}: ImageAssetEditDialogProps) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [tags, setTags] = useState('');
  const [seed, setSeed] = useState('');
  const [modelName, setModelName] = useState('');
  const [sampler, setSampler] = useState('');
  const [cfgScale, setCfgScale] = useState('');
  const [steps, setSteps] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ownerId, setOwnerId] = useState('');
  const [activeTab, setActiveTab] = useState<ImageEditTab>('details');

  const tabIndexById = useMemo(() => {
    const entries = new Map<ImageEditTab, number>();
    imageEditTabs.forEach((tab, index) => entries.set(tab.id, index));
    return entries;
  }, []);

  const handleTabKeyNavigation = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, current: ImageEditTab) => {
      const currentIndex = tabIndexById.get(current) ?? 0;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        const nextIndex = (currentIndex + 1) % imageEditTabs.length;
        setActiveTab(imageEditTabs[nextIndex].id);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        const previousIndex = (currentIndex - 1 + imageEditTabs.length) % imageEditTabs.length;
        setActiveTab(imageEditTabs[previousIndex].id);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setActiveTab(imageEditTabs[0].id);
      } else if (event.key === 'End') {
        event.preventDefault();
        setActiveTab(imageEditTabs[imageEditTabs.length - 1].id);
      }
    },
    [tabIndexById],
  );

  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setDescription('');
      setPrompt('');
      setNegativePrompt('');
      setTags('');
      setSeed('');
      setModelName('');
      setSampler('');
      setCfgScale('');
      setSteps('');
      setError(null);
      setDetails([]);
      setIsSubmitting(false);
      setOwnerId('');
      setActiveTab('details');
      return;
    }

    setTitle(image.title);
    setDescription(image.description ?? '');
    setPrompt(image.prompt ?? '');
    setNegativePrompt(image.negativePrompt ?? '');
    setTags(image.tags.map((tag) => tag.label).join(', '));
    setSeed(formatNullable(image.metadata?.seed));
    setModelName(formatNullable(image.metadata?.model));
    setSampler(formatNullable(image.metadata?.sampler));
    setCfgScale(image.metadata?.cfgScale != null ? image.metadata.cfgScale.toString() : '');
    setSteps(image.metadata?.steps != null ? image.metadata.steps.toString() : '');
    setError(null);
    setDetails([]);
    setIsSubmitting(false);
    setOwnerId(image.owner.id);
    setActiveTab('details');

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!isSubmitting) {
          onClose();
        }
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [image, isOpen, isSubmitting, onClose]);

  const handleBackdropClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !isSubmitting) {
        onClose();
      }
    },
    [isSubmitting, onClose],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    if (!token) {
      setError('Please sign in to edit this image.');
      setDetails([]);
      return;
    }

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedPrompt = prompt.trim();
    const trimmedNegativePrompt = negativePrompt.trim();
    const trimmedSeed = seed.trim();
    const trimmedModel = modelName.trim();
    const trimmedSampler = sampler.trim();
    const trimmedCfgScale = cfgScale.trim();
    const trimmedSteps = steps.trim();
    const parsedTags = parseTags(tags);
    const normalizedOwner = ownerId.trim();

    if (!trimmedTitle) {
      setError('Please provide a title for the image.');
      setDetails([]);
      return;
    }

    const cfgScaleValue = trimmedCfgScale.length > 0 ? Number.parseFloat(trimmedCfgScale) : null;
    const stepsValue = trimmedSteps.length > 0 ? Number.parseInt(trimmedSteps, 10) : null;

    if (cfgScaleValue !== null && Number.isNaN(cfgScaleValue)) {
      setError('CFG Scale must be a number.');
      setDetails([]);
      return;
    }

    if (stepsValue !== null && Number.isNaN(stepsValue)) {
      setError('Steps must be an integer.');
      setDetails([]);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setDetails([]);

    try {
      const payload: Parameters<typeof api.updateImageAsset>[2] = {
        title: trimmedTitle,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        prompt: trimmedPrompt.length > 0 ? trimmedPrompt : null,
        negativePrompt: trimmedNegativePrompt.length > 0 ? trimmedNegativePrompt : null,
        tags: parsedTags,
        metadata: {
          seed: trimmedSeed.length > 0 ? trimmedSeed : null,
          model: trimmedModel.length > 0 ? trimmedModel : null,
          sampler: trimmedSampler.length > 0 ? trimmedSampler : null,
          cfgScale: cfgScaleValue,
          steps: stepsValue,
        },
      };

      if (normalizedOwner && normalizedOwner !== image.owner.id) {
        payload.ownerId = normalizedOwner;
      }

      const updated = await api.updateImageAsset(token, image.id, payload);
      onSuccess?.(updated);
      onClose();
    } catch (updateError) {
      if (updateError instanceof ApiError) {
        setError(updateError.message);
        setDetails(updateError.details ?? []);
      } else if (updateError instanceof Error) {
        setError(updateError.message);
        setDetails([]);
      } else {
        setError('Unknown error while updating the image.');
        setDetails([]);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  const ownerOptions = owners.some((owner) => owner.id === ownerId)
    ? owners
    : ownerId
    ? [{ id: ownerId, label: image.owner.displayName }, ...owners]
    : owners;

  const formattedDimensions = formatDimensions(image.dimensions);
  const formattedFileSize = formatFileSize(image.fileSize);

  return (
    <div className="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="image-edit-title" onClick={handleBackdropClick}>
      <div className="edit-dialog__content edit-dialog__content--wide">
        <header className="edit-dialog__header">
          <h3 id="image-edit-title">Edit image details</h3>
          <button type="button" className="edit-dialog__close" onClick={onClose} disabled={isSubmitting}>
            Close
          </button>
        </header>
        <div className="edit-dialog__layout edit-dialog__layout--split">
          <form className="edit-dialog__form" onSubmit={handleSubmit}>
            <div className="edit-dialog__tabs" role="tablist" aria-label="Image settings">
              {imageEditTabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    id={`image-edit-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`image-edit-panel-${tab.id}`}
                    className={`edit-dialog__tab${isActive ? ' edit-dialog__tab--active' : ''}`}
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={(event) => handleTabKeyNavigation(event, tab.id)}
                    disabled={isSubmitting}
                  >
                    <span className="edit-dialog__tab-label">{tab.label}</span>
                    <span className="edit-dialog__tab-description">{tab.description}</span>
                  </button>
                );
              })}
            </div>

            <div className="edit-dialog__panels">
              {imageEditTabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <section
                    key={tab.id}
                    id={`image-edit-panel-${tab.id}`}
                    role="tabpanel"
                    aria-labelledby={`image-edit-tab-${tab.id}`}
                    className={`edit-dialog__panel${isActive ? ' edit-dialog__panel--active' : ''}`}
                    hidden={!isActive}
                  >
                    {tab.id === 'details' ? (
                      <div className="edit-dialog__panel-grid">
                        <label className="edit-dialog__field edit-dialog__field--wide">
                          <span>Title</span>
                          <input
                            type="text"
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            disabled={isSubmitting}
                            required
                          />
                        </label>
                        <label className="edit-dialog__field edit-dialog__field--wide">
                          <span>Description</span>
                          <textarea
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            disabled={isSubmitting}
                            rows={3}
                          />
                        </label>
                        <label className="edit-dialog__field">
                          <span>Tags</span>
                          <input
                            type="text"
                            value={tags}
                            onChange={(event) => setTags(event.target.value)}
                            disabled={isSubmitting}
                            placeholder="Comma-separated tags"
                          />
                        </label>
                        <label className="edit-dialog__field">
                          <span>Asset owner</span>
                          <select
                            value={ownerId}
                            onChange={(event) => setOwnerId(event.target.value)}
                            disabled={isSubmitting}
                          >
                            {ownerOptions.map((owner) => (
                              <option key={owner.id} value={owner.id}>
                                {owner.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ) : null}
                    {tab.id === 'prompts' ? (
                      <div className="edit-dialog__panel-grid">
                        <label className="edit-dialog__field edit-dialog__field--wide">
                          <span>Prompt</span>
                          <textarea
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            disabled={isSubmitting}
                            rows={3}
                          />
                        </label>
                        <label className="edit-dialog__field edit-dialog__field--wide">
                          <span>Negative prompt</span>
                          <textarea
                            value={negativePrompt}
                            onChange={(event) => setNegativePrompt(event.target.value)}
                            disabled={isSubmitting}
                            rows={3}
                          />
                        </label>
                        <p className="edit-dialog__hint">
                          Prompts surface in curator explorers and power auto-complete suggestions. Leave empty to omit them
                          from search weighting.
                        </p>
                      </div>
                    ) : null}
                    {tab.id === 'metadata' ? (
                      <fieldset className="edit-dialog__fieldset edit-dialog__fieldset--columns">
                        <legend>Metadata</legend>
                        <label className="edit-dialog__field">
                          <span>Seed</span>
                          <input type="text" value={seed} onChange={(event) => setSeed(event.target.value)} disabled={isSubmitting} />
                        </label>
                        <label className="edit-dialog__field">
                          <span>Model</span>
                          <input
                            type="text"
                            value={modelName}
                            onChange={(event) => setModelName(event.target.value)}
                            disabled={isSubmitting}
                          />
                        </label>
                        <label className="edit-dialog__field">
                          <span>Sampler</span>
                          <input
                            type="text"
                            value={sampler}
                            onChange={(event) => setSampler(event.target.value)}
                            disabled={isSubmitting}
                          />
                        </label>
                        <label className="edit-dialog__field">
                          <span>CFG Scale</span>
                          <input
                            type="text"
                            value={cfgScale}
                            onChange={(event) => setCfgScale(event.target.value)}
                            disabled={isSubmitting}
                          />
                        </label>
                        <label className="edit-dialog__field">
                          <span>Steps</span>
                          <input type="text" value={steps} onChange={(event) => setSteps(event.target.value)} disabled={isSubmitting} />
                        </label>
                      </fieldset>
                    ) : null}
                  </section>
                );
              })}
            </div>

            {error ? (
              <div className="edit-dialog__error" role="alert">
                <p>{error}</p>
                {details.length > 0 ? (
                  <ul>
                    {details.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <footer className="edit-dialog__actions">
              <button type="button" onClick={onClose} className="edit-dialog__secondary" disabled={isSubmitting}>
                Cancel
              </button>
              <button type="submit" className="edit-dialog__primary" disabled={isSubmitting}>
                {isSubmitting ? 'Saving…' : 'Save changes'}
              </button>
            </footer>
          </form>
          <aside className="edit-dialog__sidebar" aria-label="Image summary">
            <h4 className="edit-dialog__summary-title">Quick facts</h4>
            <dl className="edit-dialog__summary-list">
              <div>
                <dt>Owner</dt>
                <dd>{image.owner.displayName}</dd>
              </div>
              <div>
                <dt>Visibility</dt>
                <dd>{image.isPublic ? 'Public' : 'Private'}</dd>
              </div>
              {formattedDimensions ? (
                <div>
                  <dt>Dimensions</dt>
                  <dd>{formattedDimensions} px</dd>
                </div>
              ) : null}
              {formattedFileSize ? (
                <div>
                  <dt>File size</dt>
                  <dd>{formattedFileSize}</dd>
                </div>
              ) : null}
              <div>
                <dt>Likes</dt>
                <dd>{image.likeCount ?? 0}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatDateTime(image.updatedAt)}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(image.createdAt)}</dd>
              </div>
            </dl>
            {image.tags.length > 0 ? (
              <div className="edit-dialog__summary-tags" aria-label="Existing tags">
                {image.tags.map((tag) => (
                  <span key={tag.id} className="admin-badge">
                    {tag.label}
                  </span>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
};
