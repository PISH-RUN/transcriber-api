import { User } from '../../modules/user/user.entity';

export class FileDto {
  file_type?: string;
  name: string;
  size?: number;
  Document_id?: number;
  user: User | null;
}

export class FileResDto {
  id: number;
  name?: string;
  path: string;
  size?: number;
  file_type?: string;
}
