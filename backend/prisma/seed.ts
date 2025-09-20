import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const modelsBucket = process.env.MINIO_BUCKET_MODELS ?? 'visionsuit-models';
const imagesBucket = process.env.MINIO_BUCKET_IMAGES ?? 'visionsuit-images';

const toS3 = (bucket: string, objectName: string) => `s3://${bucket}/${objectName}`;

const ensureStorageObject = async (
  id: string,
  bucket: string,
  originalName: string,
  contentType: string,
  size: number,
) => {
  await prisma.storageObject.upsert({
    where: { id },
    update: {
      bucket,
      objectName: id,
      originalName,
      contentType,
      size: BigInt(size),
    },
    create: {
      id,
      bucket,
      objectName: id,
      originalName,
      contentType,
      size: BigInt(size),
    },
  });
};

const main = async () => {
  const existingSettings = await prisma.rankingSettings.findFirst();
  if (!existingSettings) {
    await prisma.rankingSettings.create({
      data: {
        modelWeight: 3,
        galleryWeight: 2,
        imageWeight: 1,
      },
    });
  }

  const defaultTiers = [
    {
      label: 'Newcomer',
      description: 'Getting started with first uploads and curated collections.',
      minimumScore: 0,
      position: 0,
    },
    {
      label: 'Curator',
      description: 'Actively maintains a growing catalog of models and showcases.',
      minimumScore: 6,
      position: 1,
    },
    {
      label: 'Senior Curator',
      description: 'Regularly delivers polished LoRAs and collections for the community.',
      minimumScore: 18,
      position: 2,
    },
    {
      label: 'Master Curator',
      description: 'Leads large-scale curation programs with sustained contributions.',
      minimumScore: 40,
      position: 3,
    },
  ];

  await Promise.all(
    defaultTiers.map((tier) =>
      prisma.rankTier.upsert({
        where: { minimumScore: tier.minimumScore },
        update: tier,
        create: tier,
      }),
    ),
  );

  const curatorPassword = await bcrypt.hash('curator123', 12);

  const curator = await prisma.user.upsert({
    where: { email: 'curator@visionsuit.local' },
    update: { passwordHash: curatorPassword, isActive: true },
    create: {
      email: 'curator@visionsuit.local',
      displayName: 'VisionSuit Curator',
      role: UserRole.CURATOR,
      bio: 'Kuratiert hochwertige KI-Galerien und Modell-Assets.',
      passwordHash: curatorPassword,
      isActive: true,
    },
  });

  const tagLabels = [
    { label: 'sci-fi', category: 'genre' },
    { label: 'portrait', category: 'subject' },
    { label: 'cinematic', category: 'style' },
    { label: 'LoRA', category: 'model-type' },
  ];

  const tags = await Promise.all(
    tagLabels.map((tag) =>
      prisma.tag.upsert({
        where: { label: tag.label },
        update: tag,
        create: tag,
      }),
    ),
  );

  const demoModelObjectId = 'seed-model-asset-object';
  const demoModelPreviewId = 'seed-model-preview-image';
  const demoImageObjectId = 'seed-image-asset-object';

  await ensureStorageObject(
    demoModelObjectId,
    modelsBucket,
    'neosynth-cinematic-v0.1.0.safetensors',
    'application/octet-stream',
    128_000_000,
  );

  await ensureStorageObject(
    demoModelPreviewId,
    imagesBucket,
    'neosynth-cinematic.jpg',
    'image/jpeg',
    2_048_000,
  );

  await ensureStorageObject(
    demoImageObjectId,
    imagesBucket,
    'neosynth-showcase.png',
    'image/png',
    4_520_112,
  );

  const cinematicModel = await prisma.modelAsset.upsert({
    where: { slug: 'neosynth-cinematic-lora' },
    update: {},
    create: {
      slug: 'neosynth-cinematic-lora',
      title: 'NeoSynth Cinematic LoRA',
      description: 'Ein LoRA-Modell für filmische Lichtstimmungen in Porträts.',
      version: '0.1.0',
      fileSize: 128_000_000,
      checksum: 'sha256-demo-checksum',
      storagePath: toS3(modelsBucket, demoModelObjectId),
      previewImage: toS3(imagesBucket, demoModelPreviewId),
      trigger: 'neosynth',
      metadata: {
        baseModel: 'SDXL 1.0',
        trainingImages: 120,
        triggerWords: ['neosynth', 'cinematic aura'],
      },
      ownerId: curator.id,
      tags: {
        create: tags
          .filter((tag) => ['cinematic', 'LoRA'].includes(tag.label))
          .map((tag) => ({ tagId: tag.id })),
      },
    },
  });

  const demoImagePath = toS3(imagesBucket, demoImageObjectId);

  const demoImage = await prisma.imageAsset.upsert({
    where: { storagePath: demoImagePath },
    update: {},
    create: {
      title: 'NeoSynth Showcase',
      description: 'Beispielbild, das das NeoSynth-LoRA demonstriert.',
      width: 1024,
      height: 1024,
      fileSize: 4_520_112,
      storagePath: demoImagePath,
      prompt: 'futuristic portrait of a female android, cinematic lighting, neosynth',
      negativePrompt: 'blurry, distorted, low detail',
      seed: '133742',
      model: 'SDXL 1.0',
      sampler: 'DPM++ 2M',
      cfgScale: 7.5,
      steps: 30,
      ownerId: curator.id,
      tags: {
        create: tags
          .filter((tag) => ['sci-fi', 'portrait', 'cinematic'].includes(tag.label))
          .map((tag) => ({ tagId: tag.id })),
      },
    },
  });

  await prisma.gallery.upsert({
    where: { slug: 'featured-cinematic-set' },
    update: {},
    create: {
      slug: 'featured-cinematic-set',
      title: 'Featured Cinematic Set',
      description: 'Kuratiertes Set mit filmischen Renderings und LoRA-Assets.',
      coverImage: demoImagePath,
      isPublic: true,
      ownerId: curator.id,
      entries: {
        create: [
          {
            position: 1,
            note: 'LoRA-Asset inklusive Trigger-Wörtern und Metadaten.',
            asset: {
              connect: { id: cinematicModel.id },
            },
          },
          {
            position: 2,
            note: 'Renderbeispiel mit angewendetem LoRA.',
            image: {
              connect: { id: demoImage.id },
            },
          },
        ],
      },
    },
  });

  // eslint-disable-next-line no-console
  console.log('Seed data generated successfully.');
};

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error('Seed error:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
