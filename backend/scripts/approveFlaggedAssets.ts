import { ModerationActionType, ModerationEntityType, ModerationStatus, PrismaClient } from '@prisma/client';

import '../src/config';

const prisma = new PrismaClient();

const BULK_APPROVAL_MESSAGE = 'Bulk approval via CLI sweep.';

type AssetTarget = {
  id: string;
  ownerId: string;
  title: string;
};

const fetchFlaggedModels = async (): Promise<AssetTarget[]> => {
  return prisma.modelAsset.findMany({
    where: {
      moderationStatus: { not: ModerationStatus.REMOVED },
      OR: [
        { moderationStatus: ModerationStatus.FLAGGED },
        { flaggedAt: { not: null } },
      ],
    },
    select: {
      id: true,
      ownerId: true,
      title: true,
    },
    orderBy: { createdAt: 'asc' },
  });
};

const fetchFlaggedImages = async (): Promise<AssetTarget[]> => {
  return prisma.imageAsset.findMany({
    where: {
      moderationStatus: { not: ModerationStatus.REMOVED },
      OR: [
        { moderationStatus: ModerationStatus.FLAGGED },
        { flaggedAt: { not: null } },
      ],
    },
    select: {
      id: true,
      ownerId: true,
      title: true,
    },
    orderBy: { createdAt: 'asc' },
  });
};

const approveModel = async (model: AssetTarget) => {
  await prisma.$transaction(async (tx) => {
    await tx.modelAsset.update({
      where: { id: model.id },
      data: {
        moderationStatus: ModerationStatus.ACTIVE,
        flaggedAt: null,
        flaggedBy: { disconnect: true },
      },
    });

    await tx.moderationLog.create({
      data: {
        entityType: ModerationEntityType.MODEL,
        entityId: model.id,
        action: ModerationActionType.APPROVED,
        targetUserId: model.ownerId,
        message: BULK_APPROVAL_MESSAGE,
      },
    });
  });
};

const approveImage = async (image: AssetTarget) => {
  await prisma.$transaction(async (tx) => {
    await tx.imageAsset.update({
      where: { id: image.id },
      data: {
        moderationStatus: ModerationStatus.ACTIVE,
        flaggedAt: null,
        flaggedBy: { disconnect: true },
      },
    });

    await tx.moderationLog.create({
      data: {
        entityType: ModerationEntityType.IMAGE,
        entityId: image.id,
        action: ModerationActionType.APPROVED,
        targetUserId: image.ownerId,
        message: BULK_APPROVAL_MESSAGE,
      },
    });
  });
};

const run = async () => {
  const [flaggedModels, flaggedImages] = await Promise.all([
    fetchFlaggedModels(),
    fetchFlaggedImages(),
  ]);

  if (flaggedModels.length === 0 && flaggedImages.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[moderation] No flagged models or images found.');
    return;
  }

  let approvedModels = 0;
  let approvedImages = 0;

  for (const model of flaggedModels) {
    try {
      await approveModel(model);
      approvedModels += 1;
      // eslint-disable-next-line no-console
      console.log(`[moderation] Approved model ${model.id} (${model.title}).`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[moderation] Failed to approve model ${model.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  for (const image of flaggedImages) {
    try {
      await approveImage(image);
      approvedImages += 1;
      // eslint-disable-next-line no-console
      console.log(`[moderation] Approved image ${image.id} (${image.title}).`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[moderation] Failed to approve image ${image.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log('[moderation] Bulk approval complete:', {
    approvedModels,
    approvedImages,
  });
};

run()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[moderation] Bulk approval failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
