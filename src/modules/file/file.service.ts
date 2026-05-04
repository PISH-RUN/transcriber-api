import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FileEntity } from './file.entity';
import { FileDto } from './file.dto';
import * as fs from 'node:fs';
import path from 'node:path';

@Injectable()
export class FileService {
  private s3Client: S3Client;
  private bucketName: string;
  private s3PublicUrl: string;

  private s3Enabled = false;

  constructor(
    private configService: ConfigService,
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
  ) {
    const config = this.configService.get('s3');
    const region = config.region;
    const accessKey = config.access_key;
    const secretKey = config.secret_key;
    const bucketName = config.bucket_name;
    const publicUrl = config.public_url;

    // Always set public URL if available (for local file serving)
    this.s3PublicUrl = publicUrl;
    this.bucketName = bucketName;

    // Check if all required S3 configuration is available
    if (region && accessKey && secretKey && bucketName) {
      const s3Config: any = {
        region,
        credentials: {
          accessKeyId: accessKey,
          secretAccessKey: secretKey,
        },
      };

      // Add custom endpoint if provided
      const customEndpoint = config.endpoint;
      if (customEndpoint) {
        s3Config.endpoint = customEndpoint;
        s3Config.forcePathStyle = true; // Required for non-AWS S3 providers
      }

      this.s3Client = new S3Client(s3Config);
      this.s3Enabled = true;
      console.log('S3 file upload service initialized successfully');
    } else {
      console.warn(
        'S3 configuration incomplete: using public URL for file serving. ' +
          'Missing one or more of: S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET_NAME',
      );
      this.s3Enabled = false;
    }
  }

  async uploadFile(file: Express.Multer.File, data: FileDto) {
    // Validate input
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    // // Check if S3 is configured
    // if (!this.s3Enabled) {
    //   throw new BadRequestException(
    //     'File upload is disabled due to missing S3 configuration',
    //   );
    // }

    const extFromMime = file.mimetype.split('/')[1];

    const fileName = Date.now() + '.' + extFromMime;

    const path = `${data.file_type}/${fileName}`;

    //TODO: i dont know if needed for real path or not
    // something like this: /orgs/orgID/....
    // for now its just /images/filename.Png

    // Construct S3 key with metadata

    try {
      // Upload to S3
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: path,
        Body: file.buffer,
        ContentType: file.mimetype,
      });

      await this.s3Client.send(command);

      // Create file entity and save to database
      const fileEntity = this.fileRepository.create({
        name: fileName,
        path: path,
        original_name: data.name,
        size: data.size,
        file_type: data.file_type,
        user: data.user,
      });
      return await this.fileRepository.save(fileEntity);
    } catch (error) {
      console.error('S3 Upload Error:', error);
      throw new InternalServerErrorException('File upload failed');
    }
  }

  async updateFileDocument(fileId, DocumentId) {}

  async findFileById(id: number) {
    return await this.fileRepository.findOne({
      where: {
        id,
      },
      relations: ['user'],
    });
  }

  async getFile(path: string) {
    const params = {
      Bucket: this.bucketName,
      Key: path,
    };

    try {
      const command = new GetObjectCommand(params);

      return await this.s3Client.send(command);
    } catch (error) {
      throw new NotFoundException();
    }
  }

  async uploadFileFromPath(filePath: string, data: FileDto) {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new BadRequestException('Invalid file path');
    }

    try {
      // Read file from disk
      const fileBuffer = fs.readFileSync(filePath);

      // Extract filename and extension
      const fileName = path.basename(filePath);
      const ext = path.extname(fileName).replace('.', '');

      // Infer MIME type

      // Construct S3 key (folder path)
      const s3Key = `${data.file_type}/${Date.now()}_${fileName}`;

      // Upload to S3
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: ext,
      });

      await this.s3Client.send(command);

      // Get file size from filesystem
      const { size } = fs.statSync(filePath);

      // Save to DB
      const fileEntity = this.fileRepository.create({
        name: fileName,
        path: s3Key,
        original_name: data.name || fileName,
        size,
        file_type: data.file_type,
        user: data.user,
      });

      return await this.fileRepository.save(fileEntity);
    } catch (error) {
      console.error('S3 Upload Error:', error);
      throw new InternalServerErrorException('File upload from path failed');
    }
  }

  /**
   * Download file from S3 and return as Buffer
   * @param s3Path - S3 path (e.g., 'audio/file.wav')
   * @returns Buffer of the file
   */
  async downloadFileFromS3(s3Path: string): Promise<Buffer> {
    if (!this.s3Enabled) {
      throw new BadRequestException('S3 is not configured');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Path,
      });

      const response = await this.s3Client.send(command);

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      console.error('S3 Download Error:', error);
      throw new NotFoundException(`File not found in S3: ${s3Path}`);
    }
  }

  /**
   * Download file from S3 and encode to base64
   * @param s3Path - S3 path
   * @param mimeType - MIME type for data URL
   * @returns Base64 encoded data URL
   */
  async downloadAndEncodeFile(
    s3Path: string,
    mimeType: string,
  ): Promise<string> {
    const buffer = await this.downloadFileFromS3(s3Path);
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  /**
   * Get public URL for a file in S3 (for public buckets)
   * @param s3Path - S3 path (e.g., 'documents/file.pdf')
   * @returns Public URL to access the file
   */
  getPublicUrl(s3Path: string): string {
    if (!this.s3PublicUrl) {
      throw new BadRequestException(
        'S3 public URL is not configured. Set S3_PUBLIC_URL environment variable.',
      );
    }

    // Ensure the public URL doesn't end with a slash and the path doesn't start with one
    const baseUrl = this.s3PublicUrl.replace(/\/$/, '');
    const path = s3Path.replace(/^\//, '');

    return `${baseUrl}/${path}`;
  }

  /**
   * Generate a presigned URL for temporary access to a private S3 object
   * @param s3Path - S3 path (e.g., 'documents/file.pdf')
   * @param expiresIn - Expiration time in seconds (default: 3600 = 1 hour)
   * @returns Presigned URL with temporary access
   */
  async getPresignedUrl(
    s3Path: string,
    expiresIn: number = 3600,
  ): Promise<string> {
    // For mock S3 or disabled S3 (local development), use public URL
    if (!this.s3Enabled) {
      if (this.s3PublicUrl) {
        return this.getPublicUrl(s3Path);
      }
      throw new BadRequestException('S3 and public URL are not configured');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Path,
      });

      // Generate presigned URL with expiration
      const presignedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      return presignedUrl;
    } catch (error) {
      console.error('Error generating presigned URL:', error);
      // Fallback to public URL if presigned URL generation fails
      if (this.s3PublicUrl) {
        console.log('Falling back to public URL');
        return this.getPublicUrl(s3Path);
      }
      throw new InternalServerErrorException(
        'Failed to generate presigned URL',
      );
    }
  }
}
