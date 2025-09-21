import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '../lib/api';
import { generatorBaseModelBucket } from '../config';
import { resolveCachedStorageUrl } from '../lib/storage';
import type {
  GeneratorRequestLoRASelection,
  GeneratorRequestSummary,
  ModelAsset,
  User,
} from '../types/api';

interface OnSiteGeneratorProps {
  models: ModelAsset[];
  token: string;
  currentUser: User;
  onNotify?: (payload: { type: 'success' | 'error'; message: string }) => void;
}

type WizardStep = 1 | 2 | 3;

type LoraSelection = {
  id: string;
  strength: number;
};

const dimensionPresets = [
  { label: 'Square — 1024 × 1024', width: 1024, height: 1024 },
  { label: 'Square — 768 × 768', width: 768, height: 768 },
  { label: 'Portrait — 832 × 1216', width: 832, height: 1216 },
  { label: 'Portrait — 768 × 1152', width: 768, height: 1152 },
  { label: 'Landscape — 1216 × 832', width: 1216, height: 832 },
  { label: 'Landscape — 1152 × 768', width: 1152, height: 768 },
];

const describeModelType = (asset: ModelAsset) =>
  asset.tags.find((tag) => tag.category === 'model-type')?.label ?? 'LoRA asset';

const normalizedBaseModelBucket = generatorBaseModelBucket.trim().toLowerCase();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const extractTriggerPhrases = (asset: ModelAsset): string[] => {
  const phrases = new Set<string>();

  const addPhrase = (phrase: string | null | undefined) => {
    if (!phrase) {
      return;
    }
    const trimmed = phrase.trim();
    if (trimmed.length > 0) {
      phrases.add(trimmed);
    }
  };

  addPhrase(asset.trigger ?? undefined);

  const metadata = asset.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    const triggerKeys = ['trigger', 'triggerWord', 'triggerWords'];
    for (const key of triggerKeys) {
      const value = metadata[key];
      if (typeof value === 'string') {
        value
          .split(/[,\n]/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .forEach((entry) => phrases.add(entry));
      } else if (Array.isArray(value)) {
        value
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .forEach((entry) => phrases.add(entry));
      }
    }
  }

  return Array.from(phrases);
};

const isLikelyLora = (asset: ModelAsset) => {
  if (typeof asset.trigger === 'string' && asset.trigger.trim().length > 0) {
    return true;
  }

  const assetBucket = asset.storageBucket?.trim().toLowerCase();
  if (assetBucket && normalizedBaseModelBucket && assetBucket === normalizedBaseModelBucket) {
    return false;
  }

  const typeLabel = describeModelType(asset).toLowerCase();
  if (typeLabel.includes('lora')) {
    return true;
  }
  if (typeLabel.includes('checkpoint') || typeLabel.includes('base')) {
    return false;
  }

  const metadata = asset.metadata as Record<string, unknown> | undefined;
  const format = metadata?.['format'] ?? metadata?.['type'];
  if (typeof format === 'string') {
    const normalizedFormat = format.toLowerCase();
    if (normalizedFormat.includes('lora')) {
      return true;
    }
    if (normalizedFormat.includes('checkpoint') || normalizedFormat.includes('model')) {
      return false;
    }
  }

  const architecture = metadata?.['architecture'];
  if (typeof architecture === 'string' && architecture.toLowerCase().includes('lora')) {
    return true;
  }

  return false;
};

const normalizeStrength = (value: number) => {
  if (Number.isNaN(value)) {
    return 1;
  }
  return Math.min(2, Math.max(-2, Number(value.toFixed(2))));
};

const mapHistoryLoRAs = (
  entries: GeneratorRequestLoRASelection[],
  modelLookup: Map<string, ModelAsset>,
): GeneratorRequestLoRASelection[] =>
  entries.map((entry) => {
    const asset = modelLookup.get(entry.id);
    if (!asset) {
      return entry;
    }
    return {
      ...entry,
      title: entry.title ?? asset.title,
      slug: entry.slug ?? asset.slug,
    };
  });

export const OnSiteGenerator = ({ models, token, currentUser, onNotify }: OnSiteGeneratorProps) => {
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedBaseModelId, setSelectedBaseModelId] = useState<string>('');
  const [loraSelections, setLoraSelections] = useState<LoraSelection[]>([]);
  const [loraQuery, setLoraQuery] = useState('');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [seed, setSeed] = useState('');
  const [guidanceScale, setGuidanceScale] = useState(7.5);
  const [steps, setSteps] = useState(28);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [history, setHistory] = useState<GeneratorRequestSummary[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [baseModels, setBaseModels] = useState<ModelAsset[]>([]);
  const [isBaseModelsLoading, setIsBaseModelsLoading] = useState(false);
  const [baseModelError, setBaseModelError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const loadBaseModels = async () => {
      if (!token) {
        setBaseModels([]);
        setBaseModelError(null);
        return;
      }

      try {
        setIsBaseModelsLoading(true);
        setBaseModelError(null);
        const entries = await api.getGeneratorBaseModels(token);
        if (!isMounted) {
          return;
        }
        setBaseModels(entries);
      } catch (error) {
        if (!isMounted) {
          return;
        }
        console.error('Failed to load generator base models', error);
        const message = error instanceof ApiError ? error.message : 'Could not load base models from storage.';
        setBaseModels([]);
        setBaseModelError(message);
      } finally {
        if (isMounted) {
          setIsBaseModelsLoading(false);
        }
      }
    };

    loadBaseModels();

    return () => {
      isMounted = false;
    };
  }, [token]);

  const baseModelOptions = useMemo(
    () => baseModels.slice().sort((a, b) => a.title.localeCompare(b.title)),
    [baseModels],
  );

  const loraOptions = useMemo(() => {
    const baseModelIds = new Set(baseModelOptions.map((asset) => asset.id));
    const candidates = models.filter((asset) => isLikelyLora(asset) && !baseModelIds.has(asset.id));
    if (candidates.length > 0) {
      return candidates.sort((a, b) => a.title.localeCompare(b.title));
    }

    return models
      .filter((asset) => asset.id !== selectedBaseModelId && !baseModelIds.has(asset.id))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [models, selectedBaseModelId, baseModelOptions]);

  const loraLookup = useMemo(() => new Map(models.map((asset) => [asset.id, asset])), [models]);

  useEffect(() => {
    if (baseModelOptions.length === 0) {
      setSelectedBaseModelId('');
      return;
    }

    if (!selectedBaseModelId || !baseModelOptions.some((asset) => asset.id === selectedBaseModelId)) {
      setSelectedBaseModelId(baseModelOptions[0].id);
    }
  }, [baseModelOptions, selectedBaseModelId]);

  const selectedBaseModel = useMemo(
    () => baseModelOptions.find((asset) => asset.id === selectedBaseModelId) ?? null,
    [baseModelOptions, selectedBaseModelId],
  );

  const filteredLoras = useMemo(() => {
    if (!loraQuery.trim()) {
      return loraOptions;
    }
    const query = loraQuery.trim().toLowerCase();
    return loraOptions.filter((asset) => asset.title.toLowerCase().includes(query));
  }, [loraOptions, loraQuery]);

  const selectedLorAsDetailed = useMemo(() => {
    return loraSelections
      .map((selection) => {
        const asset = loraLookup.get(selection.id);
        if (!asset) {
          return null;
        }
        return {
          asset,
          strength: selection.strength,
        };
      })
      .filter((entry): entry is { asset: ModelAsset; strength: number } => Boolean(entry));
  }, [loraSelections, loraLookup]);

  const selectedLoraTriggerEntries = useMemo(() => {
    return selectedLorAsDetailed
      .map(({ asset }) => {
        const triggers = extractTriggerPhrases(asset);
        if (triggers.length === 0) {
          return null;
        }
        return {
          id: asset.id,
          title: asset.title,
          triggers,
        };
      })
      .filter((entry): entry is { id: string; title: string; triggers: string[] } => Boolean(entry));
  }, [selectedLorAsDetailed]);

  const isLoraSelected = useCallback(
    (id: string) => loraSelections.some((selection) => selection.id === id),
    [loraSelections],
  );

  const handleToggleLora = useCallback(
    (id: string) => {
      setLoraSelections((current) => {
        if (current.some((entry) => entry.id === id)) {
          return current.filter((entry) => entry.id !== id);
        }
        if (current.length >= 12) {
          return current;
        }
        return [...current, { id, strength: 1 }];
      });
    },
    [],
  );

  const handleStrengthChange = useCallback((id: string, value: number) => {
    setLoraSelections((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, strength: normalizeStrength(value) } : entry)),
    );
  }, []);

  const handleInsertTrigger = useCallback((trigger: string) => {
    const normalizedTrigger = trigger.trim();
    if (!normalizedTrigger) {
      return;
    }

    setPrompt((current) => {
      const pattern = new RegExp(`(^|\\s)${escapeRegExp(normalizedTrigger)}(\\s|$)`, 'i');
      if (pattern.test(current)) {
        return current;
      }

      if (current.trim().length === 0) {
        return normalizedTrigger;
      }

      const needsSpace = /\S$/.test(current);
      return `${current}${needsSpace ? ' ' : ''}${normalizedTrigger}`;
    });
  }, []);

  const fetchHistory = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      setIsHistoryLoading(true);
      setHistoryError(null);
      const requests = await api.getGeneratorRequests(token, currentUser.role === 'ADMIN' ? 'all' : 'mine');
      const enhanced = requests.map((request) => ({
        ...request,
        loras: mapHistoryLoRAs(request.loras, loraLookup),
      }));
      setHistory(enhanced);
    } catch (error) {
      console.error('Failed to load generator history', error);
      setHistoryError('Could not load recent generator requests.');
    } finally {
      setIsHistoryLoading(false);
    }
  }, [token, currentUser.role, loraLookup]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    setHistory((current) =>
      current.map((request) => ({
        ...request,
        loras: mapHistoryLoRAs(request.loras, loraLookup),
      })),
    );
  }, [loraLookup]);

  const goToStep = useCallback(
    (next: WizardStep) => {
      setWizardError(null);
      setSubmitError(null);
      setStep(next);
    },
    [],
  );

  const handleNext = useCallback(() => {
    if (step === 1) {
      if (!selectedBaseModelId) {
        setWizardError('Please select a base model before continuing.');
        return;
      }
      goToStep(2);
      return;
    }

    if (step === 2) {
      if (prompt.trim().length === 0) {
        setWizardError('A creative prompt is required to start a render.');
        return;
      }
      goToStep(3);
    }
  }, [goToStep, prompt, selectedBaseModelId, step]);

  const resetWizard = useCallback(() => {
    setPrompt('');
    setNegativePrompt('');
    setSeed('');
    setGuidanceScale(7.5);
    setSteps(28);
    setWidth(1024);
    setHeight(1024);
    setLoraSelections([]);
    setWizardError(null);
    setSubmitError(null);
    goToStep(1);
  }, [goToStep]);

  const handleSubmit = useCallback(async () => {
    if (!selectedBaseModelId) {
      setSubmitError('Select a base model before submitting the request.');
      goToStep(1);
      return;
    }
    if (prompt.trim().length === 0) {
      setSubmitError('Provide a prompt to describe the desired render.');
      goToStep(2);
      return;
    }

    try {
      setIsSubmitting(true);
      setSubmitError(null);
      const payload = {
        baseModelId: selectedBaseModelId,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim() ? negativePrompt.trim() : undefined,
        seed: seed.trim() ? seed.trim() : undefined,
        guidanceScale: Number.isFinite(guidanceScale) ? Number(guidanceScale) : undefined,
        steps: Number.isFinite(steps) ? Number(steps) : undefined,
        width,
        height,
        loras: loraSelections.map((entry) => ({ id: entry.id, strength: normalizeStrength(entry.strength) })),
      };

      const request = await api.createGeneratorRequest(token, payload);
      onNotify?.({ type: 'success', message: 'Generation request recorded. Worker agents can pick it up once available.' });
      setHistory((current) => [{
        ...request,
        loras: mapHistoryLoRAs(request.loras, loraLookup),
      }, ...current]);
      resetWizard();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to create generator request.';
      setSubmitError(message);
      onNotify?.({ type: 'error', message });
    } finally {
      setIsSubmitting(false);
    }
  }, [
    selectedBaseModelId,
    prompt,
    negativePrompt,
    seed,
    guidanceScale,
    steps,
    width,
    height,
    loraSelections,
    token,
    onNotify,
    resetWizard,
    loraLookup,
    goToStep,
  ]);

  const stepLabels: Record<WizardStep, string> = {
    1: 'Assets',
    2: 'Prompts & Settings',
    3: 'Review',
  };

  const renderStepIndicator = (
    <ol className="generator-stepper" aria-label="Generator wizard steps">
      {(Object.keys(stepLabels) as Array<keyof typeof stepLabels>).map((key) => {
        const numeric = Number(key) as WizardStep;
        return (
          <li key={key} className={`generator-stepper__item${step === numeric ? ' generator-stepper__item--active' : ''}`}>
            <span className="generator-stepper__index">{numeric}</span>
            <span className="generator-stepper__label">{stepLabels[numeric]}</span>
          </li>
        );
      })}
    </ol>
  );

  const renderBaseModelPreview = () => {
    if (isBaseModelsLoading) {
      return (
        <div className="generator-preview generator-preview--empty">
          <p>Loading base model metadata…</p>
        </div>
      );
    }

    if (baseModelError) {
      return (
        <div className="generator-preview generator-preview--empty">
          <p>{baseModelError}</p>
        </div>
      );
    }

    if (!selectedBaseModel) {
      if (baseModelOptions.length === 0) {
        return (
          <div className="generator-preview generator-preview--empty">
            <p>Upload checkpoints to the {generatorBaseModelBucket} bucket to unlock the On-Site Generator.</p>
          </div>
        );
      }

      return (
        <div className="generator-preview generator-preview--empty">
          <p>Select a base model to display its metadata and cover art.</p>
        </div>
      );
    }

    const previewUrl = resolveCachedStorageUrl(
      selectedBaseModel.previewImage,
      selectedBaseModel.previewImageBucket,
      selectedBaseModel.previewImageObject,
    );

    return (
      <div className="generator-preview">
        {previewUrl ? <img src={previewUrl} alt="Base model preview" /> : <div className="generator-preview__fallback">No preview</div>}
        <div className="generator-preview__details">
          <h3>{selectedBaseModel.title}</h3>
          <dl>
            <div>
              <dt>Type</dt>
              <dd>{describeModelType(selectedBaseModel)}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{selectedBaseModel.version}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{selectedBaseModel.owner.displayName}</dd>
            </div>
          </dl>
          {selectedBaseModel.tags.length > 0 ? (
            <ul className="generator-preview__tags">
              {selectedBaseModel.tags.slice(0, 6).map((tag) => (
                <li key={tag.id}>{tag.label}</li>
              ))}
              {selectedBaseModel.tags.length > 6 ? (
                <li className="generator-preview__tags-more">+{selectedBaseModel.tags.length - 6}</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      </div>
    );
  };

  const renderLoraSelection = () => (
    <div className="generator-lora">
      <header className="generator-lora__header">
        <div>
          <h3>LoRA adapters</h3>
          <p>Optionally select adapters to specialize the render. Toggle entries to add or remove them from the job.</p>
        </div>
        <p className="generator-lora__count">{loraSelections.length} selected</p>
      </header>
      <div className="generator-lora__search">
        <label htmlFor="generator-lora-search">Filter LoRAs</label>
        <input
          id="generator-lora-search"
          type="search"
          value={loraQuery}
          onChange={(event) => setLoraQuery(event.target.value)}
          placeholder="Search by title"
        />
      </div>
      <div className="generator-lora__grid">
        {filteredLoras.map((asset) => {
          const selected = isLoraSelected(asset.id);
          return (
            <article
              key={asset.id}
              className={`generator-lora__card${selected ? ' generator-lora__card--active' : ''}`}
            >
              <header>
                <h4>{asset.title}</h4>
                <p>{describeModelType(asset)}</p>
              </header>
              <div className="generator-lora__actions">
                <button type="button" onClick={() => handleToggleLora(asset.id)}>
                  {selected ? 'Remove' : 'Add'}
                </button>
                {selected ? (
                  <label>
                    Strength
                    <input
                      type="range"
                      min="-2"
                      max="2"
                      step="0.05"
                      value={
                        loraSelections.find((entry) => entry.id === asset.id)?.strength ?? 1
                      }
                      onChange={(event) => handleStrengthChange(asset.id, Number(event.target.value))}
                    />
                    <span className="generator-lora__strength">
                      {normalizeStrength(
                        loraSelections.find((entry) => entry.id === asset.id)?.strength ?? 1,
                      ).toFixed(2)}
                    </span>
                  </label>
                ) : null}
              </div>
            </article>
          );
        })}
        {filteredLoras.length === 0 ? <p className="generator-lora__empty">No LoRAs match the current filter.</p> : null}
      </div>
    </div>
  );

  const renderPromptStep = () => (
    <div className="generator-prompts">
      {selectedLoraTriggerEntries.length > 0 ? (
        <aside className="generator-prompts__triggers" aria-live="polite">
          <div>
            <h3>LoRA trigger suggestions</h3>
            <p>Click a trigger phrase to add it to your prompt.</p>
          </div>
          <ul className="generator-prompts__trigger-list">
            {selectedLoraTriggerEntries.map((entry) => (
              <li key={entry.id} className="generator-prompts__trigger-item">
                <span className="generator-prompts__trigger-title">{entry.title}</span>
                <div className="generator-prompts__trigger-buttons">
                  {entry.triggers.map((trigger) => (
                    <button
                      key={`${entry.id}-${trigger}`}
                      type="button"
                      onClick={() => handleInsertTrigger(trigger)}
                    >
                      {trigger}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
      <div className="generator-field">
        <label htmlFor="generator-prompt">Prompt</label>
        <textarea
          id="generator-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={6}
          placeholder="Describe the desired render in detail, including style, subject, and mood."
        />
      </div>
      <div className="generator-field">
        <label htmlFor="generator-negative-prompt">Negative prompt</label>
        <textarea
          id="generator-negative-prompt"
          value={negativePrompt}
          onChange={(event) => setNegativePrompt(event.target.value)}
          rows={4}
          placeholder="List elements to avoid. Leave blank to keep the default safety filters."
        />
      </div>
      <div className="generator-parameters">
        <div className="generator-parameters__group">
          <span className="generator-parameters__label">Dimensions</span>
          <div className="generator-dimensions">
            {dimensionPresets.map((preset) => (
              <button
                type="button"
                key={preset.label}
                className={
                  preset.width === width && preset.height === height
                    ? 'generator-dimensions__option generator-dimensions__option--active'
                    : 'generator-dimensions__option'
                }
                onClick={() => {
                  setWidth(preset.width);
                  setHeight(preset.height);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="generator-dimensions__custom">
            <label>
              Width
              <input
                type="number"
                min={256}
                max={2048}
                step={64}
                value={width}
                onChange={(event) => setWidth(Number(event.target.value) || width)}
              />
            </label>
            <label>
              Height
              <input
                type="number"
                min={256}
                max={2048}
                step={64}
                value={height}
                onChange={(event) => setHeight(Number(event.target.value) || height)}
              />
            </label>
          </div>
        </div>
        <div className="generator-parameters__group">
          <label>
            CFG / Guidance
            <input
              type="number"
              min={0}
              max={40}
              step={0.1}
              value={guidanceScale}
              onChange={(event) => setGuidanceScale(Number(event.target.value))}
            />
          </label>
          <label>
            Steps
            <input
              type="number"
              min={1}
              max={200}
              step={1}
              value={steps}
              onChange={(event) => setSteps(Number(event.target.value))}
            />
          </label>
          <label>
            Seed (optional)
            <input
              type="text"
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
              placeholder="Leave blank for randomness"
            />
          </label>
        </div>
      </div>
    </div>
  );

  const renderReviewStep = () => (
    <div className="generator-review">
      <section>
        <h3>Summary</h3>
        <dl>
          <div>
            <dt>Base model</dt>
            <dd>{selectedBaseModel ? selectedBaseModel.title : 'Not selected'}</dd>
          </div>
          <div>
            <dt>Prompt</dt>
            <dd>{prompt.trim() || '—'}</dd>
          </div>
          <div>
            <dt>Negative prompt</dt>
            <dd>{negativePrompt.trim() || '—'}</dd>
          </div>
          <div>
            <dt>Dimensions</dt>
            <dd>
              {width} × {height}
            </dd>
          </div>
          <div>
            <dt>Guidance / Steps</dt>
            <dd>
              CFG {guidanceScale.toFixed(1)} · {steps} steps
            </dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd>{seed.trim() || 'Auto (random)'}</dd>
          </div>
        </dl>
      </section>
      <section>
        <h3>LoRA mix</h3>
        {selectedLorAsDetailed.length > 0 ? (
          <ul className="generator-review__loras">
            {selectedLorAsDetailed.map(({ asset, strength }) => (
              <li key={asset.id}>
                <span>{asset.title}</span>
                <span className="generator-review__loras-strength">{normalizeStrength(strength).toFixed(2)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No LoRA adapters selected. The render will use only the base model.</p>
        )}
      </section>
    </div>
  );

  const renderWizardContent = () => {
    if (step === 1) {
      return (
        <div className="generator-step generator-step--assets">
          <div className="generator-field">
            <label htmlFor="generator-base-model">Base model</label>
            <select
              id="generator-base-model"
              value={selectedBaseModelId}
              onChange={(event) => setSelectedBaseModelId(event.target.value)}
              disabled={isBaseModelsLoading || baseModelOptions.length === 0}
            >
              {baseModelOptions.length === 0 ? (
                <option value="">
                  {isBaseModelsLoading ? 'Loading base models…' : 'No base models available'}
                </option>
              ) : null}
              {baseModelOptions.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.title} — {describeModelType(asset)}
                </option>
              ))}
            </select>
            {isBaseModelsLoading ? (
              <p className="generator-field__status">Loading base models from storage…</p>
            ) : null}
            {baseModelError ? <p className="generator-field__error">{baseModelError}</p> : null}
            {!isBaseModelsLoading && baseModelOptions.length === 0 && !baseModelError ? (
              <p className="generator-field__empty">
                No checkpoints detected in the {generatorBaseModelBucket} bucket.
              </p>
            ) : null}
          </div>
          {renderBaseModelPreview()}
          {renderLoraSelection()}
        </div>
      );
    }

    if (step === 2) {
      return <div className="generator-step generator-step--prompts">{renderPromptStep()}</div>;
    }

    return <div className="generator-step generator-step--review">{renderReviewStep()}</div>;
  };

  const renderHistory = () => (
    <section className="generator-history" aria-live="polite">
      <header className="generator-history__header">
        <h2>Recent requests</h2>
        <button type="button" onClick={fetchHistory} disabled={isHistoryLoading}>
          Refresh
        </button>
      </header>
      {isHistoryLoading ? <p className="generator-history__status">Loading request history…</p> : null}
      {historyError ? <p className="generator-history__error">{historyError}</p> : null}
      {history.length === 0 && !isHistoryLoading && !historyError ? (
        <p className="generator-history__empty">No generator activity yet. Submit your first request to populate the timeline.</p>
      ) : null}
      <ul className="generator-history__list">
        {history.map((request) => {
          const createdAt = new Date(request.createdAt);
          return (
            <li key={request.id} className="generator-history__item">
              <header>
                <h3>{request.baseModel.title}</h3>
                <span className={`generator-history__status-tag generator-history__status-tag--${request.status}`}>
                  {request.status.replace(/_/g, ' ')}
                </span>
              </header>
              {currentUser.role === 'ADMIN' ? (
                <p className="generator-history__owner">Requested by {request.owner.displayName}</p>
              ) : null}
              <p className="generator-history__timestamp">{createdAt.toLocaleString()}</p>
              <dl>
                <div>
                  <dt>Prompt</dt>
                  <dd>{request.prompt}</dd>
                </div>
                <div>
                  <dt>Dimensions</dt>
                  <dd>
                    {request.width} × {request.height}
                  </dd>
                </div>
                <div>
                  <dt>CFG / Steps</dt>
                  <dd>
                    {request.guidanceScale ? request.guidanceScale.toFixed(1) : '—'} · {request.steps ?? '—'} steps
                  </dd>
                </div>
              </dl>
              {request.loras.length > 0 ? (
                <ul className="generator-history__loras">
                  {request.loras.map((entry) => (
                    <li key={entry.id}>
                      <span>{entry.title ?? entry.id}</span>
                      <span className="generator-history__loras-strength">
                        {normalizeStrength(entry.strength).toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="generator-history__loras-empty">No LoRA adapters</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <section className="generator">
      <div className="generator__layout">
        <div className="generator__wizard">
          <header className="generator__header">
            <h1>On-Site Generator</h1>
            <p>
              Queue curated Stable Diffusion prompts directly from VisionSuit. Requests are stored for the GPU agent to pick up
              as soon as it connects.
            </p>
          </header>
          {renderStepIndicator}
          {wizardError ? <p className="generator__alert generator__alert--error">{wizardError}</p> : null}
          {renderWizardContent()}
          <footer className="generator__actions">
            {step > 1 ? (
              <button type="button" className="button" onClick={() => goToStep((step - 1) as WizardStep)}>
                Back
              </button>
            ) : null}
            {step < 3 ? (
              <button type="button" className="button button--primary" onClick={handleNext}>
                Continue
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary"
                onClick={handleSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Saving…' : 'Save request'}
              </button>
            )}
            <button type="button" className="button button--ghost" onClick={resetWizard}>
              Reset
            </button>
          </footer>
          {submitError ? <p className="generator__alert generator__alert--error">{submitError}</p> : null}
        </div>
        {renderHistory()}
      </div>
    </section>
  );
};
