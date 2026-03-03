import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get('pending')
  findPending() {
    return this.usersService.findPending();
  }

  @Get('active')
  findActive() {
    return this.usersService.findActive();
  }

  @Post()
  create(
    @Body() body: { phoneNumber: string; displayName?: string; planType?: 'TRIAL' | 'ANNUAL' },
  ) {
    return this.usersService.create(body.phoneNumber, body.displayName, body.planType);
  }

  @Patch(':id/activate')
  activate(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { planType: 'TRIAL' | 'ANNUAL' },
  ) {
    return this.usersService.activatePlan(id, body.planType);
  }

  @Patch(':id/change-plan')
  changePlan(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { planType: 'TRIAL' | 'ANNUAL' },
  ) {
    return this.usersService.changePlan(id, body.planType);
  }

  @Patch(':id/deactivate')
  deactivate(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.deactivate(id);
  }

  @Patch(':id/reject')
  reject(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.reject(id);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.remove(id);
  }
}
