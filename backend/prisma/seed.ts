import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

const modelsBucket = process.env.MINIO_BUCKET_MODELS ?? 'visionsuit-models';
const imagesBucket = process.env.MINIO_BUCKET_IMAGES ?? 'visionsuit-images';

const toS3 = (bucket: string, objectName: string) => `s3://${bucket}/${objectName}`;

const main = async () => {
  const curator = await prisma.user.upsert({
    where: { email: 'curator@visionsuit.local' },
    update: {},
    create: {
      email: 'curator@visionsuit.local',
      displayName: 'VisionSuit Curator',
      role: UserRole.CURATOR,
      bio: 'Kuratiert hochwertige KI-Galerien und Modell-Assets.',
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
      storagePath: toS3(modelsBucket, 'demo/neosynth-cinematic-v0.1.0.safetensors'),
      previewImage: toS3(imagesBucket, 'demo/neosynth-cinematic.jpg'),
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

  const demoImagePath = toS3(imagesBucket, 'demo/neosynth-showcase.png');

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
