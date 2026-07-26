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
import { AnalysisService } from './analysis.service';
import { CreateAnalysisDto, UpdateAnalysisDto } from './analysis.dto';

@ApiTags('Analyses')
@Controller('analyses')
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Get()
  @ApiOperation({
    summary: 'List analyses of a recording (or of a whole project)',
    description:
      'Returns metadata only — `content` is omitted and replaced by `content_length`. Fetch a single analysis to read it.',
  })
  @ApiQuery({ name: 'transcription_id', required: false })
  @ApiQuery({ name: 'project_id', required: false })
  @ApiQuery({ name: 'kind', required: false, description: 'comma-separated' })
  @ApiQuery({ name: 'search', required: false })
  list(
    @Query('transcription_id') transcriptionId?: string,
    @Query('project_id') projectId?: string,
    @Query('kind') kind?: string,
    @Query('search') search?: string,
  ) {
    return this.analysisService.list({
      transcriptionId: this.toInt(transcriptionId),
      projectId: this.toInt(projectId),
      kinds: this.parseList(kind),
      search,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one analysis, with its full content' })
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.analysisService.findById(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Attach an analysis to a recording',
    description:
      'The body is stored verbatim; `format` (markdown | text | html | json) only decides how it is rendered. JSON content is validated.',
  })
  create(@Body() dto: CreateAnalysisDto) {
    return this.analysisService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an analysis' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAnalysisDto,
  ) {
    return this.analysisService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an analysis' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.analysisService.remove(id);
  }

  private toInt(raw?: string): number | undefined {
    if (!raw) return undefined;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private parseList(raw?: string): string[] | undefined {
    if (!raw) return undefined;
    const values = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return values.length ? values : undefined;
  }
}
