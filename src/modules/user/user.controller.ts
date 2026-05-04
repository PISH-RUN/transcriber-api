import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { UserService } from './user.service';
import { userCreateDto } from './user.dto';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get(':id')
  getUser(@Param('id') id: number) {
    return this.userService.getById(id);
  }

  @Post()
  createUser(@Body() data: userCreateDto) {
    return this.userService.create(data);
  }
}
