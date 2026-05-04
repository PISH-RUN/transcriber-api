import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileService } from './file.service';
import { Response } from 'express'; // ✅ Correct
import { Readable } from 'stream';
import { AuthGuard } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { User } from '../user/user.entity';
import { Public } from '../../common/decorators/public.decorator';
import { ApiBearerAuth, ApiBody } from '@nestjs/swagger';
const toUtf8 = (s: string) => Buffer.from(s, 'latin1').toString('utf8');

@Controller('files')
export class FileController {
  constructor(private readonly fileUploaderService: FileService) {}

  @Post()
  @ApiBearerAuth('access-token') // Add this to swagger use authorization for this route or any route.
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
        Document_id: {
          type: 'number',
          example: 123,
          nullable: true,
        },
      },
    },
  })
  //This is how you add to swagger without adding dto.
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Auth() user: User,
  ) {
    // Validate file upload
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const originalNameUtf8 = toUtf8(file.originalname);

    // Merge body and query metadata, with query taking precedence
    const metadata = {
      file_type: file.mimetype,
      name: originalNameUtf8,
      size: file.size,
      user: user,
    };

    try {
      const uploadedFile = await this.fileUploaderService.uploadFile(
        file,
        metadata,
      );
      return {
        message: 'File uploaded successfully',
        id: uploadedFile.id,
        metadata: metadata,
      };
    } catch (error) {
      throw new BadRequestException(error.message || 'File upload failed');
    }
  }

  @Get('*path')
  @Public()
  async getFile(@Param('path') path: string, @Res() res: Response) {
    const normalizedPath = path.replace(/,/g, '/');
    try {
      const file = await this.fileUploaderService.getFile(normalizedPath);

      if (!file.Body) throw new NotFoundException('File stream is missing');

      res.setHeader(
        'Content-Type',
        file.ContentType || 'application/octet-stream',
      );
      if (file.ContentLength) {
        res.setHeader('Content-Length', file.ContentLength.toString());
      }
      const filename = normalizedPath.split('/').pop() || 'file';
      const encodedFilename = encodeURIComponent(filename);

      res.setHeader(
        'Content-Disposition',
        `inline; filename="${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}"; filename*=UTF-8''${encodedFilename}`,
      );

      const stream = file.Body as Readable;
      stream.pipe(res);
    } catch (err) {
      console.error('S3 getFile error:', err);
      throw new NotFoundException('File not found');
    }
  }
}
