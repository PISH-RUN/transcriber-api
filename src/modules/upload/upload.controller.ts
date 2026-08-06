import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import * as path from 'path';
import { InitUploadDto } from './upload.dto';
import { MAX_CHUNK_BYTES, UploadService } from './upload.service';

/**
 * Resumable upload of one large file, in chunks.
 *
 * The flow is: `POST /uploads` to open a session, then one request per chunk,
 * then `POST /uploads/:id/complete`, then hand the id to
 * `POST /transcriptions` as `upload_ids`. `GET /uploads/:id` at any point says
 * which chunks already arrived, which is what lets a broken upload continue
 * instead of starting over.
 */
@ApiTags('Uploads')
@Controller('uploads')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post()
  @ApiOperation({
    summary: 'شروع یک آپلود تکه‌تکه',
    description:
      'شناسه‌ای برمی‌گرداند که تکه‌ها با آن فرستاده می‌شوند. شناسه را نگه دارید: با آن می‌توان آپلود نیمه‌کاره را ادامه داد.',
  })
  init(@Body() dto: InitUploadDto) {
    return this.uploadService.init(dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'وضعیت آپلود؛ کدام تکه‌ها رسیده‌اند',
    description:
      'تکه‌های ناقص (که وسط ارسال قطع شده‌اند) رسیده به حساب نمی‌آیند و دوباره فرستاده می‌شوند.',
  })
  status(@Param('id') id: string) {
    return this.uploadService.status(id);
  }

  @Post(':id/chunks/:index')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'ارسال یک تکه',
    description:
      'فیلد `chunk`. ارسال دوباره یک تکه بی‌خطر است و روی نسخه قبلی نوشته می‌شود.',
  })
  @UseInterceptors(
    FileInterceptor('chunk', {
      // Written straight to its final name, so nothing is held in memory and a
      // retried chunk overwrites the earlier attempt.
      storage: diskStorage({
        destination: (req, file, cb) => {
          try {
            const target = (req as unknown as { chunkTarget?: string })
              .chunkTarget;
            cb(null, path.dirname(target!));
          } catch (error) {
            cb(error as Error, '');
          }
        },
        filename: (req, file, cb) => {
          const target = (req as unknown as { chunkTarget?: string })
            .chunkTarget;
          cb(null, path.basename(target!));
        },
      }),
      limits: { fileSize: MAX_CHUNK_BYTES + 1024 },
    }),
  )
  chunk(
    @Param('id') id: string,
    @Param('index') index: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('تکه‌ای ارسال نشد');
    return this.uploadService.chunkReceived(id);
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: 'کامل کردن آپلود؛ تکه‌ها به یک فایل تبدیل می‌شوند',
    description:
      'حجم فایل بازسازی‌شده با حجم اعلام‌شده مقایسه می‌شود تا یک فایل ناقص، کامل به‌نظر نرسد.',
  })
  complete(@Param('id') id: string) {
    return this.uploadService.complete(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'دور انداختن یک آپلود نیمه‌کاره' })
  discard(@Param('id') id: string) {
    return this.uploadService.discard(id);
  }
}
