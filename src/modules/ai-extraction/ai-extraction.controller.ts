import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AiExtractionService } from './ai-extraction.service';
import { ApplyExtractionDto, StartExtractionDto } from './ai-extraction.dto';
import { ExtractionKind } from './ai-extraction.entity';

@ApiTags('AI Extraction')
@Controller('ai-extraction')
export class AiExtractionController {
  constructor(private readonly service: AiExtractionService) {}

  @Post('glossary')
  @ApiOperation({
    summary: 'واژه‌یابی: شروع استخراج واژه‌های نامزد از متن رونویسی',
    description:
      'بلافاصله برمی‌گردد. وضعیت اجرا را با GET /ai-extraction/runs/:id دنبال کنید. ' +
      'هیچ واژه‌ای تا تأیید بازبین ثبت نمی‌شود.',
  })
  startGlossary(@Body() dto: StartExtractionDto) {
    return this.service.start(ExtractionKind.GLOSSARY, dto);
  }

  @Post('evidence')
  @ApiOperation({
    summary: 'شواهد‌یابی: شروع استخراج شواهد نامزد از متن رونویسی',
    description:
      'بلافاصله برمی‌گردد. هر نقل‌قول پیشنهادی روی متن واقعی لنگر می‌خورد و اختلاف با ' +
      'شماره خطی که مدل اعلام کرده گزارش می‌شود.',
  })
  startEvidence(@Body() dto: StartExtractionDto) {
    return this.service.start(ExtractionKind.EVIDENCE, dto);
  }

  @Get('runs')
  @ApiOperation({
    summary: 'اجراهای استخراج یک رونویسی (بدون فهرست کاندیدها)',
  })
  @ApiQuery({ name: 'transcription_id', required: true })
  @ApiQuery({ name: 'kind', required: false, enum: ['glossary', 'evidence'] })
  listRuns(
    @Query('transcription_id') transcriptionId?: string,
    @Query('kind') kind?: string,
  ) {
    const id = parseInt(transcriptionId ?? '', 10);
    if (Number.isNaN(id)) {
      throw new BadRequestException('transcription_id لازم است');
    }
    return this.service.listRuns(id, this.parseKind(kind));
  }

  @Get('runs/latest')
  @ApiOperation({
    summary: 'آخرین اجرا با کاندیدهایش، برای بازکردن دوباره ویزارد',
  })
  @ApiQuery({ name: 'transcription_id', required: true })
  @ApiQuery({ name: 'kind', required: true, enum: ['glossary', 'evidence'] })
  latestRun(
    @Query('transcription_id') transcriptionId?: string,
    @Query('kind') kind?: string,
  ) {
    const id = parseInt(transcriptionId ?? '', 10);
    if (Number.isNaN(id)) {
      throw new BadRequestException('transcription_id لازم است');
    }
    const parsed = this.parseKind(kind);
    if (!parsed) throw new BadRequestException('kind لازم است');
    return this.service.latestRun(id, parsed);
  }

  @Get('runs/:id')
  @ApiOperation({ summary: 'یک اجرا با همه کاندیدهایش' })
  findRun(@Param('id', ParseIntPipe) id: number) {
    return this.service.findRun(id);
  }

  @Post('runs/:id/apply')
  @ApiOperation({
    summary: 'اعمال تصمیم‌های بازبین روی کاندیدهای یک اجرا',
    description:
      'موارد تأییدشده ثبت می‌شوند (با اصلاحات بازبین) و موارد ردشده به حافظه رد ' +
      'می‌روند تا در اجرای بعدی دوباره پیشنهاد نشوند. برای واژه‌های تأییدشده، اسکن ' +
      'کامل متن هم اجرا می‌شود تا همه ارجاع‌هایشان ثبت شود.',
  })
  apply(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApplyExtractionDto,
  ) {
    return this.service.apply(id, dto);
  }

  private parseKind(raw?: string): ExtractionKind | undefined {
    if (raw === 'glossary') return ExtractionKind.GLOSSARY;
    if (raw === 'evidence') return ExtractionKind.EVIDENCE;
    return undefined;
  }
}
