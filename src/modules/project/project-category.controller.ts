import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProjectCategoryService } from './project-category.service';
import { ProjectCategoryKind } from './project-category.entity';
import {
  CreateProjectCategoryDto,
  UpdateProjectCategoryDto,
} from './project-category.dto';

@ApiTags('Project categories')
@Controller('project-categories')
export class ProjectCategoryController {
  constructor(private readonly categoryService: ProjectCategoryService) {}

  @Get()
  @ApiOperation({
    summary: "A project's own glossary categories and evidence types",
    description:
      'Seeded from the built-in defaults on first read. Pass `kind` for one taxonomy, or omit it to get both as `{ glossary, evidence }`. Each entry carries `usage_count`.',
  })
  @ApiQuery({ name: 'project_id', required: true })
  @ApiQuery({ name: 'kind', required: false, enum: ProjectCategoryKind })
  list(
    @Query('project_id') projectId?: string,
    @Query('kind') kind?: ProjectCategoryKind,
  ) {
    const id = parseInt(projectId ?? '', 10);
    if (Number.isNaN(id)) throw new BadRequestException('project_id لازم است');

    if (kind) {
      if (!Object.values(ProjectCategoryKind).includes(kind)) {
        throw new BadRequestException('kind نامعتبر است');
      }
      return this.categoryService.list(id, kind);
    }
    return this.categoryService.listAll(id);
  }

  @Post()
  @ApiOperation({ summary: 'Add a category to a project taxonomy' })
  create(@Body() dto: CreateProjectCategoryDto) {
    return this.categoryService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename / recolor / reorder a category',
    description:
      'The stored key never changes, so existing terms and evidence keep pointing at it.',
  })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProjectCategoryDto,
  ) {
    return this.categoryService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove a category',
    description: 'Refused with 409 while anything still uses it.',
  })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.categoryService.remove(id);
  }
}
