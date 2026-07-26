import {
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
import { EvidenceService } from './evidence.service';
import { EvidenceImportService } from './evidence-import.service';
import {
  CreateEvidenceDto,
  ImportEvidenceDto,
  UpdateEvidenceDto,
} from './evidence.dto';

@ApiTags('Evidence')
@Controller('evidence')
export class EvidenceController {
  constructor(
    private readonly evidenceService: EvidenceService,
    private readonly importService: EvidenceImportService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the evidence basket',
    description:
      'Filter by `project_id` and/or `transcription_id`, plus `type` (comma-separated) and free-text `search`.',
  })
  @ApiQuery({ name: 'project_id', required: false })
  @ApiQuery({ name: 'transcription_id', required: false })
  @ApiQuery({ name: 'type', required: false, description: 'comma-separated' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'term_id',
    required: false,
    description: 'فقط شواهدی که به این واژه دیکشنری وصل شده‌اند',
  })
  list(
    @Query('project_id') projectId?: string,
    @Query('transcription_id') transcriptionId?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('term_id') termId?: string,
  ) {
    return this.evidenceService.list({
      projectId: this.toInt(projectId),
      transcriptionId: this.toInt(transcriptionId),
      types: this.parseTypes(type),
      search,
      termId: this.toInt(termId),
    });
  }

  @Post('import')
  @ApiOperation({
    summary: 'بارگذاری گروهی سبد شواهد',
    description:
      'سند مارک‌داون شواهد را وارد می‌کند و هر نقل‌قول را روی خط واقعی رونویسی لنگر می‌اندازد. ' +
      'شاهدی که پیدا نشود هم ثبت می‌شود ولی با `anchored: false`. با `dry_run: true` فقط پیش‌نمایش.',
  })
  importItems(@Body() dto: ImportEvidenceDto) {
    return this.importService.import(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one evidence item' })
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.evidenceService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Add a selected passage to the evidence basket' })
  create(@Body() dto: CreateEvidenceDto) {
    return this.evidenceService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an evidence item' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEvidenceDto,
  ) {
    return this.evidenceService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove an evidence item' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.evidenceService.remove(id);
  }

  private toInt(raw?: string): number | undefined {
    if (!raw) return undefined;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  /**
   * Valid types are per-project data now, so the filter just passes the keys
   * through — an unknown key simply matches nothing.
   */
  private parseTypes(raw?: string): string[] | undefined {
    if (!raw) return undefined;
    const types = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return types.length ? types : undefined;
  }
}
