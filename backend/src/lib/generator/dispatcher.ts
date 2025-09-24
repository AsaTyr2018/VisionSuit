import path from 'node:path';

import { appConfig } from '../../config';
import { AgentDispatchEnvelope, AgentRequestError, GeneratorAgentClient } from './agentClient';
import { mergeLoraExtras } from './loraContext';
import { prisma } from '../prisma';
import { ensureBucketExists, resolveStorageLocation, storageClient } from '../storage';

const isNotFoundError = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as { code?: string | number; statusCode?: number };
  const code = typeof record.code === 'string' ? record.code : undefined;
  if (code && ['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes(code)) {
    return true;
  }

  if (typeof record.statusCode === 'number' && record.statusCode === 404) {
    return true;
  }

  if (error instanceof Error && /not.?found/i.test(error.message)) {
    return true;
  }

  return false;
};

const ensureWorkflowMaterialized = async () => {
  const { workflow } = appConfig.generator;
  const bucket = workflow.bucket?.trim();
  const key = workflow.minioKey?.trim();

  if (!bucket || !key) {
    return;
  }

  try {
    await ensureBucketExists(bucket);
  } catch (error) {
    throw new Error(`Failed to ensure workflow bucket "${bucket}": ${(error as Error).message}`);
  }

  try {
    await storageClient.statObject(bucket, key);
    return;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new Error(`Failed to inspect workflow object "${bucket}/${key}": ${(error as Error).message}`);
    }
  }

  if (workflow.localPath) {
    try {
      await storageClient.fPutObject(bucket, key, workflow.localPath, {
        'Content-Type': 'application/json',
      });
      return;
    } catch (error) {
      throw new Error(
        `Failed to upload workflow template from "${workflow.localPath}" to "${bucket}/${key}": ${(error as Error).message}`,
      );
    }
  }

  if (typeof workflow.inline !== 'undefined') {
    try {
      const payload =
        typeof workflow.inline === 'string'
          ? workflow.inline
          : JSON.stringify(workflow.inline, null, 2);
      const body = Buffer.from(payload, 'utf-8');
      await storageClient.putObject(bucket, key, body, body.length, {
        'Content-Type': 'application/json',
      });
      return;
    } catch (error) {
      throw new Error(
        `Failed to upload inline workflow template to "${bucket}/${key}": ${(error as Error).message}`,
      );
    }
  }

  throw new Error(
    `Generator workflow object "${bucket}/${key}" is missing in storage and no local template is configured for upload.`,
  );
};

interface DispatchableGeneratorRequest {
  id: string;
  prompt: string;
  negativePrompt: string | null;
  seed: string | null;
  guidanceScale: number | null;
  steps: number | null;
  width: number;
  height: number;
  loraSelections: unknown;
  baseModelSelections: unknown;
  user: {
    id: string;
    displayName: string | null;
    email: string | null;
  };
  baseModel: {
    id: string;
    title: string;
    storagePath: string | null;
  } | null;
}

type StoredLoraSelection = {
  id: string;
  strength: number | null;
  title: string | null;
  slug: string | null;
};

type StoredBaseModelSelection = {
  id: string;
  name: string | null;
  type: string | null;
  title: string | null;
  slug: string | null;
  version: string | null;
  storagePath: string | null;
  filename: string | null;
  source: 'catalog' | 'configured';
};

export type DispatchStatus = 'queued' | 'busy' | 'skipped' | 'error';

export interface DispatchResult {
  status: DispatchStatus;
  message?: string;
}

const parseSeed = (value: string | null | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeUsername = (user: DispatchableGeneratorRequest['user']): string => {
  const displayName = user.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const email = user.email?.trim();
  if (email) {
    return email;
  }

  return user.id;
};

const parseLoraSelections = (value: unknown): StoredLoraSelection[] => {
  if (!value) {
    return [];
  }

  const raw = typeof value === 'string' ? (() => {
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      return [];
    }
  })() : value;

  if (!Array.isArray(raw)) {
    return [];
  }

  const selections: StoredLoraSelection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    if (!id) {
      continue;
    }

    selections.push({
      id,
      strength: typeof record.strength === 'number' ? record.strength : null,
      title: typeof record.title === 'string' ? record.title : null,
      slug: typeof record.slug === 'string' ? record.slug : null,
    });
  }

  return selections;
};

const parseBaseModelSelections = (value: unknown): StoredBaseModelSelection[] => {
  if (!value) {
    return [];
  }

  const raw = typeof value === 'string' ? (() => {
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      console.warn('Failed to parse base model selections JSON string.', error);
      return [];
    }
  })() : value;

  if (!Array.isArray(raw)) {
    return [];
  }

  const selections: StoredBaseModelSelection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    if (!id) {
      continue;
    }

    selections.push({
      id,
      name: typeof record.name === 'string' ? record.name : null,
      type: typeof record.type === 'string' ? record.type : null,
      title: typeof record.title === 'string' ? record.title : null,
      slug: typeof record.slug === 'string' ? record.slug : null,
      version: typeof record.version === 'string' ? record.version : null,
      storagePath: typeof record.storagePath === 'string' ? record.storagePath : null,
      filename: typeof record.filename === 'string' ? record.filename : null,
      source: record.source === 'configured' ? 'configured' : 'catalog',
    });
  }

  return selections;
};

const buildOutputPrefix = (request: DispatchableGeneratorRequest): string => {
  const template = appConfig.generator.output.prefixTemplate || 'generated/{userId}/{jobId}';
  return template.replace(/\{userId\}/g, request.user.id).replace(/\{jobId\}/g, request.id);
};

const buildWorkflowReference = () => {
  const { workflow } = appConfig.generator;

  const ref: AgentDispatchEnvelope['workflow'] = {
    id: workflow.id,
    version: workflow.version ?? null,
    bucket: workflow.bucket ?? null,
    minioKey: workflow.minioKey ?? null,
    localPath: workflow.exposeLocalPath ? workflow.localPath ?? null : null,
    inline: workflow.inline,
  };

  if (!ref.minioKey && !ref.localPath && typeof ref.inline === 'undefined') {
    throw new Error('Generator workflow configuration must provide minioKey, localPath, or inline payload.');
  }

  return ref;
};

export const dispatchGeneratorRequest = async (
  request: DispatchableGeneratorRequest,
): Promise<DispatchResult> => {
  const generatorNodeUrl = appConfig.network.generatorNodeUrl.trim();
  if (!generatorNodeUrl) {
    return { status: 'skipped', message: 'Generator node URL not configured.' };
  }

  try {
    await ensureWorkflowMaterialized();
  } catch (error) {
    return { status: 'error', message: (error as Error).message };
  }

  const storedBaseModels = parseBaseModelSelections(request.baseModelSelections);
  const normalizedBaseModels = [...storedBaseModels];
  const primaryBaseModelRecord = request.baseModel;
  if (primaryBaseModelRecord) {
    if (!normalizedBaseModels.some((entry) => entry.id === primaryBaseModelRecord.id)) {
      normalizedBaseModels.unshift({
        id: primaryBaseModelRecord.id,
        name: primaryBaseModelRecord.title,
        type: null,
        title: primaryBaseModelRecord.title,
        slug: null,
        version: null,
        storagePath: primaryBaseModelRecord.storagePath ?? null,
        filename: null,
        source: 'catalog',
      });
    }
  }

  const primarySelection = normalizedBaseModels[0] ?? null;
  const primaryStoragePath = request.baseModel?.storagePath ?? primarySelection?.storagePath ?? null;
  if (!primaryStoragePath) {
    return { status: 'error', message: 'Base model is missing an accessible storage location.' };
  }

  const baseModelLocation = resolveStorageLocation(primaryStoragePath);
  if (!baseModelLocation.bucket || !baseModelLocation.objectName) {
    return { status: 'error', message: 'Base model is missing an accessible storage location.' };
  }

  const baseModelIds = Array.from(new Set(normalizedBaseModels.map((entry) => entry.id)));
  let baseModelAssets: Array<{ id: string; storagePath: string | null }> = [];
  if (baseModelIds.length > 0) {
    baseModelAssets = await prisma.modelAsset.findMany({
      where: { id: { in: baseModelIds } },
      select: { id: true, storagePath: true },
    });
  }

  const baseModelStorage = new Map(baseModelAssets.map((entry) => [entry.id, entry.storagePath ?? null]));
  if (request.baseModel) {
    baseModelStorage.set(request.baseModel.id, request.baseModel.storagePath);
  }

  const selections = parseLoraSelections(request.loraSelections);
  const loraIds = selections.map((entry) => entry.id);

  let loraAssets: Array<{ id: string; storagePath: string | null }> = [];
  if (loraIds.length > 0) {
    loraAssets = await prisma.modelAsset.findMany({
      where: { id: { in: loraIds } },
      select: { id: true, storagePath: true },
    });
  }

  const lorasForAgent: AgentDispatchEnvelope['loras'] = [];
  const loraExtraPayload: Array<Record<string, unknown>> = [];
  const baseModelExtraPayload: Array<Record<string, unknown>> = [];
  const missingLoras: string[] = [];
  const missingBaseModels: string[] = [];

  for (const selection of normalizedBaseModels) {
    const storagePath = selection.storagePath ?? baseModelStorage.get(selection.id) ?? null;
    if (!storagePath) {
      missingBaseModels.push(selection.id);
      continue;
    }

    const location = resolveStorageLocation(storagePath);
    if (!location.bucket || !location.objectName) {
      missingBaseModels.push(selection.id);
      continue;
    }

    const fallbackTitle = request.baseModel?.title ?? selection.title ?? selection.name ?? 'Base model';

    baseModelExtraPayload.push({
      id: selection.id,
      name: selection.name ?? fallbackTitle,
      type: selection.type ?? null,
      title: selection.title ?? fallbackTitle,
      slug: selection.slug ?? null,
      version: selection.version ?? null,
      bucket: location.bucket,
      key: location.objectName,
      filename: path.basename(location.objectName),
    });
  }

  for (const selection of selections) {
    const asset = loraAssets.find((entry) => entry.id === selection.id);
    if (!asset || !asset.storagePath) {
      missingLoras.push(selection.id);
      continue;
    }

    const location = resolveStorageLocation(asset.storagePath);
    if (!location.bucket || !location.objectName) {
      missingLoras.push(selection.id);
      continue;
    }

    lorasForAgent.push({
      bucket: location.bucket,
      key: location.objectName,
      cacheStrategy: 'ephemeral',
    });

    loraExtraPayload.push({
      id: selection.id,
      title: selection.title ?? null,
      slug: selection.slug ?? null,
      strength: selection.strength ?? null,
      bucket: location.bucket,
      key: location.objectName,
      filename: path.basename(location.objectName),
    });
  }

  if (missingLoras.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('Generator request is missing LoRA assets:', missingLoras.join(', '));
  }

  if (missingBaseModels.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('Generator request is missing base model assets:', missingBaseModels.join(', '));
  }

  const envelope: AgentDispatchEnvelope = {
    jobId: request.id,
    user: {
      id: request.user.id,
      username: normalizeUsername(request.user),
    },
    workflow: buildWorkflowReference(),
    baseModel: {
      bucket: baseModelLocation.bucket,
      key: baseModelLocation.objectName,
      cacheStrategy: 'persistent',
    },
    loras: lorasForAgent,
    parameters: {
      prompt: request.prompt,
      resolution: {
        width: request.width,
        height: request.height,
      },
    },
    output: {
      bucket: appConfig.generator.output.bucket,
      prefix: buildOutputPrefix(request),
    },
    workflowOverrides: [...appConfig.generator.workflow.overrides],
    workflowParameters: [...appConfig.generator.workflow.parameters],
  };

  const callbackBase = appConfig.generator.callbacks.baseUrl.replace(/\/$/, '');
  const buildCallbackPath = (suffix: 'status' | 'completion' | 'failure') =>
    `/api/generator/requests/${request.id}/callbacks/${suffix}`;
  const buildCallbackUrl = (suffix: 'status' | 'completion' | 'failure') =>
    callbackBase ? `${callbackBase}${buildCallbackPath(suffix)}` : buildCallbackPath(suffix);

  envelope.callbacks = {
    status: buildCallbackUrl('status'),
    completion: buildCallbackUrl('completion'),
    failure: buildCallbackUrl('failure'),
  };

  if (request.negativePrompt !== undefined) {
    envelope.parameters.negativePrompt = request.negativePrompt;
  }

  const seed = parseSeed(request.seed);
  if (typeof seed === 'number') {
    envelope.parameters.seed = seed;
  }

  if (request.guidanceScale !== null && request.guidanceScale !== undefined) {
    envelope.parameters.cfgScale = request.guidanceScale;
  }

  if (request.steps !== null && request.steps !== undefined) {
    envelope.parameters.steps = request.steps;
  }

  if (baseModelExtraPayload.length > 0 || loraExtraPayload.length > 0) {
    envelope.parameters.extra = {
      ...(envelope.parameters.extra ?? {}),
      ...(baseModelExtraPayload.length > 0 ? { baseModels: baseModelExtraPayload } : {}),
      ...mergeLoraExtras(selections, loraExtraPayload),
    };
  }

  if (envelope.parameters.extra && Object.keys(envelope.parameters.extra).length === 0) {
    delete envelope.parameters.extra;
  }

  const client = new GeneratorAgentClient(generatorNodeUrl);

  try {
    const response = await client.submitJob(envelope);
    if (response.status === 'accepted') {
      return { status: 'queued' };
    }

    if (response.status === 'busy') {
      return { status: 'busy', message: 'GPU agent is currently processing another job.' };
    }

    return { status: 'error', message: 'Unexpected GPU agent response.' };
  } catch (error) {
    if (error instanceof AgentRequestError) {
      return { status: 'error', message: error.message };
    }

    return { status: 'error', message: (error as Error).message };
  }
};

