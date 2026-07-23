import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Person } from './person.entity';
import { PersonService } from './person.service';
import { PersonController } from './person.controller';
import { FileModule } from '../file/file.module';
import { AudioModule } from '../audio/audio.module';

@Module({
  imports: [TypeOrmModule.forFeature([Person]), FileModule, AudioModule],
  controllers: [PersonController],
  providers: [PersonService],
  exports: [PersonService],
})
export class PersonModule {}
