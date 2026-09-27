import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { In, Repository } from 'typeorm';
import { Person } from './person.entity';
import { CreatePersonDto, UpdatePersonDto } from './person.dto';
import { FileService } from '../file/file.service';
import { PyannoteService, PyannoteVoiceprintInput } from '../audio/pyannote.service';
import { AudioProcessorService } from '../audio/audio-processor.service';

const VOICEPRINT_URL_TTL = 6 * 60 * 60; // 6h — pyannote jobs can take a while

/** A library voiceprint, ready to send to an identify job. */
export interface VoiceprintCandidate {
  personId: number;
  /** Pyannote label — the person id as a string, as everywhere else. */
  label: string;
  voiceprint: string;
  /**
   * Changes whenever the voiceprint is re-created: each creation comes from a
   * new clip, and `sample_audio_path` points at it.
   */
  version: string;
}

@Injectable()
export class PersonService {
  private readonly logger = new Logger(PersonService.name);

  constructor(
    @InjectRepository(Person)
    private readonly personRepo: Repository<Person>,
    private readonly fileService: FileService,
    private readonly pyannoteService: PyannoteService,
    private readonly audioProcessor: AudioProcessorService,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async findAll(): Promise<Person[]> {
    const persons = await this.personRepo.find({ order: { name: 'ASC' } });
    return Promise.all(persons.map((p) => this.withSampleUrl(p)));
  }

  async findById(id: number): Promise<Person> {
    const person = await this.personRepo.findOne({ where: { id } });
    if (!person) {
      throw new HttpException('شخص یافت نشد', 404);
    }
    return this.withSampleUrl(person);
  }

  async create(data: CreatePersonDto): Promise<Person> {
    const person = this.personRepo.create({
      name: data.name,
      color: data.color,
      has_voiceprint: false,
    });
    return this.personRepo.save(person);
  }

  async update(id: number, data: UpdatePersonDto): Promise<Person> {
    const person = await this.personRepo.findOne({ where: { id } });
    if (!person) {
      throw new HttpException('شخص یافت نشد', 404);
    }
    Object.assign(person, data);
    const saved = await this.personRepo.save(person);
    return this.withSampleUrl(saved);
  }

  async remove(id: number): Promise<{ success: boolean }> {
    const person = await this.personRepo.findOne({ where: { id } });
    if (!person) {
      throw new HttpException('شخص یافت نشد', 404);
    }
    await this.personRepo.remove(person);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Voiceprints
  // ---------------------------------------------------------------------------

  /**
   * Fetch pyannote voiceprint inputs for the given person ids (only those that
   * actually have a stored voiceprint). The label is the person id as a string
   * so identify results map straight back to a person.
   */
  async getVoiceprintInputs(
    personIds: number[],
  ): Promise<PyannoteVoiceprintInput[]> {
    if (!personIds || personIds.length === 0) return [];

    const rows = await this.personRepo
      .createQueryBuilder('person')
      .addSelect('person.voiceprint')
      .where('person.id IN (:...ids)', { ids: personIds })
      .andWhere('person.has_voiceprint = true')
      .getMany();

    return rows
      .filter((p) => !!p.voiceprint)
      .map((p) => ({ label: String(p.id), voiceprint: p.voiceprint as string }));
  }

  /**
   * The voiceprint library, for matching an already-processed recording's
   * speakers after the fact — at most `limit` people, because one pyannote
   * identify job takes at most 50 voiceprints.
   *
   * `preferredIds` go first, in the order given; the rest of the library
   * follows, most recently updated first. The order only decides who is left
   * out once the library outgrows the cap.
   */
  async getVoiceprintCandidates(
    preferredIds: number[],
    limit: number,
  ): Promise<VoiceprintCandidate[]> {
    // Rank on the light columns first, so only the chosen blobs are loaded.
    const library = await this.personRepo.find({
      select: { id: true, sample_audio_path: true, updated_at: true },
      where: { has_voiceprint: true },
      order: { updated_at: 'DESC' },
    });
    if (library.length === 0 || limit <= 0) return [];

    const rank = new Map<number, number>();
    preferredIds.forEach((id, index) => {
      if (!rank.has(id)) rank.set(id, index);
    });
    const unranked = Number.MAX_SAFE_INTEGER;
    const chosen = [...library]
      .sort(
        (a, b) => (rank.get(a.id) ?? unranked) - (rank.get(b.id) ?? unranked),
      )
      .slice(0, limit);

    const rows = await this.personRepo
      .createQueryBuilder('person')
      .select(['person.id'])
      .addSelect('person.voiceprint')
      .where('person.id IN (:...ids)', { ids: chosen.map((p) => p.id) })
      .getMany();
    const voiceprintById = new Map(rows.map((p) => [p.id, p.voiceprint]));

    return chosen.flatMap((p) => {
      const voiceprint = voiceprintById.get(p.id);
      if (!voiceprint) return [];
      return [
        {
          personId: p.id,
          label: String(p.id),
          voiceprint,
          version: createHash('sha1')
            .update(p.sample_audio_path ?? '')
            .digest('hex')
            .slice(0, 10),
        },
      ];
    });
  }

  async findByIds(personIds: number[]): Promise<Person[]> {
    if (!personIds || personIds.length === 0) return [];
    return this.personRepo.find({ where: { id: In(personIds) } });
  }

  /**
   * Create/replace a person's voiceprint from an audio clip already stored in
   * S3 (e.g. a detected-speaker sample). Returns the updated person.
   */
  async createVoiceprintFromS3Key(
    personId: number,
    s3Key: string,
  ): Promise<Person> {
    const person = await this.personRepo.findOne({ where: { id: personId } });
    if (!person) {
      throw new HttpException('شخص یافت نشد', 404);
    }

    if (!this.pyannoteService.isConfigured()) {
      this.logger.warn(
        `Pyannote not configured — skipping voiceprint for person ${personId}`,
      );
      return person;
    }

    const url = await this.fileService.getPresignedUrl(s3Key, VOICEPRINT_URL_TTL);
    const voiceprint = await this.pyannoteService.createVoiceprint(url);

    person.voiceprint = voiceprint;
    person.has_voiceprint = true;
    person.sample_audio_path = s3Key;
    await this.personRepo.save(person);
    this.logger.log(`Stored voiceprint for person ${personId} (${person.name})`);
    return person;
  }

  /**
   * Create a voiceprint from a freshly uploaded local audio file. The clip is
   * trimmed to <=30s (pyannote requirement) and stored in S3.
   */
  async createVoiceprintFromLocalFile(
    personId: number,
    localPath: string,
  ): Promise<Person> {
    const clipPath = await this.audioProcessor.extractClip(
      localPath,
      0,
      30,
      `person_${personId}_sample`,
    );
    try {
      const s3Key = await this.fileService.uploadToS3Only(clipPath, 'audio/mpeg');
      return await this.createVoiceprintFromS3Key(personId, s3Key);
    } finally {
      this.audioProcessor.safeUnlink(clipPath);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async withSampleUrl(person: Person): Promise<Person> {
    if (person.sample_audio_path) {
      try {
        (person as any).sample_audio_url = await this.fileService.getPresignedUrl(
          person.sample_audio_path,
          VOICEPRINT_URL_TTL,
        );
      } catch {
        (person as any).sample_audio_url = null;
      }
    }
    return person;
  }
}
