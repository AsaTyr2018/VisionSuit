import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parse } from 'dotenv';

import { appConfig } from '../config';

export interface AdminSettingsGeneral {
  siteTitle: string;
  allowRegistration: boolean;
  maintenanceMode: boolean;
  bypassNsfwFilter: boolean;
}

export interface AdminSettingsConnections {
  backendHost: string;
  frontendHost: string;
  minioEndpoint: string;
  generatorNode: string;
  publicDomain: string;
}

export interface AdminSettingsSafetyMetadataThresholds {
  adult: number;
  minor: number;
  beast: number;
}

export interface AdminSettingsSafetyImageAnalysisThresholds {
  nudeSkinRatio: number;
  suggestiveSkinRatio: number;
  nudeCoverageMax: number;
  suggestiveCoverageMax: number;
  reviewMargin: number;
  torsoPresenceMin: number;
  hipPresenceMin: number;
  limbDominanceMax: number;
  offCenterTolerance: number;
}

export interface AdminSettingsSafetyImageAnalysisRuntime {
  maxWorkers: number;
  maxBatchSize: number;
  queueSoftLimit: number;
  queueHardLimit: number;
  maxRetries: number;
  backoffMs: number;
  pressureCooldownMs: number;
  fastModeMaxEdge: number;
  pressureHeuristicOnly: boolean;
}

export interface AdminSettingsSafetyImageAnalysisCnnThresholds {
  nudeDelta: number;
  swimwearMin: number;
  ambiguousDelta: number;
  reviewDelta: number;
}

export interface AdminSettingsSafetyImageAnalysisCnn {
  enabled: boolean;
  modelPath: string;
  inputSize: number;
  cropExpansion: number;
  mean: [number, number, number];
  std: [number, number, number];
  executionProviders: string[];
  warmupIterations: number;
  labels: string[];
  thresholds: AdminSettingsSafetyImageAnalysisCnnThresholds;
}

export interface AdminSettingsSafetyImageAnalysisConfig {
  maxWorkingEdge: number;
  thresholds: AdminSettingsSafetyImageAnalysisThresholds;
  runtime: AdminSettingsSafetyImageAnalysisRuntime;
  cnn: AdminSettingsSafetyImageAnalysisCnn;
}

export interface AdminSettingsSafety {
  metadataThresholds: AdminSettingsSafetyMetadataThresholds;
  imageAnalysis: AdminSettingsSafetyImageAnalysisConfig;
}

export interface AdminSettings {
  general: AdminSettingsGeneral;
  connections: AdminSettingsConnections;
  safety: AdminSettingsSafety;
}

const backendRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(backendRoot, '..');
const backendEnvPath = resolve(backendRoot, '.env');
const frontendEnvPath = resolve(repoRoot, 'frontend', '.env');
const metadataConfigPath = resolve(repoRoot, 'config', 'nsfw-metadata-filters.json');
const imageAnalysisConfigPath = resolve(repoRoot, 'config', 'nsfw-image-analysis.json');

const booleanTrueTokens = new Set(['1', 'true', 'yes', 'on']);
const booleanFalseTokens = new Set(['0', 'false', 'no', 'off']);

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (booleanTrueTokens.has(normalized)) {
    return true;
  }

  if (booleanFalseTokens.has(normalized)) {
    return false;
  }

  return fallback;
};

const readFileSafe = async (filePath: string) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }

    throw error;
  }
};

const parseEnvContent = (content: string) => {
  if (!content) {
    return {} as Record<string, string>;
  }

  try {
    return parse(content);
  } catch (error) {
    // If the file contains unparsable lines fall back to manual parsing for the known keys.
    const entries = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator === -1) {
          return null;
        }

        const key = line.slice(0, separator).trim();
        const rawValue = line.slice(separator + 1).trim();
        const value = rawValue.replace(/^"/, '').replace(/"$/, '');
        return key.length > 0 ? ([key, value] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null);

    return Object.fromEntries(entries);
  }
};

const readEnvValues = async (filePath: string) => parseEnvContent(await readFileSafe(filePath));

const toBooleanString = (value: boolean) => (value ? 'true' : 'false');

const formatEnvValue = (value: string) => {
  if (value.length === 0) {
    return '""';
  }

  if (/[^A-Za-z0-9_\.\-:@/]/.test(value)) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  return value;
};

const updateEnvFile = async (filePath: string, updates: Record<string, string>) => {
  const existingContent = await readFileSafe(filePath);
  const lines = existingContent.split(/\r?\n/);
  const updatedKeys = new Set<string>();

  const rewritten = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!key) {
      return line;
    }

    const updateValue = updates[key];
    if (updateValue === undefined) {
      return line;
    }

    updatedKeys.add(key);
    return `${key}=${formatEnvValue(updateValue)}`;
  });

  const missingEntries = Object.entries(updates).filter(([key]) => !updatedKeys.has(key));
  if (missingEntries.length > 0) {
    const trimmed = rewritten.filter((line, index, array) => {
      if (line.trim().length > 0) {
        return true;
      }

      const isLast = index === array.length - 1;
      return !isLast;
    });

    const result = [...trimmed];
    if (result.length > 0) {
      const lastLine = result[result.length - 1] ?? '';
      if (lastLine.trim().length > 0) {
        result.push('');
      }
    }

    missingEntries.forEach(([key, value], index) => {
      result.push(`${key}=${formatEnvValue(value)}`);
      if (index < missingEntries.length - 1) {
        result.push('');
      }
    });

    await fs.writeFile(filePath, `${result.join('\n')}\n`, 'utf8');
    return;
  }

  await fs.writeFile(filePath, `${rewritten.join('\n')}\n`, 'utf8');
};

const ensureDirectory = async (filePath: string) => {
  await fs.mkdir(dirname(filePath), { recursive: true });
};

const writeMetadataThresholds = async (thresholds: AdminSettingsSafetyMetadataThresholds) => {
  const payload = {
    metadataFilters: {
      adultTerms: appConfig.nsfw.metadataFilters.adultTerms,
      minorTerms: appConfig.nsfw.metadataFilters.minorTerms,
      bestialityTerms: appConfig.nsfw.metadataFilters.bestialityTerms,
      thresholds,
    },
  };

  await ensureDirectory(metadataConfigPath);
  await fs.writeFile(`${metadataConfigPath}`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const writeImageAnalysisConfig = async (config: AdminSettingsSafetyImageAnalysisConfig) => {
  const payload = {
    imageAnalysis: {
      maxWorkingEdge: config.maxWorkingEdge,
      thresholds: config.thresholds,
      runtime: config.runtime,
      cnn: config.cnn,
    },
  };

  await ensureDirectory(imageAnalysisConfigPath);
  await fs.writeFile(`${imageAnalysisConfigPath}`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const resolveAdminSettings = async (): Promise<AdminSettings> => {
  const backendEnv = await readEnvValues(backendEnvPath);
  const frontendEnv = await readEnvValues(frontendEnvPath);

  const siteTitle = backendEnv.SITE_TITLE?.trim().length
    ? backendEnv.SITE_TITLE.trim()
    : frontendEnv.VITE_SITE_TITLE?.trim().length
      ? frontendEnv.VITE_SITE_TITLE.trim()
      : appConfig.platform.siteTitle;

  const backendHost = backendEnv.HOST?.trim().length ? backendEnv.HOST.trim() : appConfig.network.backendHost;
  const minioEndpoint = backendEnv.MINIO_ENDPOINT?.trim().length
    ? backendEnv.MINIO_ENDPOINT.trim()
    : appConfig.storage.endpoint;
  const generatorNode = backendEnv.GENERATOR_NODE_URL?.trim() ?? appConfig.network.generatorNodeUrl;
  const publicDomain = backendEnv.PUBLIC_DOMAIN?.trim() ?? appConfig.platform.domain;

  const frontendHost = frontendEnv.FRONTEND_HOST?.trim().length
    ? frontendEnv.FRONTEND_HOST.trim()
    : appConfig.network.frontendHost;

  return {
    general: {
      siteTitle,
      allowRegistration: parseBoolean(backendEnv.ALLOW_REGISTRATION, appConfig.platform.allowRegistration),
      maintenanceMode: parseBoolean(backendEnv.MAINTENANCE_MODE, appConfig.platform.maintenanceMode),
      bypassNsfwFilter: parseBoolean(backendEnv.BYPASS_NSFW_FILTER, appConfig.nsfw.bypassFilter),
    },
    connections: {
      backendHost,
      frontendHost,
      minioEndpoint,
      generatorNode,
      publicDomain,
    },
    safety: {
      metadataThresholds: { ...appConfig.nsfw.metadataFilters.thresholds },
      imageAnalysis: {
        maxWorkingEdge: appConfig.nsfw.imageAnalysis.maxWorkingEdge,
        thresholds: { ...appConfig.nsfw.imageAnalysis.thresholds },
        runtime: { ...appConfig.nsfw.imageAnalysis.runtime },
        cnn: { ...appConfig.nsfw.imageAnalysis.cnn },
      },
    },
  };
};

export const getAdminSettings = async () => resolveAdminSettings();

export interface ApplyAdminSettingsResult {
  settings: AdminSettings;
  metadataThresholdsChanged: boolean;
}

const sanitizeThresholdValue = (value: number) => {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
};

export const applyAdminSettings = async (settings: AdminSettings): Promise<ApplyAdminSettingsResult> => {
  const backendUpdates: Record<string, string> = {
    SITE_TITLE: settings.general.siteTitle,
    ALLOW_REGISTRATION: toBooleanString(settings.general.allowRegistration),
    MAINTENANCE_MODE: toBooleanString(settings.general.maintenanceMode),
    BYPASS_NSFW_FILTER: toBooleanString(settings.general.bypassNsfwFilter),
    HOST: settings.connections.backendHost,
    MINIO_ENDPOINT: settings.connections.minioEndpoint,
    GENERATOR_NODE_URL: settings.connections.generatorNode,
    PUBLIC_DOMAIN: settings.connections.publicDomain,
  };

  const frontendUpdates: Record<string, string> = {
    VITE_SITE_TITLE: settings.general.siteTitle,
    FRONTEND_HOST: settings.connections.frontendHost,
    VITE_PUBLIC_DOMAIN: settings.connections.publicDomain,
  };

  await updateEnvFile(backendEnvPath, backendUpdates);
  await updateEnvFile(frontendEnvPath, frontendUpdates);

  appConfig.platform.siteTitle = settings.general.siteTitle;
  appConfig.platform.allowRegistration = settings.general.allowRegistration;
  appConfig.platform.maintenanceMode = settings.general.maintenanceMode;
  appConfig.nsfw.bypassFilter = settings.general.bypassNsfwFilter;

  const incomingThresholds = {
    adult: sanitizeThresholdValue(settings.safety.metadataThresholds.adult),
    minor: sanitizeThresholdValue(settings.safety.metadataThresholds.minor),
    beast: sanitizeThresholdValue(settings.safety.metadataThresholds.beast),
  };

  const previousThresholds = appConfig.nsfw.metadataFilters.thresholds;
  const metadataThresholdsChanged =
    incomingThresholds.adult !== previousThresholds.adult ||
    incomingThresholds.minor !== previousThresholds.minor ||
    incomingThresholds.beast !== previousThresholds.beast;

  if (metadataThresholdsChanged) {
    appConfig.nsfw.metadataFilters.thresholds = incomingThresholds;
    await writeMetadataThresholds(incomingThresholds);
  }

  const sanitizeRatio = (value: number, fallback: number, clampMax = 1) => {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(clampMax, Math.max(0, value));
  };

  const sanitizeWorkingEdge = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) {
      return appConfig.nsfw.imageAnalysis.maxWorkingEdge;
    }
    return Math.round(value);
  };

  const sanitizeRuntimeNumber = (value: number, fallback: number, minimum = 0) => {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(minimum, Math.round(value));
  };

  const sanitizeRuntimeBoolean = (value: boolean, fallback: boolean) => {
    if (typeof value === 'boolean') {
      return value;
    }
    return fallback;
  };

  const incomingImageAnalysis = settings.safety.imageAnalysis;
  if (incomingImageAnalysis) {
    const sanitizedImageConfig: AdminSettingsSafetyImageAnalysisConfig = {
      maxWorkingEdge: sanitizeWorkingEdge(incomingImageAnalysis.maxWorkingEdge),
      thresholds: {
        nudeSkinRatio: sanitizeRatio(
          incomingImageAnalysis.thresholds.nudeSkinRatio,
          appConfig.nsfw.imageAnalysis.thresholds.nudeSkinRatio,
        ),
        suggestiveSkinRatio: sanitizeRatio(
          incomingImageAnalysis.thresholds.suggestiveSkinRatio,
          appConfig.nsfw.imageAnalysis.thresholds.suggestiveSkinRatio,
        ),
        nudeCoverageMax: sanitizeRatio(
          incomingImageAnalysis.thresholds.nudeCoverageMax,
          appConfig.nsfw.imageAnalysis.thresholds.nudeCoverageMax,
        ),
        suggestiveCoverageMax: sanitizeRatio(
          incomingImageAnalysis.thresholds.suggestiveCoverageMax,
          appConfig.nsfw.imageAnalysis.thresholds.suggestiveCoverageMax,
        ),
        reviewMargin: sanitizeRatio(
          incomingImageAnalysis.thresholds.reviewMargin,
          appConfig.nsfw.imageAnalysis.thresholds.reviewMargin,
          0.25,
        ),
        torsoPresenceMin: sanitizeRatio(
          incomingImageAnalysis.thresholds.torsoPresenceMin,
          appConfig.nsfw.imageAnalysis.thresholds.torsoPresenceMin,
        ),
        hipPresenceMin: sanitizeRatio(
          incomingImageAnalysis.thresholds.hipPresenceMin,
          appConfig.nsfw.imageAnalysis.thresholds.hipPresenceMin,
        ),
        limbDominanceMax: sanitizeRatio(
          incomingImageAnalysis.thresholds.limbDominanceMax,
          appConfig.nsfw.imageAnalysis.thresholds.limbDominanceMax,
        ),
        offCenterTolerance: sanitizeRatio(
          incomingImageAnalysis.thresholds.offCenterTolerance,
          appConfig.nsfw.imageAnalysis.thresholds.offCenterTolerance,
        ),
      },
      runtime: {
        maxWorkers: sanitizeRuntimeNumber(
          incomingImageAnalysis.runtime.maxWorkers,
          appConfig.nsfw.imageAnalysis.runtime.maxWorkers,
          1,
        ),
        maxBatchSize: sanitizeRuntimeNumber(
          incomingImageAnalysis.runtime.maxBatchSize,
          appConfig.nsfw.imageAnalysis.runtime.maxBatchSize,
          1,
        ),
        queueSoftLimit: sanitizeRuntimeNumber(
          incomingImageAnalysis.runtime.queueSoftLimit,
          appConfig.nsfw.imageAnalysis.runtime.queueSoftLimit,
          1,
        ),
        queueHardLimit: sanitizeRuntimeNumber(
          incomingImageAnalysis.runtime.queueHardLimit,
          appConfig.nsfw.imageAnalysis.runtime.queueHardLimit,
          1,
        ),
        maxRetries: sanitizeRuntimeNumber(
          incomingImageAnalysis.runtime.maxRetries,
          appConfig.nsfw.imageAnalysis.runtime.maxRetries,
          0,
        ),
        backoffMs: sanitizeRuntimeNumber(
          incomingImageAnalysis.runtime.backoffMs,
          appConfig.nsfw.imageAnalysis.runtime.backoffMs,
          0,
        ),
        pressureCooldownMs: sanitizeRuntimeNumber(
          incomingImageAnalysis.runtime.pressureCooldownMs,
          appConfig.nsfw.imageAnalysis.runtime.pressureCooldownMs,
          0,
        ),
        fastModeMaxEdge: sanitizeRuntimeNumber(
          incomingImageAnalysis.runtime.fastModeMaxEdge,
          appConfig.nsfw.imageAnalysis.runtime.fastModeMaxEdge,
          1,
        ),
        pressureHeuristicOnly: sanitizeRuntimeBoolean(
          incomingImageAnalysis.runtime.pressureHeuristicOnly,
          appConfig.nsfw.imageAnalysis.runtime.pressureHeuristicOnly,
        ),
      },
      cnn: { ...appConfig.nsfw.imageAnalysis.cnn },
    };

    sanitizedImageConfig.runtime.queueHardLimit = Math.max(
      sanitizedImageConfig.runtime.queueSoftLimit,
      sanitizedImageConfig.runtime.queueHardLimit,
    );

    const previous = appConfig.nsfw.imageAnalysis;
    const configChanged =
      previous.thresholds.nudeSkinRatio !== sanitizedImageConfig.thresholds.nudeSkinRatio ||
      previous.thresholds.suggestiveSkinRatio !== sanitizedImageConfig.thresholds.suggestiveSkinRatio ||
      previous.thresholds.nudeCoverageMax !== sanitizedImageConfig.thresholds.nudeCoverageMax ||
      previous.thresholds.suggestiveCoverageMax !== sanitizedImageConfig.thresholds.suggestiveCoverageMax ||
      previous.thresholds.reviewMargin !== sanitizedImageConfig.thresholds.reviewMargin ||
      previous.thresholds.torsoPresenceMin !== sanitizedImageConfig.thresholds.torsoPresenceMin ||
      previous.thresholds.hipPresenceMin !== sanitizedImageConfig.thresholds.hipPresenceMin ||
      previous.thresholds.limbDominanceMax !== sanitizedImageConfig.thresholds.limbDominanceMax ||
      previous.thresholds.offCenterTolerance !== sanitizedImageConfig.thresholds.offCenterTolerance ||
      previous.maxWorkingEdge !== sanitizedImageConfig.maxWorkingEdge ||
      previous.runtime.maxWorkers !== sanitizedImageConfig.runtime.maxWorkers ||
      previous.runtime.maxBatchSize !== sanitizedImageConfig.runtime.maxBatchSize ||
      previous.runtime.queueSoftLimit !== sanitizedImageConfig.runtime.queueSoftLimit ||
      previous.runtime.queueHardLimit !== sanitizedImageConfig.runtime.queueHardLimit ||
      previous.runtime.maxRetries !== sanitizedImageConfig.runtime.maxRetries ||
      previous.runtime.backoffMs !== sanitizedImageConfig.runtime.backoffMs ||
      previous.runtime.pressureCooldownMs !== sanitizedImageConfig.runtime.pressureCooldownMs ||
      previous.runtime.fastModeMaxEdge !== sanitizedImageConfig.runtime.fastModeMaxEdge ||
      previous.runtime.pressureHeuristicOnly !== sanitizedImageConfig.runtime.pressureHeuristicOnly;

    if (configChanged) {
      appConfig.nsfw.imageAnalysis = {
        maxWorkingEdge: sanitizedImageConfig.maxWorkingEdge,
        thresholds: { ...sanitizedImageConfig.thresholds },
        runtime: { ...sanitizedImageConfig.runtime },
        cnn: { ...sanitizedImageConfig.cnn },
      };
      await writeImageAnalysisConfig(appConfig.nsfw.imageAnalysis);
    }
  }

  const resolved = await resolveAdminSettings();
  return { settings: resolved, metadataThresholdsChanged };
};

