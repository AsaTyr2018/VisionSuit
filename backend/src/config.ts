import { config } from 'dotenv';

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
  },
};
