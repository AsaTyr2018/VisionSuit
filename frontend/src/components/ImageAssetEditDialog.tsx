import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';

import { api, ApiError } from '../lib/api';
import type { ImageAsset } from '../types/api';

interface ImageAssetEditDialogProps {
  isOpen: boolean;
  onClose: () => void;
  image: ImageAsset;
  token: string | null | undefined;
  onSuccess?: (updated: ImageAsset) => void;
}

const parseTags = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const formatNullable = (value?: string | null) => value ?? '';

export const ImageAssetEditDialog = ({
  isOpen,
  onClose,
  image,
  token,
  onSuccess,
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
      const updated = await api.updateImageAsset(token, image.id, {
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
      });
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

  return (
    <div className="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="image-edit-title" onClick={handleBackdropClick}>
      <div className="edit-dialog__content edit-dialog__content--wide">
        <header className="edit-dialog__header">
          <h3 id="image-edit-title">Edit image details</h3>
          <button type="button" className="edit-dialog__close" onClick={onClose} disabled={isSubmitting}>
            Close
          </button>
        </header>
        <form className="edit-dialog__form" onSubmit={handleSubmit}>
          <label className="edit-dialog__field">
            <span>Title</span>
            <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} disabled={isSubmitting} required />
          </label>
          <label className="edit-dialog__field">
            <span>Description</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} disabled={isSubmitting} rows={3} />
          </label>
          <label className="edit-dialog__field">
            <span>Prompt</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={isSubmitting} rows={3} />
          </label>
          <label className="edit-dialog__field">
            <span>Negative prompt</span>
            <textarea value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} disabled={isSubmitting} rows={3} />
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
          <fieldset className="edit-dialog__fieldset edit-dialog__fieldset--columns">
            <legend>Metadata</legend>
            <label className="edit-dialog__field">
              <span>Seed</span>
              <input type="text" value={seed} onChange={(event) => setSeed(event.target.value)} disabled={isSubmitting} />
            </label>
            <label className="edit-dialog__field">
              <span>Model</span>
              <input type="text" value={modelName} onChange={(event) => setModelName(event.target.value)} disabled={isSubmitting} />
            </label>
            <label className="edit-dialog__field">
              <span>Sampler</span>
              <input type="text" value={sampler} onChange={(event) => setSampler(event.target.value)} disabled={isSubmitting} />
            </label>
            <label className="edit-dialog__field">
              <span>CFG Scale</span>
              <input type="text" value={cfgScale} onChange={(event) => setCfgScale(event.target.value)} disabled={isSubmitting} />
            </label>
            <label className="edit-dialog__field">
              <span>Steps</span>
              <input type="text" value={steps} onChange={(event) => setSteps(event.target.value)} disabled={isSubmitting} />
            </label>
          </fieldset>

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
      </div>
    </div>
  );
};
