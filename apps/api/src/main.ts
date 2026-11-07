import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { env } from './config/env';
import { MetricsService } from './observability/metrics.service';
import { observabilityMiddleware } from './observability/observability.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Request metrics + structured access logs for every response.
  app.use(observabilityMiddleware(app.get(MetricsService)));
  // Health probes stay at the root (/health, /ready) for load balancers; the
  // Prometheus scrape at /metrics and the inbound heartbeat ping (/ping/:token)
  // also sit at the root so their URLs are short and stable.
  app.setGlobalPrefix('api', {
    exclude: [
      'health',
      'ready',
      'metrics',
      { path: 'ping/:token', method: RequestMethod.ALL },
    ],
  });
  app.enableCors({ origin: env.corsOrigin, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  // OpenAPI / Swagger — interactive API docs at /api/docs.
  const openapi = new DocumentBuilder()
    .setTitle('CronApp API')
    .setDescription(
      'Programmatic access to CronApp. Authenticate with a tenant API key: ' +
        '`Authorization: Bearer cak_…`. A key carries its own tenant and scopes, ' +
        'so the `x-tenant-id` header is only needed for interactive (JWT) sessions.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'cak_…', description: 'Tenant API key' },
      'api-key',
    )
    .build();
  const document = SwaggerModule.createDocument(app, openapi);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'CronApp API docs',
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(env.port);
  // eslint-disable-next-line no-console
  console.log(`CronApp API listening on http://localhost:${env.port}/api  ·  docs at /api/docs`);
}
bootstrap();
