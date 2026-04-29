import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LicenseService {
  constructor(private prisma: PrismaService) {}

  async checkLicense(phoneNumber: string) {
    const user = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (!user) {
      return { status: 'not_found', planType: null, expiresAt: null };
    }

    // Auto-expire plans that have passed their end date
    if (
      user.status === 'ACTIVE' &&
      user.planEndDate &&
      new Date() > user.planEndDate
    ) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { status: 'EXPIRED' },
      });
      return {
        status: 'expired',
        planType: user.planType,
        expiresAt: user.planEndDate,
      };
    }

    return {
      status: user.status.toLowerCase(),
      planType: user.planType,
      planStartDate: user.planStartDate,
      expiresAt: user.planEndDate,
    };
  }

  async requestTrial(phoneNumber: string, displayName?: string) {
    const existing = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });

    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 7);

    if (existing) {
      if (existing.status === 'ACTIVE') {
        return {
          success: false,
          message: 'You already have an active plan.',
        };
      }

      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          status: 'ACTIVE',
          planType: 'TRIAL',
          planStartDate: now,
          planEndDate: endDate,
          displayName: displayName || existing.displayName,
        },
      });
      return {
        success: true,
        message: 'Trial activated successfully for 7 days.',
      };
    }

    await this.prisma.user.create({
      data: {
        phoneNumber,
        displayName,
        status: 'ACTIVE',
        planType: 'TRIAL',
        planStartDate: now,
        planEndDate: endDate,
      },
    });

    return { success: true, message: 'Trial activated successfully for 7 days.' };
  }
}
