import { PrismaClient } from '@prisma/client';

import { appConfig } from '../config';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: appConfig.env === 'development' ? ['query', 'info', 'warn', 'error'] : ['warn', 'error'],
  });

if (appConfig.env !== 'production') {
  globalForPrisma.prisma = prisma;
}
