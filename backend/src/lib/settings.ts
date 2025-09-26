import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'dotenv';

import { appConfig } from '../config';

export interface AdminSettingsGeneral {
  siteTitle: string;
  allowRegistration: boolean;
  maintenanceMode: boolean;
}

export interface AdminSettingsConnections {
  backendHost: string;
  frontendHost: string;
  minioEndpoint: string;
  generatorNode: string;
  publicDomain: string;
}

export interface AdminSettings {
  general: AdminSettingsGeneral;
  connections: AdminSettingsConnections;
}

const backendRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(backendRoot, '..');
const backendEnvPath = resolve(backendRoot, '.env');
const frontendEnvPath = resolve(repoRoot, 'frontend', '.env');

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
    },
    connections: {
      backendHost,
      frontendHost,
      minioEndpoint,
      generatorNode,
      publicDomain,
    },
  };
};

export const getAdminSettings = async () => resolveAdminSettings();

export const applyAdminSettings = async (settings: AdminSettings) => {
  const backendUpdates: Record<string, string> = {
    SITE_TITLE: settings.general.siteTitle,
    ALLOW_REGISTRATION: toBooleanString(settings.general.allowRegistration),
    MAINTENANCE_MODE: toBooleanString(settings.general.maintenanceMode),
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

  return resolveAdminSettings();
};

