import { Controller, Post, Body } from '@nestjs/common';
import { LicenseService } from './license.service';

@Controller('license')
export class LicenseController {
  constructor(private licenseService: LicenseService) {}

  @Post('check')
  async checkLicense(@Body() body: { phoneNumber: string }) {
    return this.licenseService.checkLicense(body.phoneNumber);
  }

  @Post('request-trial')
  async requestTrial(
    @Body() body: { phoneNumber: string; name?: string },
  ) {
    return this.licenseService.requestTrial(body.phoneNumber, body.name);
  }
}
