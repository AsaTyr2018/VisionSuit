import type {
  Prisma,
  PrismaClient,
  SafetyKeyword,
  SafetyKeywordCategory as SafetyKeywordCategoryDb,
} from '@prisma/client';

import { prisma } from './prisma';

export const SAFETY_KEYWORD_CATEGORIES = ['adult', 'illegal'] as const;

export type SafetyKeywordCategory = (typeof SAFETY_KEYWORD_CATEGORIES)[number];

type PrismaClientOrTransaction = PrismaClient | Prisma.TransactionClient;

const resolveClient = (client?: PrismaClientOrTransaction) => client ?? prisma;

const toDbCategory = (category: SafetyKeywordCategory): SafetyKeywordCategoryDb =>
  category === 'illegal' ? 'ILLEGAL' : 'ADULT';

const fromDbCategory = (category: SafetyKeywordCategoryDb): SafetyKeywordCategory =>
  category === 'ILLEGAL' ? 'illegal' : 'adult';

export interface SafetyKeywordRecord {
  id: string;
  label: string;
  category: SafetyKeywordCategory;
  createdAt: Date;
  updatedAt: Date;
}

const mapRecord = (record: SafetyKeyword): SafetyKeywordRecord => ({
  id: record.id,
  label: record.label,
  category: fromDbCategory(record.category),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export const listSafetyKeywords = async (
  category: SafetyKeywordCategory,
  client?: PrismaClientOrTransaction,
) => {
  const queryClient = resolveClient(client);
  const records = await queryClient.safetyKeyword.findMany({
    where: { category: toDbCategory(category) },
    orderBy: { label: 'asc' },
  });

  return records.map(mapRecord);
};

export const getSafetyKeywordLabels = async (
  category: SafetyKeywordCategory,
  client?: PrismaClientOrTransaction,
) => {
  const keywords = await listSafetyKeywords(category, client);
  return keywords.map((keyword) => keyword.label);
};

export const listAdultSafetyKeywords = (client?: PrismaClientOrTransaction) =>
  listSafetyKeywords('adult', client);

export const listIllegalSafetyKeywords = (client?: PrismaClientOrTransaction) =>
  listSafetyKeywords('illegal', client);

export const getAdultKeywordLabels = (client?: PrismaClientOrTransaction) =>
  getSafetyKeywordLabels('adult', client);

export const getIllegalKeywordLabels = (client?: PrismaClientOrTransaction) =>
  getSafetyKeywordLabels('illegal', client);
