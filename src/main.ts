import './load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // A saved entry may contain a small attachment encoded in GraphQL JSON.
  app.useBodyParser('json', { limit: '60mb' });
  app.enableCors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((value) => value.trim()) :
      (process.env.NODE_ENV === 'production' ? false : true),
  });
  return app;
}

const app = await createApp();

// Vercel runs the API as a function: it expects the request handler as the default export.
// Everywhere else (local development, other hosts), the API listens on its port.
if (!process.env.VERCEL) await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
else await app.init();

export default app.getHttpAdapter().getInstance();
