import type { AdultSafetyKeyword, Prisma, PrismaClient } from '@prisma/client';

import { prisma } from './prisma';

export type AdultKeywordRecord = AdultSafetyKeyword;

type PrismaClientOrTransaction = PrismaClient | Prisma.TransactionClient;

const resolveClient = (client?: PrismaClientOrTransaction) => client ?? prisma;

export const listAdultSafetyKeywords = async (client?: PrismaClientOrTransaction) => {
  const queryClient = resolveClient(client);
  const records = await queryClient.adultSafetyKeyword.findMany({
    orderBy: { label: 'asc' },
  });

  return records;
};

export const getAdultKeywordLabels = async (client?: PrismaClientOrTransaction) => {
  const keywords = await listAdultSafetyKeywords(client);
  return keywords.map((keyword) => keyword.label);
};
