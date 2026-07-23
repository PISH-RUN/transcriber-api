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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PersonService } from './person.service';
import { CreatePersonDto, UpdatePersonDto } from './person.dto';

@ApiTags('Persons')
@Controller('persons')
export class PersonController {
  constructor(private readonly personService: PersonService) {}

  @Get()
  @ApiOperation({ summary: 'List all persons in the voice-print library' })
  findAll() {
    return this.personService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a person by id' })
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.personService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new person' })
  create(@Body() data: CreatePersonDto) {
    return this.personService.create(data);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a person' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdatePersonDto,
  ) {
    return this.personService.update(id, data);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a person' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.personService.remove(id);
  }

  @Post(':id/voice-sample')
  @ApiOperation({
    summary: 'Upload a voice sample to (re)create this person\'s voiceprint',
    description:
      'Accepts an audio file with a single speaker. The clip is trimmed to 30s and turned into a pyannote voiceprint for future auto-identification.',
  })
  @UseInterceptors(
    FileInterceptor('audio', {
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
          cb(null, `voice-${unique}${path.extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 1024 * 1024 * 100 }, // 100MB
      fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/')) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Only audio files are allowed'), false);
        }
      },
    }),
  )
  async uploadVoiceSample(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No audio file uploaded');
    }
    try {
      return await this.personService.createVoiceprintFromLocalFile(
        id,
        file.path,
      );
    } finally {
      if (file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    }
  }
}
