import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const authResult = await authenticate(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const id = parseInt(params.id, 10);
    const { planType } = await request.json();

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return NextResponse.json({ message: 'User not found' }, { status: 404 });
    }

    const now = new Date();
    const endDate = new Date(now);

    if (planType === 'TRIAL') {
      endDate.setDate(endDate.getDate() + 7);
    } else {
      endDate.setFullYear(endDate.getFullYear() + 1);
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        planType,
        planStartDate: now,
        planEndDate: endDate,
      },
    });

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}
