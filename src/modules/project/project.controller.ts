import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProjectService } from './project.service';
import { CreateProjectDto, UpdateProjectDto } from './project.dto';

@ApiTags('Projects')
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Get()
  @ApiOperation({
    summary: 'List projects with the number of transcriptions in each',
  })
  findAll() {
    return this.projectService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a project by id' })
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.projectService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a project' })
  create(@Body() data: CreateProjectDto) {
    return this.projectService.create(data);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a project' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateProjectDto,
  ) {
    return this.projectService.update(id, data);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a project',
    description:
      'Transcriptions filed under it are kept and simply become unfiled.',
  })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.projectService.remove(id);
  }
}
