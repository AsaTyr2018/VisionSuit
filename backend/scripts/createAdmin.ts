import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

import '../src/config';

interface CliOptions {
  email?: string;
  password?: string;
  name?: string;
  bio?: string;
}

const parseArgs = (): CliOptions => {
  const args = process.argv.slice(2);
  const options: CliOptions = {};

  for (const arg of args) {
    const [key, ...rest] = arg.split('=');
    const value = rest.join('=');

    if (!key.startsWith('--')) {
      continue;
    }

    const normalizedKey = key.slice(2);

    switch (normalizedKey) {
      case 'email':
        options.email = value || undefined;
        break;
      case 'password':
        options.password = value || undefined;
        break;
      case 'name':
      case 'displayName':
        options.name = value || undefined;
        break;
      case 'bio':
        options.bio = value || undefined;
        break;
      default:
        break;
    }
  }

  return options;
};

const prisma = new PrismaClient();

const run = async () => {
  const options = parseArgs();

  if (!options.email) {
    throw new Error('Missing required --email argument');
  }

  if (!options.password) {
    throw new Error('Missing required --password argument');
  }

  const displayName = options.name?.trim();
  if (!displayName) {
    throw new Error('Missing required --name argument');
  }

  const email = options.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(options.password, 12);

  const result = await prisma.user.upsert({
    where: { email },
    update: {
      displayName,
      passwordHash,
      role: UserRole.ADMIN,
      bio: options.bio ?? undefined,
      isActive: true,
    },
    create: {
      email,
      displayName,
      passwordHash,
      role: UserRole.ADMIN,
      bio: options.bio ?? undefined,
      isActive: true,
    },
  });

  // eslint-disable-next-line no-console
  console.log('Admin account ready:', {
    id: result.id,
    email: result.email,
    displayName: result.displayName,
    role: result.role,
  });
};

run()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[create-admin] Failed to provision admin:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
