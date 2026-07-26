import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from './project.entity';
import { ProjectService } from './project.service';
import { ProjectController } from './project.controller';
import { ProjectCategory } from './project-category.entity';
import { ProjectCategoryService } from './project-category.service';
import { ProjectCategoryController } from './project-category.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Project, ProjectCategory])],
  controllers: [ProjectController, ProjectCategoryController],
  providers: [ProjectService, ProjectCategoryService],
  exports: [ProjectService, ProjectCategoryService],
})
export class ProjectModule {}
