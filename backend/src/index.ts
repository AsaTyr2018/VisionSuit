import { appConfig } from './config';
import { createApp } from './app';
import { createPrismaStudioUpgradeHandler } from './devtools/prismaStudioProxy';
import { prisma } from './lib/prisma';
import { initializeStorage } from './lib/storage';
import { initializeAutoTagger } from './lib/tagging/service';
import './types/express';

const start = async () => {
  try {
    await initializeAutoTagger();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[startup] Failed to initialize auto tagger:', error);
    process.exit(1);
  }

  try {
    await initializeStorage();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[startup] Failed to initialize storage:', error);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(appConfig.port, appConfig.host, () => {
    // eslint-disable-next-line no-console
    console.log(`VisionSuit backend running at http://${appConfig.host}:${appConfig.port}`);
  });

  const handlePrismaUpgrade = createPrismaStudioUpgradeHandler();

  server.on('upgrade', (req, socket, head) => {
    void handlePrismaUpgrade(req, socket, head).then((handled) => {
      if (!handled) {
        socket.destroy();
      }
    });
  });

  const gracefulShutdown = () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
};

void start();
