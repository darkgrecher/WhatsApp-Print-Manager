import { Controller, Get, Put, Param, Body, UseGuards } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('settings')
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  // Public — Electron app can read settings without auth
  @Get()
  getAll() {
    return this.settingsService.getAll();
  }

  // Public — Electron app reads a single setting by key
  @Get(':key')
  getOne(@Param('key') key: string) {
    return this.settingsService.get(key);
  }

  // Protected — only admin can update settings
  @Put()
  @UseGuards(JwtAuthGuard)
  update(@Body() body: { key: string; value: string }) {
    return this.settingsService.set(body.key, body.value);
  }
}
