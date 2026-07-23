import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DataSource } from 'typeorm';
import { AuthModule } from './modules/auth/auth.module';
import { DatabaseModule } from './libs/database/database.module';
import { LoggerMiddleware } from './libs/logger/logger.middleware';
import { ConfigModule } from './libs/config/config.module';
import { UserModule } from './modules/user/user.module';
import { FileModule } from './modules/file/file.module';
import { PersonModule } from './modules/person/person.module';
import { TranscriptionModule } from './modules/transcription/transcription.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ResponseInterceptor } from './libs/interceptors/response.interceptor';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ConfigModule,
    UserModule,
    FileModule,
    PersonModule,
    TranscriptionModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  constructor(private dataSource: DataSource) {}

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
