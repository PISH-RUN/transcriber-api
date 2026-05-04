import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { userCreateDto } from './user.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async getById(id: number) {
    return await this.userRepository.findOne({
      where: { id },
    });
  }

  async getByPhoneNumber(phone: string) {
    return await this.userRepository.findOne({
      where: { phone },
    });
  }

  async findByPhoneNumberOrCreate(phone: string): Promise<User> {
    const existing = await this.getByPhoneNumber(phone);
    if (existing) {
      return existing;
    }

    const user = this.userRepository.create({ phone });
    return await this.userRepository.save(user);
  }

  async create(data: userCreateDto) {
    const { phone } = data;

    const existing = await this.getByPhoneNumber(phone);
    if (existing) {
      throw new HttpException('User exists', 400);
    }

    const user = this.userRepository.create(data);
    return await this.userRepository.save(user);
  }
}
