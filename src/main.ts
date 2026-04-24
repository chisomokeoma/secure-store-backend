import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Set global prefix
  app.setGlobalPrefix('store/v1');

  // Apply Global Validation for DTOs
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Apply standardized responses
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Apply centralized error handling
  app.useGlobalFilters(new GlobalExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle('Secure Store API')
    .setDescription('API documentation for Secure Store backend')
    .setVersion('1.0')
    .addBearerAuth() // 👈 for JWT auth later
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document); // 👈 swagger UI route

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
