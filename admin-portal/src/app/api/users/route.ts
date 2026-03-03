import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const authResult = await authenticate(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    // Auto-expire plans that have passed their end date
    await prisma.user.updateMany({
      where: {
        status: 'ACTIVE',
        planEndDate: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });

    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(users);
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const authResult = await authenticate(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const { phoneNumber, displayName, planType } = await request.json();

    // Check if user already exists
    const existing = await prisma.user.findUnique({ where: { phoneNumber } });
    if (existing) {
      return NextResponse.json(
        { message: 'User with this phone number already exists' },
        { status: 404 },
      );
    }

    const data: Record<string, unknown> = {
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

    const user = await prisma.user.create({ data: data as any });
    return NextResponse.json(user, { status: 201 });
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}
