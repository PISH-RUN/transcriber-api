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
import { GlossaryService } from './glossary.service';
import {
  CreateGlossaryTermDto,
  GlossaryMentionInputDto,
  UpdateGlossaryTermDto,
} from './glossary.dto';

@ApiTags('Glossary')
@Controller('glossary')
export class GlossaryController {
  constructor(private readonly glossaryService: GlossaryService) {}

  @Get()
  @ApiOperation({
    summary: "List a project's glossary",
    description:
      'The dictionary is per project. Optional `search` (term, aliases, tags, description) and `category`.',
  })
  @ApiQuery({ name: 'project_id', required: true })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'کلید دسته‌بندی از تاکسونومی همان پروژه',
  })
  listTerms(
    @Query('project_id') projectId?: string,
    @Query('search') search?: string,
    @Query('category') category?: string,
  ) {
    const id = parseInt(projectId ?? '', 10);
    if (Number.isNaN(id)) {
      throw new BadRequestException('project_id لازم است');
    }
    return this.glossaryService.listTerms({ projectId: id, search, category });
  }

  @Get('mentions')
  @ApiOperation({
    summary: 'List glossary mentions inside one transcription',
    description: 'Used by the review page to mark up tagged words in the text.',
  })
  @ApiQuery({ name: 'transcription_id', required: true })
  listTranscriptionMentions(
    @Query('transcription_id') transcriptionId?: string,
  ) {
    const id = parseInt(transcriptionId ?? '', 10);
    if (Number.isNaN(id)) {
      throw new BadRequestException('transcription_id لازم است');
    }
    return this.glossaryService.listTranscriptionMentions(id);
  }

  @Delete('mentions/:id')
  @ApiOperation({ summary: 'Remove a single mention' })
  removeMention(@Param('id', ParseIntPipe) id: number) {
    return this.glossaryService.removeMention(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one term' })
  findTerm(@Param('id', ParseIntPipe) id: number) {
    return this.glossaryService.findTerm(id);
  }

  @Get(':id/mentions')
  @ApiOperation({
    summary: 'Where this term appears across the project’s recordings',
  })
  listTermMentions(@Param('id', ParseIntPipe) id: number) {
    return this.glossaryService.listTermMentions(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Add a term to a project glossary',
    description:
      'Reuses an existing term with the same name instead of duplicating it; a `mention` payload records where the selection came from.',
  })
  createTerm(@Body() dto: CreateGlossaryTermDto) {
    return this.glossaryService.createTerm(dto);
  }

  @Post(':id/mentions')
  @ApiOperation({ summary: 'Link another selection to an existing term' })
  addMention(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: GlossaryMentionInputDto,
  ) {
    return this.glossaryService.addMention(id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a term' })
  updateTerm(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGlossaryTermDto,
  ) {
    return this.glossaryService.updateTerm(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a term',
    description: 'Its mentions are removed with it.',
  })
  removeTerm(@Param('id', ParseIntPipe) id: number) {
    return this.glossaryService.removeTerm(id);
  }
}
