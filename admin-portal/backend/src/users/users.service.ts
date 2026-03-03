import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    // Auto-expire plans that have passed their end date
    await this.prisma.user.updateMany({
      where: {
        status: 'ACTIVE',
        planEndDate: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });

    return this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findPending() {
    return this.prisma.user.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findActive() {
    // Auto-expire
    await this.prisma.user.updateMany({
      where: {
        status: 'ACTIVE',
        planEndDate: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });

    return this.prisma.user.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async activatePlan(id: number, planType: 'TRIAL' | 'ANNUAL') {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    const endDate = new Date(now);

    if (planType === 'TRIAL') {
      endDate.setDate(endDate.getDate() + 7); // 7-day trial
    } else {
      endDate.setFullYear(endDate.getFullYear() + 1); // 1-year annual plan
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        planType,
        planStartDate: now,
        planEndDate: endDate,
      },
    });
  }

  async deactivate(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.user.update({
      where: { id },
      data: { status: 'EXPIRED' },
    });
  }

  async reject(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.user.update({
      where: { id },
      data: { status: 'REJECTED' },
    });
  }

  async remove(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.user.delete({ where: { id } });
  }

  async create(phoneNumber: string, displayName?: string, planType?: 'TRIAL' | 'ANNUAL') {
    // Check if user already exists
    const existing = await this.prisma.user.findUnique({ where: { phoneNumber } });
    if (existing) {
      throw new NotFoundException('User with this phone number already exists');
    }

    const data: any = {
      phoneNumber,
      displayName: displayName || null,
      status: 'PENDING',
    };

    // If a plan type is provided, activate immediately
    if (planType) {
      const now = new Date();
      const endDate = new Date(now);
      if (planType === 'TRIAL') {
        endDate.setDate(endDate.getDate() + 7);
      } else {
        endDate.setFullYear(endDate.getFullYear() + 1);
      }
      data.status = 'ACTIVE';
      data.planType = planType;
      data.planStartDate = now;
      data.planEndDate = endDate;
    }

    return this.prisma.user.create({ data });
  }

  async changePlan(id: number, planType: 'TRIAL' | 'ANNUAL') {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    const endDate = new Date(now);

    if (planType === 'TRIAL') {
      endDate.setDate(endDate.getDate() + 7);
    } else {
      endDate.setFullYear(endDate.getFullYear() + 1);
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        planType,
        planStartDate: now,
        planEndDate: endDate,
      },
    });
  }
}
