import { appConfig } from './config';
import { createApp } from './app';
import { prisma } from './lib/prisma';

const app = createApp();

const server = app.listen(appConfig.port, appConfig.host, () => {
  // eslint-disable-next-line no-console
  console.log(`VisionSuit backend running at http://${appConfig.host}:${appConfig.port}`);
});

const gracefulShutdown = () => {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
