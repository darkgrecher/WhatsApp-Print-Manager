import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(request: NextRequest) {
  try {
    const { phoneNumber, name } = await request.json();

    const existing = await prisma.user.findUnique({
      where: { phoneNumber },
    });

    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 7);

    if (existing) {
      if (existing.status === 'ACTIVE') {
        return NextResponse.json({
          success: false,
          message: 'You already have an active plan.',
        });
      }

      await prisma.user.update({
        where: { id: existing.id },
        data: {
          status: 'ACTIVE',
          planType: 'TRIAL',
          planStartDate: now,
          planEndDate: endDate,
          displayName: name || existing.displayName,
        },
      });
      return NextResponse.json({
        success: true,
        message: 'Trial activated successfully for 7 days.',
      });
    }

    await prisma.user.create({
      data: {
        phoneNumber,
        displayName: name,
        status: 'ACTIVE',
        planType: 'TRIAL',
        planStartDate: now,
        planEndDate: endDate,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Trial activated successfully for 7 days.',
    });
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}
