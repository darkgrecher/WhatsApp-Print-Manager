import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(request: NextRequest) {
  try {
    const { phoneNumber } = await request.json();

    const user = await prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (!user) {
      return NextResponse.json({
        status: 'not_found',
        planType: null,
        expiresAt: null,
      });
    }

    // Auto-expire plans that have passed their end date
    if (
      user.status === 'ACTIVE' &&
      user.planEndDate &&
      new Date() > user.planEndDate
    ) {
      await prisma.user.update({
        where: { id: user.id },
        data: { status: 'EXPIRED' },
      });
      return NextResponse.json({
        status: 'expired',
        planType: user.planType,
        expiresAt: user.planEndDate,
      });
    }

    return NextResponse.json({
      status: user.status.toLowerCase(),
      planType: user.planType,
      planStartDate: user.planStartDate,
      expiresAt: user.planEndDate,
    });
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}
