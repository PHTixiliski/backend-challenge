import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

  const port = Number(Bun.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  console.log(`Application listening on port ${port}`);
}

void bootstrap();
