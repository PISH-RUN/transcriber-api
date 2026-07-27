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
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TranscriptionStatus } from './transcription.entity';
import { TranscriptionService } from './transcription.service';
import {
  ConfirmSpeakersDto,
  UpdateTranscriptionDto,
} from './transcription.dto';

const toUtf8 = (s: string) => Buffer.from(s, 'latin1').toString('utf8');

@ApiTags('Transcriptions')
@Controller('transcriptions')
export class TranscriptionController {
  constructor(private readonly transcriptionService: TranscriptionService) {}

  @Get()
  @ApiOperation({
    summary: 'List transcriptions, optionally filtered',
    description:
      'Filters: `search` (title, description, tags, project name), `project_id` (a number, or "none" for unfiled), `status` (comma-separated), `from`/`to` (YYYY-MM-DD over the session date, falling back to the upload date).',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'project_id', required: false, description: 'id یا none' })
  @ApiQuery({ name: 'status', required: false, description: 'comma-separated' })
  @ApiQuery({ name: 'from', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-12-29' })
  list(
    @Query('search') search?: string,
    @Query('project_id') projectId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.transcriptionService.list({
      search,
      projectId: this.parseProjectFilter(projectId),
      status: this.parseStatuses(status),
      from: from || undefined,
      to: to || undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get full transcription detail' })
  getDetail(@Param('id', ParseIntPipe) id: number) {
    return this.transcriptionService.getDetail(id);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Lightweight status for polling' })
  getStatus(@Param('id', ParseIntPipe) id: number) {
    return this.transcriptionService.getStatus(id);
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Create a transcription from one or more audio files',
    description:
      'Upload audio files (field "files"). Optionally pass "title" and "expected_person_ids" (JSON array or comma-separated) of people expected to be present, whose voiceprints drive auto speaker identification.',
  })
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: diskStorage({
        destination: (req, file, cb) => {
          const uploadPath = path.join(process.cwd(), 'temp', 'uploads');
          if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
          }
          cb(null, uploadPath);
        },
        filename: (req, file, cb) => {
          const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, `audio-${unique}${path.extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 1024 * 1024 * 500 }, // 500MB per file
      fileFilter: (req, file, cb) => {
        if (
          file.mimetype.startsWith('audio/') ||
          file.mimetype.startsWith('video/')
        ) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Only audio files are allowed'), false);
        }
      },
    }),
  )
  async create(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('title') title?: string,
    @Body('expected_person_ids') expectedPersonIdsRaw?: string,
    @Body('description') description?: string,
    @Body('recorded_at') recordedAt?: string,
    @Body('tags') tagsRaw?: string,
    @Body('project_id') projectIdRaw?: string,
    @Body('project_name') projectName?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('حداقل یک فایل صوتی لازم است');
    }

    const expectedPersonIds = this.parsePersonIds(expectedPersonIdsRaw);
    const resolvedTitle =
      title?.trim() ||
      toUtf8(files[0].originalname).replace(/\.[^.]+$/, '') ||
      `رونویسی ${new Date().toLocaleString('fa-IR')}`;

    const projectId = projectIdRaw ? parseInt(projectIdRaw, 10) : null;

    return this.transcriptionService.create({
      title: resolvedTitle,
      expectedPersonIds,
      description,
      recordedAt: recordedAt || null,
      tags: this.parseTags(tagsRaw),
      projectId: Number.isNaN(projectId as number) ? null : projectId,
      projectName: projectName || null,
      files: files.map((f) => ({
        path: f.path,
        originalname: toUtf8(f.originalname),
      })),
    });
  }

  @Post(':id/confirm-speakers')
  @ApiOperation({
    summary: 'Confirm speaker → person assignments',
    description:
      'Saves the mapping, creates voiceprints for newly-assigned persons, and produces the final named transcript.',
  })
  confirmSpeakers(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmSpeakersDto,
  ) {
    return this.transcriptionService.confirmSpeakers(id, dto.assignments);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a transcription (title and/or edited segments)',
    description:
      'Edit the transcription title, a segment’s text, or reassign a segment to a different speaker. When segments are provided the whole segments array is replaced and the derived transcript text is rebuilt.',
  })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTranscriptionDto,
  ) {
    return this.transcriptionService.update(id, dto);
  }

  @Post(':id/retry')
  @ApiOperation({
    summary: 'Run the processing pipeline again for a failed recording',
    description:
      'Re-downloads the original uploads from storage and re-enters the pipeline from the start. Allowed for failed recordings, and for runs that have been silent long enough to be presumed dead. Returns immediately — poll GET /transcriptions/:id/status.',
  })
  retry(@Param('id', ParseIntPipe) id: number) {
    return this.transcriptionService.retryProcessing(id);
  }

  @Post(':id/remerge')
  @ApiOperation({
    summary: 'Rebuild the transcript from the stored STT tokens + diarization',
    description:
      'Re-runs the merger over the raw Soniox tokens and Pyannote segments kept on the row. Use it to apply merger improvements to an already-processed transcription. Replaces `segments` — manual text edits are lost.',
  })
  remerge(@Param('id', ParseIntPipe) id: number) {
    return this.transcriptionService.remergeSegments(id);
  }

  @Post(':id/ai-refine')
  @ApiOperation({
    summary: 'Proof-read the transcript with Gemini 2.5 Flash',
    description:
      'Starts a background pass that fixes speech-to-text errors only: wording, Quranic/Arabic phrases and proper nouns are corrected, while tone, repetitions, unfinished sentences and the order of turns are left untouched. Returns immediately — poll GET /transcriptions/:id/status for refine_status / refine_message.',
  })
  aiRefine(@Param('id', ParseIntPipe) id: number) {
    return this.transcriptionService.startAiRefine(id);
  }

  @Post(':id/ai-refine/revert')
  @ApiOperation({
    summary: 'Restore the transcript from before the AI proof-reading pass',
  })
  revertAiRefine(@Param('id', ParseIntPipe) id: number) {
    return this.transcriptionService.revertAiRefine(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a transcription' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.transcriptionService.remove(id);
  }

  /** Multipart values arrive as strings: accept a JSON array or a comma list. */
  private parseTags(raw?: string): string[] {
    if (!raw) return [];
    const trimmed = raw.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      // Not JSON — fall back to comma-separated.
    }
    return trimmed.split(',').map((s) => s.trim());
  }

  private parseProjectFilter(raw?: string): number | 'none' | undefined {
    if (!raw) return undefined;
    if (raw === 'none') return 'none';
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private parseStatuses(raw?: string): TranscriptionStatus[] | undefined {
    if (!raw) return undefined;
    const allowed = Object.values(TranscriptionStatus) as string[];
    const statuses = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => allowed.includes(s)) as TranscriptionStatus[];
    return statuses.length ? statuses : undefined;
  }

  private parsePersonIds(raw?: string): number[] {
    if (!raw) return [];
    const trimmed = raw.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => parseInt(String(v), 10))
          .filter((n) => !Number.isNaN(n));
      }
    } catch {
      // Not JSON — fall back to comma-separated.
    }
    return trimmed
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
  }
}
