import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';
import { User } from '../user/user.entity';

@Entity('files')
export class FileEntity extends BaseTimestampEntity {
  @Column({ length: 255, nullable: false })
  name: string;

  @Column()
  file_type: string;

  @Column({ length: 255, nullable: true })
  path: string;

  @Column({ length: 255, nullable: true })
  original_name: string;

  @Column({ type: 'bigint', nullable: false })
  size: number;

  @ManyToOne(() => User, (user) => user.files, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;
}
