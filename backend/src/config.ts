import fs from 'node:fs';
import path from 'node:path';

import { config } from 'dotenv';

import type { AgentWorkflowMutation, AgentWorkflowParameterBinding } from './lib/generator/agentClient';

const dotenvPath = process.env.DOTENV_CONFIG_PATH;

if (dotenvPath && dotenvPath.length > 0) {
  config({ path: dotenvPath });
} else {
  config();
}

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const toBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const requireString = (value: string | undefined, key: string, fallback?: string): string => {
  if (value && value.trim().length > 0) {
    return value.trim();
  }

  if (fallback && fallback.length > 0) {
    return fallback;
  }

  throw new Error(`Missing required configuration value for ${key}`);
};

const toExpiresIn = (value: string | undefined, fallback: string | number): string | number => {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const numeric = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(numeric) && numeric >= 0) {
    return numeric;
  }

  return trimmed;
};

const storageDriver = process.env.STORAGE_DRIVER ?? 'minio';

if (storageDriver !== 'minio') {
  throw new Error(`Unsupported STORAGE_DRIVER "${storageDriver}". Only "minio" is currently supported.`);
}

const minioHost = process.env.MINIO_ENDPOINT ?? '127.0.0.1';
const minioPort = toNumber(process.env.MINIO_PORT, 9000);
const minioUseSSL = toBoolean(process.env.MINIO_USE_SSL, false);

const deriveSiteTitle = () => {
  const rawValue = process.env.SITE_TITLE;
  if (rawValue && rawValue.trim().length > 0) {
    return rawValue.trim();
  }

  const frontendTitle = process.env.VITE_SITE_TITLE;
  if (frontendTitle && frontendTitle.trim().length > 0) {
    return frontendTitle.trim();
  }

  return 'VisionSuit';
};

const toSanitizedString = (value: string | undefined, fallback = '') => {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const toOptionalString = (value: string | undefined) => {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '';
};

const generatorNodeUrl = toOptionalString(process.env.GENERATOR_NODE_URL);

const sanitizeUrl = (value: string, fallbackProtocol: 'http' | 'https' = 'http') => {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `${fallbackProtocol}://${trimmed}`;
};

const deriveGeneratorCallbackBaseUrl = () => {
  const explicit = process.env.GENERATOR_CALLBACK_BASE_URL;
  if (explicit && explicit.trim().length > 0) {
    const normalizedExplicit = sanitizeUrl(explicit);
    if (normalizedExplicit) {
      return normalizedExplicit;
    }
  }

  const publicDomain = process.env.PUBLIC_DOMAIN;
  if (publicDomain && publicDomain.trim().length > 0) {
    const normalizedDomain = sanitizeUrl(publicDomain, 'https');
    if (normalizedDomain) {
      return normalizedDomain;
    }
  }

  const hostCandidate =
    process.env.BACKEND_PUBLIC_HOST?.trim() ||
    process.env.PUBLIC_HOST?.trim() ||
    process.env.HOST?.trim() ||
    '127.0.0.1';

  const normalizedHost = hostCandidate === '0.0.0.0' ? '127.0.0.1' : hostCandidate;
  if (/^https?:\/\//i.test(normalizedHost)) {
    return normalizedHost.replace(/\/+$/, '');
  }

  const hasPort = normalizedHost.includes(':');
  const port = toNumber(process.env.PORT, 4000);
  return hasPort ? `http://${normalizedHost.replace(/\/+$/, '')}` : `http://${normalizedHost.replace(/\/+$/, '')}:${port}`;
};

const parseJsonValue = (value: string | undefined, label: string): unknown | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to parse ${label} JSON payload.`, error);
    return undefined;
  }
};

const parseWorkflowParameterBindings = (value: string | undefined): AgentWorkflowParameterBinding[] => {
  const parsed = parseJsonValue(value, 'GENERATOR_WORKFLOW_PARAMETERS');
  if (!Array.isArray(parsed)) {
    return [];
  }

  const bindings: AgentWorkflowParameterBinding[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const parameter = typeof record.parameter === 'string' ? record.parameter.trim() : '';
    const node = typeof record.node === 'number' ? record.node : Number.NaN;
    const pathValue = typeof record.path === 'string' ? record.path.trim() : '';

    if (!parameter || Number.isNaN(node) || !pathValue) {
      continue;
    }

    bindings.push({ parameter, node, path: pathValue });
  }

  return bindings;
};

const parseWorkflowOverrides = (value: string | undefined): AgentWorkflowMutation[] => {
  const parsed = parseJsonValue(value, 'GENERATOR_WORKFLOW_OVERRIDES');
  if (!Array.isArray(parsed)) {
    return [];
  }

  const overrides: AgentWorkflowMutation[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const node = typeof record.node === 'number' ? record.node : Number.NaN;
    const pathValue = typeof record.path === 'string' ? record.path.trim() : '';

    if (Number.isNaN(node) || !pathValue || !('value' in record)) {
      continue;
    }

    overrides.push({ node, path: pathValue, value: (record as { value: unknown }).value });
  }

  return overrides;
};

const defaultWorkflowParameterBindings: AgentWorkflowParameterBinding[] = [
  { parameter: 'base_model_path', node: 1, path: 'inputs.ckpt_name' },
  { parameter: 'prompt', node: 2, path: 'inputs.text_g' },
  { parameter: 'prompt', node: 2, path: 'inputs.text_l' },
  { parameter: 'negative_prompt', node: 3, path: 'inputs.text_g' },
  { parameter: 'negative_prompt', node: 3, path: 'inputs.text_l' },
  { parameter: 'width', node: 4, path: 'inputs.width' },
  { parameter: 'height', node: 4, path: 'inputs.height' },
  { parameter: 'seed', node: 5, path: 'inputs.seed' },
  { parameter: 'steps', node: 5, path: 'inputs.steps' },
  { parameter: 'cfg_scale', node: 5, path: 'inputs.cfg' },
  { parameter: 'sampler', node: 5, path: 'inputs.sampler_name' },
  { parameter: 'scheduler', node: 5, path: 'inputs.scheduler' },
];

const resolveWorkflowTemplatePath = (): string | undefined => {
  const explicitPath = process.env.GENERATOR_WORKFLOW_LOCAL_PATH;
  if (explicitPath && explicitPath.trim().length > 0) {
    return explicitPath.trim();
  }

  const candidates = [
    path.resolve(process.cwd(), 'generator-workflows/default.json'),
    path.resolve(process.cwd(), 'backend/generator-workflows/default.json'),
    path.resolve(__dirname, '../generator-workflows/default.json'),
    path.resolve(__dirname, '../../generator-workflows/default.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`Failed to inspect default workflow path "${candidate}": ${(error as Error).message}`);
    }
  }

  return undefined;
};

const resolvedWorkflowLocalPath = resolveWorkflowTemplatePath();
const exposeLocalWorkflowPath = toBoolean(process.env.GENERATOR_WORKFLOW_EXPOSE_LOCAL_PATH, false);
const parsedWorkflowParameterBindings = parseWorkflowParameterBindings(process.env.GENERATOR_WORKFLOW_PARAMETERS);
const workflowParameterBindings =
  parsedWorkflowParameterBindings.length > 0 ? parsedWorkflowParameterBindings : defaultWorkflowParameterBindings;
const workflowOverrides = parseWorkflowOverrides(process.env.GENERATOR_WORKFLOW_OVERRIDES);

const deriveMinioPublicUrl = () => {
  const explicitUrl = process.env.MINIO_PUBLIC_URL;
  if (explicitUrl && explicitUrl.trim().length > 0) {
    return explicitUrl.trim().replace(/\/$/, '');
  }

  const protocol = minioUseSSL ? 'https' : 'http';
  return `${protocol}://${minioHost}:${minioPort}`;
};

export const appConfig = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: toNumber(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
  platform: {
    siteTitle: deriveSiteTitle(),
    allowRegistration: toBoolean(process.env.ALLOW_REGISTRATION, true),
    maintenanceMode: toBoolean(process.env.MAINTENANCE_MODE, false),
    domain: toOptionalString(process.env.PUBLIC_DOMAIN),
  },
  network: {
    backendHost: toSanitizedString(process.env.HOST, '0.0.0.0'),
    frontendHost: toSanitizedString(process.env.FRONTEND_HOST, '0.0.0.0'),
    generatorNodeUrl,
  },
  auth: {
    jwtSecret: requireString(
      process.env.AUTH_JWT_SECRET,
      'AUTH_JWT_SECRET',
      'visionsuit-dev-secret-change-me',
    ),
    tokenExpiresIn: toExpiresIn(process.env.AUTH_TOKEN_EXPIRES_IN, '12h'),
  },
  storage: {
    driver: storageDriver,
    endpoint: minioHost,
    port: minioPort,
    useSSL: minioUseSSL,
    accessKey: requireString(process.env.MINIO_ACCESS_KEY, 'MINIO_ACCESS_KEY', 'visionsuit'),
    secretKey: requireString(process.env.MINIO_SECRET_KEY, 'MINIO_SECRET_KEY', 'visionsuitsecret'),
    region: process.env.MINIO_REGION?.trim() || undefined,
    bucketModels: requireString(
      process.env.MINIO_BUCKET_MODELS,
      'MINIO_BUCKET_MODELS',
      'visionsuit-models',
    ),
    bucketImages: requireString(
      process.env.MINIO_BUCKET_IMAGES,
      'MINIO_BUCKET_IMAGES',
      'visionsuit-images',
    ),
    autoCreateBuckets: toBoolean(process.env.MINIO_AUTO_CREATE_BUCKETS, true),
    publicUrl: deriveMinioPublicUrl(),
  },
  generator: {
    baseModelBucket:
      process.env.GENERATOR_BASE_MODEL_BUCKET?.trim() && process.env.GENERATOR_BASE_MODEL_BUCKET.trim().length > 0
        ? process.env.GENERATOR_BASE_MODEL_BUCKET.trim()
        : 'comfyui-models',
    baseModelManifestObject:
      process.env.GENERATOR_BASE_MODEL_MANIFEST?.trim() && process.env.GENERATOR_BASE_MODEL_MANIFEST.trim().length > 0
        ? process.env.GENERATOR_BASE_MODEL_MANIFEST.trim()
        : 'minio-model-manifest.json',
    workflow: {
      id: requireString(process.env.GENERATOR_WORKFLOW_ID, 'GENERATOR_WORKFLOW_ID', 'default'),
      version: process.env.GENERATOR_WORKFLOW_VERSION?.trim() || undefined,
      bucket: process.env.GENERATOR_WORKFLOW_BUCKET?.trim() || 'generator-workflows',
      minioKey: process.env.GENERATOR_WORKFLOW_MINIO_KEY?.trim() || 'default.json',
      localPath: resolvedWorkflowLocalPath ?? undefined,
      exposeLocalPath: exposeLocalWorkflowPath,
      inline: parseJsonValue(process.env.GENERATOR_WORKFLOW_INLINE, 'GENERATOR_WORKFLOW_INLINE'),
      parameters: workflowParameterBindings,
      overrides: workflowOverrides,
    },
    output: {
      bucket: requireString(process.env.GENERATOR_OUTPUT_BUCKET, 'GENERATOR_OUTPUT_BUCKET', 'generator-outputs'),
      prefixTemplate:
        process.env.GENERATOR_OUTPUT_PREFIX?.trim() && process.env.GENERATOR_OUTPUT_PREFIX.trim().length > 0
          ? process.env.GENERATOR_OUTPUT_PREFIX.trim()
          : 'generated/{userId}/{jobId}',
    },
    callbacks: {
      baseUrl: deriveGeneratorCallbackBaseUrl(),
    },
  },
};
