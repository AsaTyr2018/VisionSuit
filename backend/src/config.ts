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

export const appConfig = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: toNumber(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
};
