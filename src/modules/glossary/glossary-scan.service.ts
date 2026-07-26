import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { GlossaryMention, GlossaryTerm } from './glossary.entity';
import { Transcription } from '../transcription/transcription.entity';
import { PersonService } from '../person/person.service';
import { buildFormMatcher } from '../../common/utils/persian-text';

/** Characters of surrounding text kept with each mention, for readability. */
const CONTEXT_BEFORE = 60;
const CONTEXT_LENGTH = 220;

const UNKNOWN_SPEAKER = 'SPEAKER_UNKNOWN';

export interface ScanTarget {
  transcriptionId: number;
  title: string;
  segments: NonNullable<Transcription['segments']>;
  /** `speaker_id` -> the confirmed person's name, when speakers are mapped. */
  speakerNames: Record<string, string>;
}

export interface ScanTermHit {
  term_id: number;
  term: string;
  mentions: number;
  /** Distinct lines the term was found in. */
  segments: number;
}

export interface ScanResult {
  transcriptions: number;
  mentions_created: number;
  mentions_skipped: number;
  per_term: ScanTermHit[];
  dry_run: boolean;
}

/**
 * Finds the project's glossary terms inside transcripts and records a mention
 * for each hit, so a bulk-imported dictionary immediately becomes traceable
 * across every recording instead of waiting to be tagged by hand.
 *
 * Two rules keep the result usable rather than overwhelming:
 *
 * 1. **One mention per term per line.** On a real interview the word "قطران"
 *    occurs 93 times across 58 turns; 58 pointers are useful, 93 are noise.
 * 2. **Idempotent.** A mention already recorded for the same term, transcript
 *    and line is left alone, so the scan can be re-run after adding terms.
 */
@Injectable()
export class GlossaryScanService {
  private readonly logger = new Logger(GlossaryScanService.name);

  constructor(
    @InjectRepository(GlossaryTerm)
    private readonly termRepo: Repository<GlossaryTerm>,
    @InjectRepository(GlossaryMention)
    private readonly mentionRepo: Repository<GlossaryMention>,
    @InjectRepository(Transcription)
    private readonly transcriptionRepo: Repository<Transcription>,
    private readonly personService: PersonService,
  ) {}

  /**
   * Scan one transcript, or every transcript of the project.
   *
   * `termIds` narrows the scan to the terms just imported; omit it to scan the
   * whole glossary.
   */
  async scan(options: {
    projectId: number;
    transcriptionId?: number | null;
    termIds?: number[];
    dryRun?: boolean;
  }): Promise<ScanResult> {
    const terms = await this.loadTerms(options.projectId, options.termIds);
    const targets = await this.loadTargets(
      options.projectId,
      options.transcriptionId,
    );

    const result: ScanResult = {
      transcriptions: targets.length,
      mentions_created: 0,
      mentions_skipped: 0,
      per_term: [],
      dry_run: !!options.dryRun,
    };

    if (terms.length === 0 || targets.length === 0) return result;

    // One regex over every wording of every term, longest first.
    const matcher = buildFormMatcher(
      terms.flatMap((term) =>
        [term.term, ...(term.aliases ?? [])].map((form) => ({
          form,
          value: term,
        })),
      ),
    );
    if (!matcher) return result;

    const stats = new Map<number, ScanTermHit>();
    terms.forEach((term) =>
      stats.set(term.id, {
        term_id: term.id,
        term: term.term,
        mentions: 0,
        segments: 0,
      }),
    );

    for (const target of targets) {
      // Existing pointers for this transcript, so a re-run adds nothing twice.
      const existing = new Set(
        (
          await this.mentionRepo.find({
            where: { transcription_id: target.transcriptionId },
            select: { term_id: true, segment_index: true },
          })
        ).map((mention) => `${mention.term_id}:${mention.segment_index}`),
      );

      const pending: GlossaryMention[] = [];

      target.segments.forEach((segment, index) => {
        if (!segment?.text?.trim() || segment.speaker_id === UNKNOWN_SPEAKER)
          return;

        const seenInSegment = new Set<number>();
        matcher.regex.lastIndex = 0;

        let match = matcher.regex.exec(segment.text);
        while (match) {
          const term = matcher.resolve(match[0]);
          if (term && !seenInSegment.has(term.id)) {
            seenInSegment.add(term.id);

            const key = `${term.id}:${index}`;
            if (existing.has(key)) {
              result.mentions_skipped += 1;
            } else {
              existing.add(key);
              const stat = stats.get(term.id);
              if (stat) {
                stat.mentions += 1;
                stat.segments += 1;
              }
              result.mentions_created += 1;

              if (!options.dryRun) {
                const from = Math.max(0, match.index - CONTEXT_BEFORE);
                pending.push(
                  this.mentionRepo.create({
                    term_id: term.id,
                    transcription_id: target.transcriptionId,
                    segment_index: index,
                    start_offset: match.index,
                    end_offset: match.index + match[0].length,
                    surface: match[0].slice(0, 512),
                    context: segment.text
                      .slice(from, from + CONTEXT_LENGTH)
                      .trim(),
                    // The mapped person's name where there is one: the raw label
                    // stays anonymous for the life of the recording, and
                    // "گوینده ۱" in a mention list tells the reviewer nothing.
                    speaker_label:
                      target.speakerNames[segment.speaker_id] ??
                      segment.speaker_label ??
                      null,
                    start_ms: segment.start_ms ?? null,
                  }),
                );
              }
            }
          }

          // Zero-length safety: never let the cursor stall.
          if (matcher.regex.lastIndex === match.index)
            matcher.regex.lastIndex += 1;
          match = matcher.regex.exec(segment.text);
        }
      });

      if (pending.length > 0) {
        await this.mentionRepo.save(pending, { chunk: 200 });
      }
    }

    result.per_term = [...stats.values()]
      .filter((stat) => stat.mentions > 0)
      .sort((a, b) => b.mentions - a.mentions);

    this.logger.log(
      `Glossary scan: ${result.mentions_created} mentions across ${targets.length} transcript(s)` +
        `${options.dryRun ? ' (dry run)' : ''}`,
    );

    return result;
  }

  private async loadTerms(
    projectId: number,
    termIds?: number[],
  ): Promise<GlossaryTerm[]> {
    const where: Record<string, unknown> = { project_id: projectId };
    if (termIds?.length) where.id = In(termIds);
    return this.termRepo.find({ where });
  }

  /**
   * The transcripts to scan. `segments` is a jsonb column, so this pulls only
   * what is needed rather than whole rows (which carry the STT token dump).
   */
  private async loadTargets(
    projectId: number,
    transcriptionId?: number | null,
  ): Promise<ScanTarget[]> {
    const query = this.transcriptionRepo
      .createQueryBuilder('t')
      .select(['t.id', 't.title', 't.segments', 't.speaker_map']);

    if (transcriptionId) query.where('t.id = :id', { id: transcriptionId });
    else query.where('t.project_id = :projectId', { projectId });

    const rows = (await query.getMany()).filter(
      (row) => Array.isArray(row.segments) && row.segments.length > 0,
    );

    // One person lookup for the whole scan, however many transcripts it covers.
    const personIds = [
      ...new Set(
        rows.flatMap((row) =>
          Object.values(row.speaker_map ?? {}).filter(
            (value): value is number => typeof value === 'number',
          ),
        ),
      ),
    ];
    const persons = await this.personService.findByIds(personIds);
    const nameById = new Map(persons.map((person) => [person.id, person.name]));

    return rows.map((row) => {
      const speakerNames: Record<string, string> = {};
      Object.entries(row.speaker_map ?? {}).forEach(([speakerId, personId]) => {
        const name = personId != null ? nameById.get(personId) : undefined;
        if (name) speakerNames[speakerId] = name;
      });

      return {
        transcriptionId: row.id,
        title: row.title,
        segments: row.segments as NonNullable<Transcription['segments']>,
        speakerNames,
      };
    });
  }
}
