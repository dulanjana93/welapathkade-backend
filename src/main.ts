import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { isSwaggerEnabled, resolveCorsOrigins } from './config/runtime-safety';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Run OnModuleDestroy hooks on SIGTERM/SIGINT: stops the expiry sweeper and
  // closes Prisma, Redis and pending notification deliveries cleanly.
  app.enableShutdownHooks();

  // Browser admin/web clients. Origins are comma-separated via CORS_ORIGINS.
  // Localhost defaults apply only in development/test; elsewhere CORS_ORIGINS
  // must be set explicitly (no wildcards, no localhost) or startup fails.
  const nodeEnv = app.get(ConfigService).get<string>('app.nodeEnv');
  const corsOrigins = resolveCorsOrigins(process.env.CORS_ORIGINS, nodeEnv);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // API docs expose every route and DTO: development/test only.
  if (isSwaggerEnabled(nodeEnv)) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Welapathkade API')
      .setDescription('Welapathkade astrology consultation marketplace API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);

  await app.listen(port);
}

void bootstrap();
